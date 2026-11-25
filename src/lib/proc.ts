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

// Xcode hashes the whole environment into its build description, so a variable that differs per shell or agent
// session makes the next build re-plan: about 4 s on IceCubesApp, on Xcode 27.0 and 27.3 beta 2.
const SESSION_ENV = [
  "OLDPWD",
  "SHLVL",
  "_",
  "TERM_SESSION_ID",
  "ITERM_SESSION_ID",
  "SECURITYSESSIONID",
  "Apple_PubSub_Socket_Render",
  "TMUX",
  "TMUX_PANE",
  "WINDOWID",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "XPC_FLAGS",
  "XPC_SERVICE_NAME",
  "__CFBundleIdentifier",
];
const SESSION_ENV_PREFIXES = ["CLAUDE_", "CLAUDECODE", "CODEX_", "CURSOR_"];

/** The environment of a command run in a slot: the same for every worktree and agent session that builds there. */
export function slotCommandEnv(env: Readonly<Record<string, string | undefined>>, cwd: string) {
  const kept = withoutGitRepositoryEnv(env);
  for (const name of SESSION_ENV) delete kept[name];
  for (const name of Object.keys(kept)) {
    if (SESSION_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) delete kept[name];
  }
  kept.PWD = cwd;
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
  /** A process's start time as `ps` prints it in UTC and the C locale, or undefined when it is gone. */
  startOf(pid: number): string | undefined;
  /** The same in the caller's own time zone and locale, as xcslot 0.1.4 and earlier recorded it. */
  localStartOf?(pid: number): string | undefined;
}

function psStart(pid: number, env: Record<string, string | undefined>): string | undefined {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  const done = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env, stdout: "pipe", stderr: "ignore" });
  const started = done.stdout.toString().trim().replace(/\s+/g, " ");
  return done.exitCode === 0 && started ? started : undefined;
}

export const systemProcesses: ProcessTable = {
  // ps prints the start time in the caller's time zone and locale; every reader must see the same string.
  startOf: (pid) => psStart(pid, { PATH: process.env.PATH, TZ: "UTC", LC_ALL: "C" }),
  localStartOf: (pid) => psStart(pid, process.env),
};
