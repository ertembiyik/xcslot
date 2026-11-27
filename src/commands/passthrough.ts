import { createWriteStream, existsSync, mkdirSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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

export type Wrapped = "xcodebuild" | "run";

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

const PATH_OPTIONS = new Set(["-project", "-workspace", "--package-path"]);

/** The invocation directory and path-like arguments, relative to the repository root. */
function touchedPaths(from: string, worktree: string, args: readonly string[]): [string, ...string[]] {
  const cwd = relative(worktree, from) || ".";
  // A directory that cannot be placed counts as the root, so the project's steps still run.
  if (cwd === ".." || cwd.startsWith("../") || isAbsolute(cwd)) return ["."];
  const named = args.flatMap((arg, i) => {
    const pathValue = PATH_OPTIONS.has(args[i - 1] ?? "");
    const assignment = pathValue ? undefined : arg.match(/^(-{1,2}[\w-]+|[A-Za-z_]\w*)=(.*)$/s);
    const value = assignment?.[2] ?? arg;
    const pathOption = pathValue || PATH_OPTIONS.has(assignment?.[1] ?? "");
    if (pathOption || value === "." || value === ".." || (!value.startsWith("-") && value.includes("/"))) {
      // Keep paths outside the worktree too: they disqualify a package-local invocation.
      return [relative(worktree, resolve(from, value)) || "."];
    }
    return [];
  });
  return [cwd, ...named];
}

/** Syncs the worktree into a free slot, runs the command there with the slot's warm build data, and hands results back. */
export async function runInSlot(
  deps: Deps,
  options: PassthroughOptions,
  wrapped: Wrapped,
  args: readonly string[],
): Promise<Result<number, XcslotError>> {
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
  const command = wrapped === "xcodebuild" ? ["xcodebuild", ...args] : [...args];

  // Inside a slot already (a script run by `xcslot run` that builds): use that slot, take no second one.
  const outerDerivedData = deps.env.XCSLOT_DERIVED_DATA;
  if (outerDerivedData !== undefined) {
    const nested = wrapped === "xcodebuild" && !args.includes("-derivedDataPath") && !needsNoProject(args);
    const argv = nested ? [...command, "-derivedDataPath", outerDerivedData] : command;
    return spawnThrough(deps, { argv, cwd: from, stdoutTo: "stdout" });
  }
  if (wrapped === "xcodebuild" && needsNoProject(args)) {
    return spawnThrough(deps, { argv: command, cwd: from, stdoutTo: "stdout" });
  }

  const config = loadUserConfig(configPath(deps.env, deps.home));
  if (config.isErr()) return err(config.error);
  const root = slotsRoot(deps.env, deps.home, config.value.root);
  const repo = resolveRepo(from, root);
  if (repo.isErr()) return err(repo.error);
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
    const syncStarted = deps.now();
    const synced = syncInto(repo.value.worktree, head.value, slot.src, state, project.value.sync.includeIgnored);
    if (synced.isErr()) return err(synced.error);
    deps.stderr.write(
      `xcslot: slot ${slot.n}: synced ${synced.value.changed + synced.value.removed} changed files in ${seconds(deps.now() - syncStarted)}s\n`,
    );
    state.usedAt = deps.now();
    writeState(slot.state, state);

    const map = createPathMapper(slot.src, repo.value.worktree);
    const steps = prepareSteps(slot.src, project.value, touchedPaths(from, repo.value.worktree, args));
    if (steps.isErr()) return err(steps.error);
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
    const ran = await spawnThrough(deps, {
      argv: rewritten ? ["xcodebuild", ...rewritten.args] : command,
      cwd,
      env: {
        XCSLOT_DERIVED_DATA: slot.derivedData,
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

    const back = writeBack(slot.src, state);
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

    let products = `${join(slot.derivedData, "Build", "Products")} (valid until the next build in slot ${slot.n})`;
    // A file both the build and the caller changed stays the caller's, here as in write-back.
    const conflicts = new Set(back.value.conflicts.map((path) => join(repo.value.worktree, path)));
    const keep = (path: string) => conflicts.has(path);
    const handOut = async (from: string, to: string, merge: boolean) => {
      const cloned = merge ? mergeProducts(from, to, keep) : cloneProducts(slot.derivedData, to).map(() => 1);
      if (cloned.isErr()) return err(cloned.error);
      if (cloned.value === 0 || !options.dsym) return ok(0);
      return ok(await embedDebugSymbols(to, slot.src, repo.value.worktree));
    };
    if (ran.value === 0 && asked !== undefined) {
      const slotProducts = join(slot.derivedData, "Build", "Products");
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
      `xcslot: slot ${slot.n}: ${command[0]} exited ${ran.value} after ${seconds(deps.now() - started)}s; ${wrapped === "xcodebuild" ? `products: ${products}; ` : ""}log: ${logPath}\n`,
    );
    return ok(ran.value);
  } finally {
    unlock(slot.lock, env);
  }
}
