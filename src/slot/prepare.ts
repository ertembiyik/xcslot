import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { failure, type XcslotError } from "../lib/errors.ts";
import type { Writer } from "../lib/output.ts";
import { err, ok, type Result } from "../lib/result.ts";
import type { SlotState } from "./state.ts";
import { restoreMtimes } from "./sync.ts";

/** A command that must run in the slot before the build when its inputs changed, such as `tuist generate`. */
export interface PrepareStep {
  readonly name: string;
  readonly argv: readonly string[];
  /** Absolute directory in the slot to run in. */
  readonly cwd: string;
  /** Absolute paths whose content decides whether the step runs again. */
  readonly inputs: readonly string[];
  /** Extra text folded into the key, such as the list of source files a generator globs. */
  readonly salt?: string;
  /** Names of generated directories under `cwd`; a step whose outputs are all missing runs again. */
  readonly outputs: readonly string[];
  /** Paths that must exist for the step to count as done. */
  readonly requires?: readonly string[];
}

const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function keyOf(step: PrepareStep): string {
  const hash = createHash("sha256")
    .update(step.argv.join("\0"))
    .update(step.salt ?? "");
  for (const path of [...step.inputs].sort()) {
    hash.update(path).update("\0");
    if (existsSync(path)) hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

/** Files inside generated directories, found a few levels down without entering fetched or hidden trees. */
export function generatedFiles(cwd: string, outputs: readonly string[]): string[] {
  const globs = outputs.map((pattern) => new Bun.Glob(pattern));
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (globs.some((glob) => glob.match(entry.name))) {
        for (const file of readdirSync(path, { recursive: true, withFileTypes: true })) {
          if (file.isFile()) found.push(join(file.parentPath, file.name));
        }
      } else if (depth < 4) walk(path, depth + 1);
    }
  };
  if (outputs.length > 0 && existsSync(cwd)) walk(cwd, 0);
  return found;
}

export type RunStep = (argv: readonly string[], cwd: string) => Promise<number>;

/** Runs each step whose inputs changed since it last ran in this slot. */
export async function prepare(
  steps: readonly PrepareStep[],
  state: SlotState,
  run: RunStep,
  log: Writer,
): Promise<Result<string[], XcslotError>> {
  const ran: string[] = [];
  for (const step of steps) {
    const before = generatedFiles(step.cwd, step.outputs);
    const present = (step.outputs.length === 0 || before.length > 0) && (step.requires ?? []).every(existsSync);
    // A step after one that just ran runs too: what it reads may be what that step produced.
    const given = keyOf(step);
    if (ran.length === 0 && state.prepared[step.name]?.includes(given) && present) continue;
    const snapshot = new Map(
      before.map((path) => {
        const stats = lstatSync(path);
        return [path, { mtime: stats.mtime, atime: stats.atime, hash: hashFile(path) }];
      }),
    );
    log.write(`xcslot: ${step.name}\n`);
    const code = await run(step.argv, step.cwd);
    if (code !== 0) {
      return err(
        failure("prepare_failed", `${step.name} exited ${code}`, {
          hint: `The step's own output is above; it ran as: ${step.argv.join(" ")}`,
          details: { step: step.name, exitCode: code },
        }),
      );
    }
    const kept = restoreMtimes(snapshot, hashFile);
    if (snapshot.size > 0)
      log.write(`xcslot: ${step.name} left ${kept} of ${snapshot.size} generated files unchanged\n`);
    // A step may rewrite its own inputs, as a resolver does with its lock file. Both versions count as done,
    // so a worktree that still holds the earlier lock file does not run the step again.
    state.prepared[step.name] = [...new Set([given, keyOf(step)])];
    ran.push(step.name);
  }
  return ok(ran);
}
