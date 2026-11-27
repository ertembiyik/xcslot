import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  closeHeadlessWorkspace,
  headlessCommand,
  headlessMarker,
  headlessProductData,
  reusableWorkspace,
  nestedHeadlessData,
} from "../adapters/headless.ts";

import { prepareSteps } from "../adapters/steps.ts";
import type { Deps } from "../context.ts";
import { loadProjectConfig, loadUserConfig } from "../lib/config.ts";
import { failure, type XcslotError } from "../lib/errors.ts";
import { configPath, headOf, logsDir, resolveRepo, slotsRoot } from "../lib/layout.ts";
import { gitList, slotCommandEnv } from "../lib/proc.ts";
import { err, ok, type Result } from "../lib/result.ts";
import { acquirePermit, acquireSlot, ensureCheckout, lockEnv } from "../slot/acquire.ts";
import { unlock } from "../slot/lock.ts";
import { prepare } from "../slot/prepare.ts";
import { sweep } from "../slot/remove.ts";
import { readState, writeState } from "../slot/state.ts";
import { syncInto, writeBack } from "../slot/sync.ts";
import { needsNoProject, rewriteArgs } from "../xcodebuild/args.ts";
import { checkProductsDestination, cloneProducts, embedDebugSymbols, mergeProducts } from "../xcodebuild/handout.ts";
import { createPathMapper, type LineMapper, pumpLines } from "../xcodebuild/output-map.ts";

export interface PassthroughOptions {
  readonly from?: string;
  /** Seconds to wait for a slot; false fails at once when none is free. */
  readonly wait?: number | false;
  readonly slots?: number;
  readonly productsTo?: string;
  readonly dsym: boolean;
}

export type Wrapped = "xcodebuild" | "run" | "mcp-build";

