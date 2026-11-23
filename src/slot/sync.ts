import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  type Stats,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { failure, type XcslotError } from "../lib/errors.ts";
import { git, gitList } from "../lib/proc.ts";
import { err, ok, type Result } from "../lib/result.ts";
import type { FileStat, SlotState } from "./state.ts";

// Ignored files pulled in by `includeIgnored` must never drag fetched or generated trees along.
const NEVER_MIRRORED = /(^|\/)(\.build|DerivedData|Derived|Pods|node_modules|[^/]+\.xcodeproj|[^/]+\.xcworkspace)\//;

const lstat = (path: string): Stats | undefined => lstatSync(path, { throwIfNoEntry: false });
const statOf = (stats: Stats | undefined): FileStat | undefined => (stats ? [stats.size, stats.mtimeMs] : undefined);
const sameStat = (a: FileStat | undefined, b: FileStat | undefined) =>
  a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1];

function sameContent(from: string, a: Stats, to: string): boolean {
  const b = lstat(to);
  if (!b || a.isSymbolicLink() !== b.isSymbolicLink()) return false;
  if (a.isSymbolicLink()) return readlinkSync(from) === readlinkSync(to);
  if (a.size !== b.size || (a.mode & 0o111) !== (b.mode & 0o111)) return false;
  return readFileSync(from).equals(readFileSync(to));
}

function copyEntry(from: string, stats: Stats, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    unlinkSync(to);
  } catch {}
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
  return gitList(top, "ls-files", "-co", "--exclude-standard", "--deduplicate").andThen((visible) => {
    if (includeIgnored.length === 0) return ok(entriesOnly(visible));
    return gitList(top, "ls-files", "-oi", "--exclude-standard", "--", ...includeIgnored).map((ignored) =>
      entriesOnly([...visible, ...ignored.filter((path) => !NEVER_MIRRORED.test(path))]),
    );
  });
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

  const files: SlotState["files"] = {};
  let changed = 0;
  try {
    for (const path of listed.value) {
      const from = join(top, path);
      const to = join(slotSrc, path);
      const source = lstat(from);
      if (!source || source.isDirectory()) continue;
      const before = state.files[path];
      const untouched = before && sameStat(before.src, statOf(source)) && sameStat(before.dst, statOf(lstat(to)));
      if (!untouched && !sameContent(from, source, to)) {
        copyEntry(from, source, to);
        changed++;
      }
      const mirrored = statOf(lstat(to));
      if (mirrored) files[path] = { src: [source.size, source.mtimeMs], dst: mirrored };
    }
    let removed = 0;
    const inSlot = gitList(slotSrc, "ls-files", "-co", "--exclude-standard", "--deduplicate");
    if (inSlot.isErr()) return err(inSlot.error);
    for (const path of new Set([...entriesOnly(inSlot.value), ...Object.keys(state.files)])) {
      if (path in files || !lstat(join(slotSrc, path))) continue;
      rmSync(join(slotSrc, path), { force: true });
      removed++;
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
      if (!inTree || !sameContent(join(slotSrc, path), inSlot, join(top, path))) {
        copyEntry(join(slotSrc, path), inSlot, join(top, path));
        returned.push(path);
      }
      const now = statOf(lstat(join(top, path)));
      if (now) state.files[path] = { src: now, dst: [inSlot.size, inSlot.mtimeMs] };
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
