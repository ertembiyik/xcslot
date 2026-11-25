import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  type Stats,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { failure, type XcslotError } from "../lib/errors.ts";
import { git, gitList } from "../lib/proc.ts";
import { err, ok, Result } from "../lib/result.ts";
import type { FileStat, SlotState } from "./state.ts";

// Ignored files pulled in by `includeIgnored` must never drag fetched or generated trees along.
const NEVER_MIRRORED = /(^|\/)(\.build|DerivedData|Derived|Pods|node_modules|[^/]+\.xcodeproj|[^/]+\.xcworkspace)\//;

function lstat(path: string): Stats | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    // A listed path under what is now a file: it is gone, like a missing one.
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
}
const statOf = (stats: Stats | undefined): FileStat | undefined =>
  stats ? [stats.size, stats.mtimeMs, stats.mode] : undefined;
const sameStat = (a: FileStat | undefined, b: FileStat | undefined) =>
  a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const sameMode = (a: Stats, b: Stats | undefined) => b !== undefined && (a.mode & 0o7777) === (b.mode & 0o7777);

function sameContent(from: string, a: Stats, to: string): boolean {
  const b = lstat(to);
  if (!b || a.isSymbolicLink() !== b.isSymbolicLink() || b.isDirectory()) return false;
  if (a.isSymbolicLink()) return readlinkSync(from) === readlinkSync(to);
  return a.size === b.size && readFileSync(from).equals(readFileSync(to));
}

/** The real directories on the way to `path` inside `root`, or undefined when a symlink or file is in the way. */
function realParent(root: string, path: string, known: Set<string>): string | undefined {
  let dir = root;
  for (const part of dirname(path)
    .split("/")
    .filter((part) => part !== ".")) {
    dir = join(dir, part);
    if (known.has(dir)) continue;
    if (!lstat(dir)?.isDirectory()) return undefined;
    known.add(dir);
  }
  return dir;
}

/** Makes `path`'s parent a real directory inside `root`, replacing a symlink or file that stands in its place. */
function makeParent(root: string, path: string): void {
  let dir = root;
  for (const part of dirname(path)
    .split("/")
    .filter((part) => part !== ".")) {
    dir = join(dir, part);
    const found = lstat(dir);
    if (found?.isDirectory()) continue;
    if (found) unlinkSync(dir);
    mkdirSync(dir);
  }
}

function copyEntry(from: string, stats: Stats, to: string): void {
  const found = lstat(to);
  if (found?.isDirectory()) rmSync(to, { recursive: true });
  else if (found) unlinkSync(to);
  if (stats.isSymbolicLink()) {
    symlinkSync(readlinkSync(from), to);
    return;
  }
  copyFileSync(from, to, constants.COPYFILE_FICLONE);
  chmodSync(to, stats.mode & 0o7777);
  // A clone carries the source's mtime; a changed file must not look like the one the build record knows.
  const now = new Date();
  utimesSync(to, now, now);
}

/** Tracked and untracked-unignored files, plus the ignored ones the project names as build inputs. */
export function listTree(top: string, includeIgnored: readonly string[]): Result<string[], XcslotError> {
  // A checked-out submodule is listed by its files; on its own, a gitlink is a directory that mirrors as nothing.
  const tracked = gitList(top, "ls-files", "-c", "--recurse-submodules");
  const untracked = untrackedIn(top, "");
  return Result.combine([tracked, untracked]).andThen(([cached, others]) => {
    const visible = [...cached, ...others];
    if (includeIgnored.length === 0) return ok(entriesOnly(visible));
    return gitList(top, "ls-files", "-oi", "--exclude-standard", "--", ...includeIgnored).map((ignored) =>
      entriesOnly([...visible, ...ignored.filter((path) => !NEVER_MIRRORED.test(path))]),
    );
  });
}

/** Two paths that name the same file or folder when case is ignored, if any. */
export function caseClash(paths: readonly string[]): [string, string] | undefined {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const name = parts.slice(0, depth).join("/");
      const other = seen.get(name.toLowerCase());
      if (other !== undefined && other !== name) return [other, name];
      seen.set(name.toLowerCase(), name);
    }
  }
  return undefined;
}