interface Child {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly map?: LineMapper;
  readonly logPath?: string;
  /** Where the child's stdout goes; a preparation step's goes to stderr so stdout stays the wrapped command's. */
  readonly stdoutTo: "stdout" | "stderr";
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Runs a command with its output streamed through, returning its exit code (128 + n when a signal ended it). */
async function spawnThrough(deps: Deps, child: Child): Promise<Result<number, XcslotError>> {
  let proc: Bun.Subprocess<"inherit", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...child.argv], {
      cwd: child.cwd,
      env: slotCommandEnv({ ...deps.env, ...child.env }, child.cwd),
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return err(
      failure("tool_missing", `Could not run ${child.argv[0]}: ${error instanceof Error ? error.message : error}`, {
        hint: `Check that ${child.argv[0]} is installed and on PATH`,
      }),
    );
  }
  const forward = SIGNALS.map((signal) => {
    const handler = () => proc.kill(signal);
    process.on(signal, handler);
    return () => process.off(signal, handler);
  });
  const log = child.logPath === undefined ? undefined : createWriteStream(child.logPath);
  const out = child.stdoutTo === "stdout" ? deps.stdout : deps.stderr;
  await Promise.all([
    pumpLines(proc.stdout, child.map, (chunk) => {
      out.write(chunk);
      log?.write(chunk);
    }),
    pumpLines(proc.stderr, child.map, (chunk) => {
      deps.stderr.write(chunk);
      log?.write(chunk);
    }),
  ]);
  const code = await proc.exited;
  for (const off of forward) off();
  if (log) await new Promise((done) => log.end(done));
  const signal = proc.signalCode;
  if (signal === null) return ok(code);
  return ok(128 + (typeof signal === "string" ? constants.signals[signal] : signal));
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** The directory a command runs in and the worktree paths its arguments name, relative to the repository root. */
function touchedPaths(from: string, worktree: string, args: readonly string[]): string[] {
  const inside = (path: string) => {
    const rel = relative(worktree, path);
    return rel.startsWith("..") || isAbsolute(rel) ? undefined : rel || ".";
  };
  const named = args
    .flatMap((arg) => [arg, arg.slice(arg.indexOf("=") + 1)])
    .filter((value) => value.includes("/"))
    .map((value) => inside(resolve(from, value)));
  // A directory that cannot be placed counts as the root, so the project's steps still run.
  return [inside(from) ?? ".", ...named].filter((path) => path !== undefined);
}

/** Syncs the worktree into a free slot, runs the command there with the slot's warm build data, and hands results back. */
export async function runInSlot(
  deps: Deps,
  options: PassthroughOptions,
  wrapped: Wrapped,
  args: readonly string[],
): Promise<Result<number, XcslotError>> {
  const headless = wrapped === "mcp-build";
  if (headless && (args.length < 2 || args.length > 3)) {
    return err(failure("usage_error", "Expected a project or workspace, a scheme and an optional destination title"));
  }
  if (args.length === 0) {
    return err(
      failure("usage_error", `No ${wrapped === "run" ? "command" : "xcodebuild arguments"} given`, {
        hint: wrapped === "run" ? "xcslot run -- swift build" : "xcslot xcodebuild -scheme App build",
      }),
    );
  }
  const given = options.from === undefined ? deps.cwd : resolve(deps.cwd, options.from);
  // git reports the worktree by its real path; a symlinked spelling of `from` would point outside it.
  const from = existsSync(given) ? realpathSync(given) : given;
  const command = wrapped === "run" ? [...args] : [wrapped, ...args];

  // Inside a slot already (a script run by `xcslot run` that builds): use that slot, take no second one.
  const outerDerivedData = deps.env.XCSLOT_DERIVED_DATA ?? nestedHeadlessData(deps, from);
  if (outerDerivedData !== undefined) {
    if (headless) return err(failure("usage_error", "Start mcp-build from the caller's worktree"));
    const nested = wrapped === "xcodebuild" && !args.includes("-derivedDataPath") && !needsNoProject(args);
    const argv = nested ? [...command, "-derivedDataPath", outerDerivedData] : command;
    return spawnThrough(deps, { argv, cwd: from, env: { XCSLOT_DERIVED_DATA: outerDerivedData }, stdoutTo: "stdout" });
  }
  if (wrapped === "xcodebuild" && needsNoProject(args)) {
    return spawnThrough(deps, { argv: command, cwd: from, stdoutTo: "stdout" });
  }

  const config = loadUserConfig(configPath(deps.env, deps.home));
  if (config.isErr()) return err(config.error);
  const root = slotsRoot(deps.env, deps.home, config.value.root);
  const repo = resolveRepo(from, root);
  if (repo.isErr()) return err(repo.error);
  // Normalize absolute/relative caller paths before the command moves to the slot.
  const workspace = headless ? relative(repo.value.worktree, resolve(from, args[0] as string)) : undefined;
  if (workspace !== undefined && (workspace.startsWith("../") || !/\.(xcodeproj|xcworkspace)$/.test(workspace))) {
    return err(
      failure("usage_error", "The project or workspace must be inside the caller's worktree", {
        details: { beforeBuild: true },
      }),
    );
  }
  const project = loadProjectConfig(repo.value.worktree);
  if (project.isErr()) return err(project.error);
  const head = headOf(repo.value.worktree);
  if (head.isErr()) return err(head.error);

  const env = lockEnv(deps);
  mkdirSync(root, { recursive: true });
  sweep(root, config.value.slots, env);

  const wait = {
    deps,
    waitMs: (options.wait === false ? 0 : (options.wait ?? config.value.waitSeconds)) * 1000,
    startedAt: deps.now(),
  };
  const label = `${command.slice(0, 6).join(" ").slice(0, 80)} (${repo.value.worktree})`;
  const acquired = await acquireSlot(wait, repo.value, head.value, options.slots ?? config.value.slots, label);
  if (acquired.isErr()) return err(acquired.error);
  const slot = acquired.value;

  try {
    const state = readState(slot.state);
    const created = ensureCheckout(repo.value, slot, head.value);
    if (created.isErr()) return err(created.error);
    // Xcode adds its own workspace subdirectory. Keep the search for this build's products
    // separate from the CLI cache and from other projects, schemes and destinations.
    const derived =
      workspace === undefined
        ? slot.derivedData
        : join(
            slot.dir,
            "mcp",
            createHash("sha256")
              .update(JSON.stringify([workspace, ...args.slice(1)]))
              .digest("hex"),
          );
    const hasWorkspace = existsSync(headlessMarker(slot));
    const reuse =
      hasWorkspace && workspace !== undefined && reusableWorkspace(slot, join(slot.src, workspace), derived);
    if (hasWorkspace && !reuse) {
      const closed = closeHeadlessWorkspace(slot);
      if (closed.isErr()) return err(closed.error);
    }
    const syncStarted = deps.now();
    const synced = syncInto(
      repo.value.worktree,
      head.value,
      slot.src,
      state,
      project.value.sync.includeIgnored,
      reuse ? () => closeHeadlessWorkspace(slot) : undefined,
    );
    if (synced.isErr()) return err(synced.error);
    deps.stderr.write(
      `xcslot: slot ${slot.n}: synced ${synced.value.changed + synced.value.removed} changed files in ${seconds(deps.now() - syncStarted)}s\n`,
    );
    state.usedAt = deps.now();
    writeState(slot.state, state);

    const map = createPathMapper(slot.src, repo.value.worktree);
    const steps = prepareSteps(slot.src, project.value, touchedPaths(from, repo.value.worktree, args));
    if (steps.isErr()) return err(steps.error);
    // Generated inputs can change outside the mirrored file list.
    if (steps.value.length && existsSync(headlessMarker(slot))) {
      const closed = closeHeadlessWorkspace(slot);
      if (closed.isErr()) return err(closed.error);
      const refreshed = syncInto(repo.value.worktree, head.value, slot.src, state, project.value.sync.includeIgnored);
      if (refreshed.isErr()) return err(refreshed.error);
    }
    let stepFailure: XcslotError | undefined;
    const prepared = await prepare(
      steps.value,
      state,
      async (argv, cwd) => {
        const done = await spawnThrough(deps, { argv, cwd, map, stdoutTo: "stderr" });
        if (done.isErr()) stepFailure = done.error;
        return done.unwrapOr(127);
      },
      deps.stderr,
    );
    writeState(slot.state, state);
    if (prepared.isErr()) return err(stepFailure ?? prepared.error);

    if (headless) {
      // A reopened IDE can still retain an old filesystem-synchronized group. Once
      // Xcode has opened a slot, do not ask it to build a different file membership
      // or project definition in that slot. Keep the initial membership as a receipt.
      const paths = Object.keys(state.files).sort();
      const hash = createHash("sha256").update(JSON.stringify([workspace, paths]));
      for (const path of paths.filter((path) =>
        /\.(xcodeproj|xcworkspace)\/|(^|\/)Package\.(swift|resolved)$|\.xcconfig$/.test(path),
      )) {
        hash
          .update(path)
          .update("\0")
          .update(readFileSync(join(slot.src, path)));
      }
      const signature = hash.digest("hex");
      const receipt = join(slot.dir, "headless-inputs");
      const changed = existsSync(receipt)
        ? readFileSync(receipt, "utf8") !== signature
        : existsSync(join(slot.dir, "mcp"));
      if (changed || steps.value.length) {
        // A caller can safely use the CLI after the workspace has been closed.
        const closed = closeHeadlessWorkspace(slot);
        if (closed.isErr()) return err(closed.error);
        return err(
          failure(
            "usage_error",
            changed ? "MCP workspace inputs changed" : "MCP cannot verify generated project inputs",
            {
              hint: "Use xcodebuild for this slot's changed project or source membership",
              details: { beforeBuild: true },
            },
          ),
        );
      }
      if (!existsSync(receipt)) writeFileSync(receipt, signature);
    }
    const places = { cwd: from, worktree: repo.value.worktree, slotSrc: slot.src, slotDerivedData: slot.derivedData };
    const rewritten = wrapped === "xcodebuild" ? rewriteArgs(args, places) : undefined;
    const cwd = rewritten?.cwd ?? join(slot.src, relative(repo.value.worktree, from));
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
    mkdirSync(logsDir(repo.value.dir), { recursive: true });
    const logPath = join(
      logsDir(repo.value.dir),
      `${new Date(deps.now()).toISOString().replaceAll(":", "-")}-slot${slot.n}.log`,
    );

    const asked =
      options.productsTo !== undefined
        ? resolve(deps.cwd, options.productsTo)
        : rewritten?.derivedDataAsked !== undefined
          ? join(rewritten.derivedDataAsked, "Build", "Products")
          : undefined;
    // Checked before the build, so a folder that cannot take the products never turns a good build into a failure.
    if (options.productsTo !== undefined && asked !== undefined) {
      const usable = checkProductsDestination(asked);
      if (usable.isErr()) return err(usable.error);
    }

    // Slots asked for on the command line must be able to build at once, or the extra ones only wait.
    const cap = Math.max(config.value.maxConcurrent, options.slots ?? 0);
    const permit = await acquirePermit(wait, root, cap, label);
    if (permit.isErr()) return err(permit.error);
    const started = deps.now();
    const argv =
      workspace !== undefined
        ? headlessCommand(join(slot.src, workspace), ...args.slice(1))
        : rewritten
          ? ["xcodebuild", ...rewritten.args]
          : command;
    const ran = await spawnThrough(deps, {
      argv,
      cwd,
      env: {
        ...(headless && { XCSLOT_MCP_KEEP_OPEN: steps.value.length === 0 ? "1" : "0" }),
        XCSLOT_DERIVED_DATA: derived,
        XCSLOT_SLOT_DIR: slot.src,
        // Left out for xcodebuild: a value that differs per worktree would make every hand-off re-plan the build.
        ...(wrapped === "run" && { XCSLOT_WORKTREE: repo.value.worktree }),
      },
      map,
      logPath,
      stdoutTo: "stdout",
    });
    unlock(permit.value, env);
    if (ran.isErr()) return err(ran.error);
    if (headless && (ran.value === 78 || ran.value === 79)) {
      return err(
        failure("tool_missing", "Headless Xcode adapter failed", {
          hint: "See the adapter diagnostic and build log",
          details: { logPath, beforeBuild: ran.value === 78 && !existsSync(headlessMarker(slot)) },
        }),
      );
    }

    // Xcode may save project files and string catalogs even on a failed build. In MCP
    // mode the caller only requests products. The next sync reconciles the slot copy.
    const back = headless ? ok({ returned: [], conflicts: [] }) : writeBack(slot.src, state);
    if (back.isErr()) return err(back.error);
    if (back.value.returned.length > 0) {
      deps.stderr.write(
        `xcslot: returned ${back.value.returned.length} files the command wrote: ${back.value.returned.join(", ")}\n`,
      );
    }
    if (back.value.conflicts.length > 0) {
      deps.stderr.write(
        `xcslot: left alone, changed both by the command and in the worktree: ${back.value.conflicts.join(", ")}\n`,
      );
    }
    state.usedAt = deps.now();
    writeState(slot.state, state);

    let productData = slot.derivedData;
    if (workspace !== undefined && ran.value === 0 && asked !== undefined) {
      const actual = headlessProductData(derived, join(slot.src, workspace));
      if (actual.isErr()) return err(actual.error);
      productData = actual.value;
    }
    let products = `${join(productData, "Build", "Products")} (valid until the next build in slot ${slot.n})`;
    // A file both the build and the caller changed stays the caller's, here as in write-back.
    const conflicts = new Set(back.value.conflicts.map((path) => join(repo.value.worktree, path)));
    const keep = (path: string) => conflicts.has(path);
    const handOut = async (from: string, to: string, merge: boolean) => {
      const cloned = merge ? mergeProducts(from, to, keep) : cloneProducts(productData, to).map(() => 1);
      if (cloned.isErr()) return err(cloned.error);
      if (cloned.value === 0 || !options.dsym) return ok(0);
      return ok(await embedDebugSymbols(to, slot.src, repo.value.worktree));
    };
    if (ran.value === 0 && asked !== undefined) {
      const slotProducts = join(productData, "Build", "Products");
      const done = await handOut(slotProducts, asked, options.productsTo === undefined);
      if (done.isErr()) return err(done.error);
      products = `${asked}${done.value > 0 ? ` (${done.value} dSYMs)` : ""}`;
    }
    for (const { from: built, to } of ran.value === 0 ? (rewritten?.handOut ?? []) : []) {
      // Products go back only into a folder of outputs; one that holds tracked files is the caller's source.
      const tracked = gitList(repo.value.worktree, "ls-files", "--", relative(repo.value.worktree, to));
      if (tracked.isErr() || tracked.value.length > 0) {
        deps.stderr.write(`xcslot: left the products in ${built}: ${to} holds tracked files\n`);
        continue;
      }
      const done = await handOut(built, to, true);
      if (done.isErr()) return err(done.error);
    }
    deps.stderr.write(
      `xcslot: slot ${slot.n}: ${headless ? "BuildProject" : command[0]} exited ${ran.value} after ${seconds(deps.now() - started)}s; ${wrapped === "xcodebuild" ? `products: ${products}; ` : ""}log: ${logPath}\n`,
    );
    return ok(ran.value);
  } finally {
    unlock(slot.lock, env);
  }
}
