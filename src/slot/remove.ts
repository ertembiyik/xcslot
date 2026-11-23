import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { logsDir, repoRecordPath, type SlotPaths, slotPaths } from "../lib/layout.ts";
import { exec } from "../lib/proc.ts";
import { type LockEnv, tryLock } from "./lock.ts";
import { readState, repoRecordSchema } from "./state.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const LOGS_KEPT = 10;

export const mainOf = (repoDir: string): string | undefined => {
  try {
    return repoRecordSchema.parse(JSON.parse(readFileSync(repoRecordPath(repoDir), "utf8"))).main;
  } catch {
    return undefined;
  }
};

export const slotNumbers = (repoDir: string): number[] =>
  existsSync(repoDir)
    ? readdirSync(repoDir)
        .filter((name) => /^\d+$/.test(name))
        .map(Number)
        .sort((a, b) => a - b)
    : [];

export const repoDirs = (root: string): string[] =>
  existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(repoRecordPath(join(root, entry.name))))
        .map((entry) => join(root, entry.name))
    : [];

/**
 * Removes a slot unless a build holds it. The folder is renamed first, which is instant and atomic, so no
 * build can start in a half-deleted slot; the gigabytes go afterwards.
 */
export function removeSlot(slot: SlotPaths, main: string | undefined, env: LockEnv): boolean {
  if (!existsSync(slot.dir)) return false;
  if (!tryLock(slot.lock, "removing this slot", env)) return false;
  const grave = join(dirname(slot.dir), `.removed-${slot.n}-${env.now()}`);
  renameSync(slot.dir, grave);
  rmSync(grave, { recursive: true, force: true });
  // The checkout was a registered git worktree; without this the repository keeps a dangling entry.
  if (main !== undefined && existsSync(main)) exec(["git", "worktree", "prune"], main);
  return true;
}

export function rotateLogs(repoDir: string, keep = LOGS_KEPT): void {
  const dir = logsDir(repoDir);
  if (!existsSync(dir)) return;
  const logs = readdirSync(dir)
    .filter((name) => name.endsWith(".log"))
    .sort();
  for (const name of logs.slice(0, Math.max(0, logs.length - keep))) rmSync(join(dir, name), { force: true });
}

export interface Swept {
  readonly orphanedRepos: string[];
  readonly expiredSlots: string[];
}

/**
 * Housekeeping with no daemon: at most once a day, the start of a command removes the slots of repositories
 * that are gone and the slots above the configured count that sat unused for a day.
 */
export function sweep(root: string, configuredSlots: number, env: LockEnv, force = false): Swept {
  const stamp = join(root, ".swept");
  const swept: Swept = { orphanedRepos: [], expiredSlots: [] };
  if (!existsSync(root)) return swept;
  if (!force && existsSync(stamp) && env.now() - statSync(stamp).mtimeMs < DAY_MS) return swept;
  writeFileSync(stamp, "");
  utimesSync(stamp, new Date(env.now()), new Date(env.now()));
  for (const repoDir of repoDirs(root)) {
    const main = mainOf(repoDir);
    const gone = main === undefined || !existsSync(main);
    for (const n of slotNumbers(repoDir)) {
      const slot = slotPaths(repoDir, n);
      const idleFor = env.now() - (readState(slot.state).usedAt ?? 0);
      if (gone || (n > configuredSlots && idleFor > DAY_MS)) {
        if (removeSlot(slot, main, env) && !gone) swept.expiredSlots.push(slot.dir);
      }
    }
    if (gone && slotNumbers(repoDir).length === 0) {
      rmSync(repoDir, { recursive: true, force: true });
      swept.orphanedRepos.push(repoDir);
    }
    rotateLogs(repoDir);
  }
  return swept;
}