/** Untracked files git does not ignore, in the repository and in each checked-out submodule, from `top`. */
function untrackedIn(top: string, prefix: string): Result<string[], XcslotError> {
  const dir = join(top, prefix);
  return Result.combine([gitList(dir, "ls-files", "-o", "--exclude-standard"), gitList(dir, "ls-files", "-s")]).andThen(
    ([others, staged]) => {
      const submodules = staged
        .filter((line) => line.startsWith("160000 "))
        .map((line) => line.slice(line.indexOf("\t") + 1))
        .filter((path) => existsSync(join(dir, path, ".git")));
      return Result.combine(submodules.map((path) => untrackedIn(top, join(prefix, path)))).map((nested) => [
        ...others.map((path) => join(prefix, path)),
        ...nested.flat(),
      ]);
    },
  );
}

/** Marks a folder of products handed out by xcslot; such a folder is an output, never a build input. */
export const PRODUCTS_MARKER = ".xcslot-products";

// git lists a nested repository or worktree as one entry with a trailing slash; it is not a file to copy.
function entriesOnly(paths: readonly string[]): string[] {
  const handedOut = paths
    .filter((path) => path === PRODUCTS_MARKER || path.endsWith(`/${PRODUCTS_MARKER}`))
    .map((path) => path.slice(0, -PRODUCTS_MARKER.length));
  return [...new Set(paths.filter((path) => !path.endsWith("/") && !handedOut.some((dir) => path.startsWith(dir))))];
}

export interface SyncResult {
  readonly files: number;
  readonly changed: number;
  readonly removed: number;
}

/**
 * Mirrors a worktree into a slot's checkout. Only files whose content differs are rewritten, so every other
 * file keeps its mtime, and with it the build record that makes the next build incremental.
 */
export function syncInto(
  top: string,
  head: string,
  slotSrc: string,
  state: SlotState,
  includeIgnored: readonly string[],
): Result<SyncResult, XcslotError> {
  // Moves HEAD and the index only, so build scripts that ask git for the commit see the worktree's.
  const moved = git(slotSrc, "reset", "-q", "--mixed", head);
  if (moved.isErr()) return err(moved.error);
  const listed = listTree(top, includeIgnored);
  if (listed.isErr()) return err(listed.error);

  const inSlot = gitList(slotSrc, "ls-files", "-co", "--exclude-standard", "--deduplicate");
  if (inSlot.isErr()) return err(inSlot.error);

  const files: SlotState["files"] = {};
  const realDirs = new Set<string>();
  let changed = 0;
  let removed = 0;
  try {
    // git lists a tracked file deleted in the worktree; what is mirrored is what is on disk.
    const sources = new Map<string, Stats>();
    for (const path of listed.value) {
      const source = lstat(join(top, path));
      if (source && !source.isDirectory()) sources.set(path, source);
    }
    const byFoldedCase = new Map([...sources.keys()].map((path) => [path.toLowerCase(), path]));
    const clash = lstat(join(slotSrc, ".GIT")) ? caseClash([...sources.keys()]) : undefined;
    if (clash) {
      return err(
        failure("usage_error", `${clash[0]} and ${clash[1]} differ only in case, and the slot's volume ignores case`, {
          hint: "Rename one of them; a case-insensitive Mac cannot hold both",
        }),
      );
    }
    // Removals first, so a path that turned from a file into a directory, or back, is free before the copy.
    for (const path of new Set([...entriesOnly(inSlot.value), ...Object.keys(state.files)])) {
      if (sources.has(path)) continue;
      const parent = realParent(slotSrc, path, realDirs);
      const found = parent && lstat(join(slotSrc, path));
      if (!found || found.isDirectory()) continue;
      // On a case-insensitive volume a case-only rename names the same file; rename it rather than delete both.
      const twin = byFoldedCase.get(path.toLowerCase());
      const twinFound = twin && lstat(join(slotSrc, twin));
      if (twin && twinFound && twinFound.ino === found.ino && twinFound.dev === found.dev) {
        if (readdirSync(dirname(join(slotSrc, twin))).includes(basename(twin))) continue;
        renameSync(join(slotSrc, path), join(slotSrc, twin));
      } else {
        unlinkSync(join(slotSrc, path));
      }
      removed++;
    }
    for (const [path, source] of sources) {
      const from = join(top, path);
      const to = join(slotSrc, path);
      const before = state.files[path];
      const inPlace = realParent(slotSrc, path, realDirs) !== undefined;
      const untouched =
        inPlace && before && sameStat(before.src, statOf(source)) && sameStat(before.dst, statOf(lstat(to)));
      if (!untouched) {
        if (!inPlace || !sameContent(from, source, to)) {
          makeParent(slotSrc, path);
          copyEntry(from, source, to);
          changed++;
        } else if (!source.isSymbolicLink() && !sameMode(source, lstat(to))) {
          chmodSync(to, source.mode & 0o7777);
          changed++;
        }
      }
      const mirrored = statOf(lstat(to));
      if (mirrored) files[path] = { src: statOf(source) as FileStat, dst: mirrored };
    }
    state.files = files;
    state.head = head;
    state.source = top;
    return ok({ files: Object.keys(files).length, changed, removed });
  } catch (error) {
    return err(
      failure(
        "sync_failed",
        `Could not mirror ${top} into the slot: ${error instanceof Error ? error.message : error}`,
      ),
    );
  }
}

