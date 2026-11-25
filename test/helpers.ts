import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Deps } from "../src/context.ts";
import { type ProcessTable, systemProcesses, withoutGitRepositoryEnv } from "../src/lib/proc.ts";
import { run } from "../src/run.ts";
import type { LockEnv } from "../src/slot/lock.ts";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch folder removed after the test; realpath, because macOS's temp folder is behind a symlink. */
export function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "xcslot-test-")));
  created.push(dir);
  return dir;
}

export function sh(cwd: string, ...argv: string[]): string {
  const done = Bun.spawnSync(argv, { cwd, env: withoutGitRepositoryEnv(process.env), stdout: "pipe", stderr: "pipe" });
  if (done.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${done.stderr.toString()}`);
  return done.stdout.toString();
}

export function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const git = (cwd: string, ...args: string[]) =>
  sh(
    cwd,
    "git",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    ...args,
  );

/** A committed repository with the given files. */
export function makeRepo(files: Readonly<Record<string, string>>, name = "app"): string {
  const repo = join(scratch(), name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  write(repo, files);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

export function addWorktree(repo: string, name: string): string {
  const path = join(dirname(repo), name);
  git(repo, "worktree", "add", "-q", "--detach", path, "HEAD");
  return path;
}

export const headOf = (worktree: string) => sh(worktree, "git", "rev-parse", "HEAD").trim();

/** A process table where exactly the listed pids are alive. */
export function fakeProcesses(alive: Record<number, string>): ProcessTable {
  return { startOf: (pid) => alive[pid] };
}

export function lockEnvFor(pid: number, processes: ProcessTable, clock = { now: 1_000_000 }): LockEnv {
  return { pid, processes, now: () => clock.now };
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliSetup {
  readonly cwd: string;
  readonly home: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** Runs the CLI in-process against a private slots root and config. */
export async function cli(argv: readonly string[], setup: CliSetup): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const deps: Deps = {
    stdout: { write: (text) => void (stdout += text) },
    stderr: { write: (text) => void (stderr += text) },
    stdoutIsTTY: false,
    env: {
      PATH: process.env.PATH,
      HOME: setup.home,
      XCSLOT_HOME: join(setup.home, "slots"),
      XCSLOT_CONFIG: join(setup.home, "config.json"),
      ...setup.env,
    },
    cwd: setup.cwd,
    home: setup.home,
    version: "0.0.0-test",
    pid: process.pid,
    processes: systemProcesses,
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
  const code = await run(argv, deps);
  return { code, stdout, stderr };
}

export const lastJson = (text: string): unknown => JSON.parse(text.trim().split("\n").at(-1) ?? "null");
