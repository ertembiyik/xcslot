import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { failure, type XcslotError } from "./errors.ts";
import { git } from "./proc.ts";
import { err, type Result } from "./result.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export const configPath = (env: Env, home: string) =>
  env.XCSLOT_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "xcslot", "config.json");

/** Next to Xcode's own DerivedData: disk tools look there, and the system never purges it mid-build. */
export const slotsRoot = (env: Env, home: string, configured: string | undefined) =>
  env.XCSLOT_HOME ?? configured ?? join(home, "Library", "Developer", "xcslot");

export interface Repo {
  /** The worktree the command was run from. */
  readonly worktree: string;
  /** The repository's main checkout, shared by all its worktrees. */
  readonly main: string;
  /** This repository's folder under the slots root. */
  readonly dir: string;
}

export function resolveRepo(from: string, root: string): Result<Repo, XcslotError> {
  const top = git(from, "rev-parse", "--show-toplevel");
  if (top.isErr()) {
    return err(
      top.error.code === "tool_missing"
        ? top.error
        : failure("not_a_repository", `${from} is not inside a git worktree`, {
            hint: "Run xcslot from the project's checkout, or pass --from <dir>",
          }),
    );
  }
  const worktree = top.value.trim();
  return git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir").map((out) => {
    // A bare repository or a separate git dir has no main checkout; the git dir itself names the repository.
    const common = out.trim();
    const main = basename(common) === ".git" ? dirname(common) : common;
    return { worktree, main, dir: repoDir(root, main) };
  });
}

/** The folder name alone is not unique, so two repositories called `app` get different slots. */
export const repoDir = (root: string, main: string) =>
  join(root, `${basename(main)}-${createHash("sha256").update(main).digest("hex").slice(0, 8)}`);

export interface SlotPaths {
  readonly n: number;
  readonly dir: string;
  readonly src: string;
  readonly derivedData: string;
  readonly state: string;
  readonly lock: string;
}

export function slotPaths(repoDir: string, n: number): SlotPaths {
  const dir = join(repoDir, String(n));
  return {
    n,
    dir,
    src: join(dir, "src"),
    derivedData: join(dir, "DerivedData"),
    state: join(dir, "state.json"),
    lock: join(dir, "lock"),
  };
}

export const repoRecordPath = (repoDir: string) => join(repoDir, "repo.json");
export const logsDir = (repoDir: string) => join(repoDir, "logs");
export const permitsDir = (root: string) => join(root, "permits");

export function headOf(worktree: string): Result<string, XcslotError> {
  return git(worktree, "rev-parse", "--verify", "-q", "HEAD^{commit}")
    .mapErr((error) =>
      error.code === "tool_missing"
        ? error
        : failure("usage_error", `${worktree} has no commit yet`, {
            hint: "Commit once; a slot is a checkout of a commit plus your changes",
          }),
    )
    .map((out) => out.trim());
}