export interface WriteBack {
  /** Files the command wrote in the slot's source tree, now copied to the worktree. */
  readonly returned: string[];
  /** Files both the command and someone in the worktree changed; the worktree's copy is left alone. */
  readonly conflicts: string[];
}

/**
 * A command in a slot writes into the slot: recorded snapshot references, an updated Package.resolved, linter
 * fixes. This returns them to the worktree the agent is looking at.
 */
export function writeBack(slotSrc: string, state: SlotState): Result<WriteBack, XcslotError> {
  const top = state.source;
  if (top === undefined) return ok({ returned: [], conflicts: [] });
  const listed = gitList(slotSrc, "ls-files", "-co", "--exclude-standard", "--deduplicate");
  if (listed.isErr()) return err(listed.error);
  const returned: string[] = [];
  const conflicts: string[] = [];
  try {
    for (const path of entriesOnly(listed.value)) {
      const inSlot = lstat(join(slotSrc, path));
      if (!inSlot || inSlot.isDirectory()) continue;
      const before = state.files[path];
      if (before && sameStat(before.dst, statOf(inSlot))) continue;
      const inTree = lstat(join(top, path));
      // The worktree's copy must still be the one that was synced; an edit made during the build wins.
      if (before ? !sameStat(before.src, statOf(inTree)) : inTree !== undefined) {
        conflicts.push(path);
        continue;
      }
      if (!inTree || !sameContent(join(slotSrc, path), inSlot, join(top, path)) || !sameMode(inSlot, inTree)) {
        mkdirSync(dirname(join(top, path)), { recursive: true });
        copyEntry(join(slotSrc, path), inSlot, join(top, path));
        returned.push(path);
      }
      const now = statOf(lstat(join(top, path)));
      if (now) state.files[path] = { src: now, dst: statOf(inSlot) as FileStat };
    }
    return ok({ returned, conflicts });
  } catch (error) {
    return err(
      failure("sync_failed", `Could not return files to ${top}: ${error instanceof Error ? error.message : error}`),
    );
  }
}

/** Gives files a generator rewrote with identical content their old mtime back. */
export function restoreMtimes(
  before: ReadonlyMap<string, { mtime: Date; atime: Date; hash: string }>,
  hash: (path: string) => string,
): number {
  let kept = 0;
  for (const [path, old] of before) {
    if (!existsSync(path) || hash(path) !== old.hash) continue;
    utimesSync(path, old.atime, old.mtime);
    kept++;
  }
  return kept;
}
