import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Deps } from "../context.ts";
import { failure, type XcslotError } from "../lib/errors.ts";
import { permitsDir, type Repo, repoRecordPath, type SlotPaths, slotPaths } from "../lib/layout.ts";
import { nextCommand } from "../lib/next.ts";
import { git, gitList } from "../lib/proc.ts";
import { err, ok, type Result } from "../lib/result.ts";
import { holderOf, type LockEnv, type Owner, permitHolders, tryLock, tryPermit } from "./lock.ts";
import { orderSlots } from "./select.ts";
import { readState } from "./state.ts";

const POLL_MS = 2000;
const REMIND_MS = 60_000;

export const lockEnv = (deps: Deps): LockEnv => ({ pid: deps.pid, processes: deps.processes, now: deps.now });

const describe = (what: string, owner: Owner, now: number) =>
  `  ${what}: ${owner.label}, ${Math.round((now - owner.since) / 1000)}s, pid ${owner.pid}`;

interface Wait {
  readonly deps: Deps;
  readonly waitMs: number;
  readonly startedAt: number;
}

/** Tries until the deadline, telling the caller once who holds what: a silent wait looks like a hang. */
async function waitFor<Got>(
  wait: Wait,
  what: string,
  attempt: () => Got | undefined,
  holders: () => string[],
): Promise<Result<Got, XcslotError>> {
  let nextNotice = 0;
  for (;;) {
    const got = attempt();
    if (got !== undefined) return ok(got);
    const waited = wait.deps.now() - wait.startedAt;
    if (waited >= wait.waitMs) {
      return err(
        failure("slots_busy", `Every ${what} is busy${wait.waitMs > 0 ? ` after ${Math.round(waited / 1000)}s` : ""}`, {
          hint: "Other builds hold them; wait and run the same command again. Do not stop another session's build.",
          details: { holders: holders() },
          next: [nextCommand("status", "it shows which session holds each slot and for how long")],
        }),
      );
    }
    if (waited >= nextNotice) {
      const lines =
        nextNotice === 0
          ? [`xcslot: waiting for a ${what}:`, ...holders()]
          : [`xcslot: still waiting for a ${what} (${Math.round(waited / 1000)}s)`];
      wait.deps.stderr.write(`${lines.join("\n")}\n`);
      nextNotice += REMIND_MS;
    }
    await wait.deps.sleep(POLL_MS);
  }
}

export function acquireSlot(
  wait: Wait,
  repo: Repo,
  head: string,
  count: number,
  label: string,
): Promise<Result<SlotPaths, XcslotError>> {
  const env = lockEnv(wait.deps);
  const numbers = Array.from({ length: count }, (_, i) => i + 1);
  const attempt = () => {
    const candidates = numbers.map((n) => ({ n, state: readState(slotPaths(repo.dir, n).state) }));
    const order = orderSlots(candidates, repo.worktree, (slotHead) =>
      gitList(repo.worktree, "diff", "--name-only", slotHead, head).match(
        (files) => files.length,
        () => undefined,
      ),
    );
    for (const n of order) {
      const slot = slotPaths(repo.dir, n);
      mkdirSync(slot.dir, { recursive: true });
      if (tryLock(slot.lock, label, env)) return slot;
    }
    return undefined;
  };
  const holders = () =>
    numbers.flatMap((n) => {
      const owner = holderOf(slotPaths(repo.dir, n).lock, env);
      return owner ? [describe(`slot ${n}`, owner, wait.deps.now())] : [];
    });
  return waitFor(wait, "build slot", attempt, holders);
}

export function acquirePermit(
  wait: Wait,
  root: string,
  max: number,
  label: string,
): Promise<Result<string, XcslotError>> {
  const env = lockEnv(wait.deps);
  return waitFor(
    wait,
    "build permit",
    () => tryPermit(permitsDir(root), max, label, env),
    () => permitHolders(permitsDir(root), max, env).map((owner) => describe("permit", owner, wait.deps.now())),
  );
}

/** A slot's checkout is a detached git worktree, so build scripts that call git keep working. */
export function ensureCheckout(repo: Repo, slot: SlotPaths, head: string): Result<boolean, XcslotError> {
  if (existsSync(`${slot.src}/.git`)) return ok(false);
  mkdirSync(slot.dir, { recursive: true });
  writeFileSync(repoRecordPath(repo.dir), JSON.stringify({ main: repo.main }));
  // -f re-adds a slot whose folder was deleted by hand; the caller's worktree works for a bare repository too.
  return git(repo.worktree, "worktree", "add", "-f", "--detach", slot.src, head).map(() => true);
}
