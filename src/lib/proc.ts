import { failure, type XcslotError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

export interface Completed {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

// `git rev-parse --local-env-vars`: a git hook exports some, which would aim git in the slot at the caller's repository.
const GIT_REPOSITORY_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

export function withoutGitRepositoryEnv(env: Readonly<Record<string, string | undefined>>) {
  const kept = { ...env };
  for (const name of GIT_REPOSITORY_ENV) delete kept[name];
  return kept;
}

/** Runs a short helper command to completion; a missing executable is `tool_missing`, not an exception. */
export function exec(argv: readonly string[], cwd?: string): Result<Completed, XcslotError> {
  try {
    const done = Bun.spawnSync([...argv], {
      ...(cwd !== undefined && { cwd }),
      env: withoutGitRepositoryEnv(process.env),
      stdout: "pipe",
      stderr: "pipe",
    });
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
    // ps prints the start time in the caller's time zone and locale; every reader must see the same string.
    const done = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
      env: { PATH: process.env.PATH, TZ: "UTC", LC_ALL: "C" },
      stdout: "pipe",
      stderr: "ignore",
    });
    const started = done.stdout.toString().trim().replace(/\s+/g, " ");
    return done.exitCode === 0 && started ? started : undefined;
  },
};
