import { failure, type XcslotError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

export interface Completed {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a short helper command to completion; a missing executable is `tool_missing`, not an exception. */
export function exec(argv: readonly string[], cwd?: string): Result<Completed, XcslotError> {
  try {
    const done = Bun.spawnSync([...argv], { ...(cwd !== undefined && { cwd }), stdout: "pipe", stderr: "pipe" });
    return ok({ code: done.exitCode, stdout: done.stdout.toString(), stderr: done.stderr.toString() });
  } catch (error) {
    return err(
      failure("tool_missing", `Could not run ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`, {
        hint: `Install ${argv[0]} or put it on PATH`,
      }),
    );
  }
}

export function git(cwd: string, ...args: string[]): Result<string, XcslotError> {
  return exec(["git", ...args], cwd).andThen((done) =>
    done.code === 0
      ? ok(done.stdout)
      : err(failure("sync_failed", `git ${args[0]} failed in ${cwd}: ${done.stderr.trim()}`)),
  );
}

export function gitList(cwd: string, ...args: string[]): Result<string[], XcslotError> {
  const [sub, ...rest] = args;
  return git(cwd, sub ?? "ls-files", "-z", ...rest).map((out) => out.split("\0").filter(Boolean));
}

export interface ProcessTable {
  /** A process's start time as `ps` prints it, or undefined when it is gone. */
  startOf(pid: number): string | undefined;
}

export const systemProcesses: ProcessTable = {
  startOf(pid) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined;
    }
    const done = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const started = done.stdout.toString().trim().replace(/\s+/g, " ");
    return done.exitCode === 0 && started ? started : undefined;
  },
};
