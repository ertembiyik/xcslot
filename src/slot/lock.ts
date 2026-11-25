import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ProcessTable } from "../lib/proc.ts";

const ownerSchema = z.object({
  pid: z.int(),
  /** Start time of the owning process in its own time zone, which xcslot 0.1.4 and earlier compare. */
  started: z.string(),
  /** The same in UTC: a reused pid never keeps a dead lock alive, whatever the reader's time zone. */
  startedUtc: z.string().optional(),
  /** What the holder is doing, shown to whoever waits. */
  label: z.string(),
  since: z.number(),
});
export type Owner = z.infer<typeof ownerSchema>;

export interface LockEnv {
  readonly pid: number;
  readonly processes: ProcessTable;
  now(): number;
}

// The owner file is written right after mkdir; a lock without one for this long lost its owner in between.
const OWNERLESS_GRACE_MS = 10_000;

function readOwner(dir: string): Owner | undefined {
  try {
    return ownerSchema.parse(JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")));
  } catch {
    return undefined;
  }
}

/** The live holder of a lock, if any. */
export function holderOf(dir: string, env: LockEnv): Owner | undefined {
  const owner = readOwner(dir);
  if (!owner) return undefined;
  const alive =
    owner.startedUtc !== undefined
      ? env.processes.startOf(owner.pid) === owner.startedUtc
      : [env.processes.startOf(owner.pid), env.processes.localStartOf?.(owner.pid)].includes(owner.started);
  return alive ? owner : undefined;
}

function isStale(dir: string, env: LockEnv): boolean {
  if (readOwner(dir)) return holderOf(dir, env) === undefined;
  try {
    return env.now() - statSync(dir).mtimeMs > OWNERLESS_GRACE_MS;
  } catch {
    return false;
  }
}

/** Moves a dead owner's lock aside. Only the holder of `<dir>.breaking` may, so no one moves a lock just retaken. */
function breakStale(dir: string, env: LockEnv): boolean {
  const breaking = `${dir}.breaking`;
  try {
    mkdirSync(breaking);
  } catch {
    if (isStale(breaking, env)) rmSync(breaking, { recursive: true, force: true });
    return false;
  }
  try {
    if (!isStale(dir, env)) return false;
    const grave = `${dir}.stale-${env.pid}-${env.now()}`;
    renameSync(dir, grave);
    rmSync(grave, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(breaking, { recursive: true, force: true });
  }
}

/** mkdir is atomic, so one caller wins; a lock whose owner died is moved aside first. */
export function tryLock(dir: string, label: string, env: LockEnv): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
    } catch {
      if (attempt === 1 || !isStale(dir, env) || !breakStale(dir, env)) return false;
      continue;
    }
    const startedUtc = env.processes.startOf(env.pid) ?? "";
    const started = env.processes.localStartOf?.(env.pid) ?? startedUtc;
    const owner: Owner = { pid: env.pid, started, startedUtc, label, since: env.now() };
    writeFileSync(join(dir, "owner.tmp"), JSON.stringify(owner));
    renameSync(join(dir, "owner.tmp"), join(dir, "owner.json"));
    return true;
  }
  return false;
}

/** Releases a lock only if this process still owns it. */
export function unlock(dir: string, env: LockEnv): void {
  if (readOwner(dir)?.pid === env.pid) rmSync(dir, { recursive: true, force: true });
}

export const permitPath = (permits: string, i: number) => join(permits, `permit-${i}`);

/** One of `max` machine-wide permits for a heavy command, or undefined when all are held. */
export function tryPermit(permits: string, max: number, label: string, env: LockEnv): string | undefined {
  mkdirSync(permits, { recursive: true });
  for (let i = 1; i <= max; i++) if (tryLock(permitPath(permits, i), label, env)) return permitPath(permits, i);
  return undefined;
}

export function permitHolders(permits: string, max: number, env: LockEnv): Owner[] {
  const holders: Owner[] = [];
  for (let i = 1; i <= max; i++) {
    const owner = holderOf(permitPath(permits, i), env);
    if (owner) holders.push(owner);
  }
  return holders;
}
