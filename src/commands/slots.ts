import type { Command } from "@commander-js/extra-typings";
import type { Deps } from "../context.ts";
import { describe, type Finish } from "../define-command.ts";
import { loadUserConfig } from "../lib/config.ts";
import { failure, type XcslotError } from "../lib/errors.ts";
import { configPath, permitsDir, resolveRepo, slotPaths, slotsRoot } from "../lib/layout.ts";
import { nextCommand } from "../lib/next.ts";
import { exec } from "../lib/proc.ts";
import { err, ok, type Result } from "../lib/result.ts";
import { lockEnv } from "../slot/acquire.ts";
import { holderOf, type LockEnv, type Owner, permitHolders } from "../slot/lock.ts";
import { mainOf, removeSlot, repoDirs, slotNumbers, sweep } from "../slot/remove.ts";
import { readState } from "../slot/state.ts";
import type { Holder, RepositorySlots, SlotInfo, Status } from "./schemas.ts";

const asHolder = (owner: Owner, now: number): Holder => ({
  pid: owner.pid,
  label: owner.label,
  seconds: Math.round((now - owner.since) / 1000),
});

function sizeOf(path: string): number | undefined {
  return exec(["du", "-sk", path]).match(
    (done) => (done.code === 0 ? Number.parseInt(done.stdout, 10) * 1024 : undefined),
    () => undefined,
  );
}

export function describeRepository(dir: string, env: LockEnv, sizes: boolean): RepositorySlots {
  const slots = slotNumbers(dir).map((n): SlotInfo => {
    const paths = slotPaths(dir, n);
    const state = readState(paths.state);
    const owner = holderOf(paths.lock, env);
    const bytes = sizes ? sizeOf(paths.dir) : undefined;
    return {
      n,
      path: paths.dir,
      busy: owner !== undefined,
      ...(owner && { holder: asHolder(owner, env.now()) }),
      ...(state.source !== undefined && { warmFor: state.source }),
      ...(state.head !== undefined && { head: state.head }),
      ...(state.usedAt !== undefined && { lastUsed: new Date(state.usedAt).toISOString() }),
      ...(bytes !== undefined && { bytes }),
    };
  });
  return { repository: mainOf(dir) ?? "unknown", directory: dir, slots };
}

const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

function renderSlots(repository: RepositorySlots): string {
  const lines = [`${repository.repository}  (${repository.directory})`];
  for (const slot of repository.slots) {
    const who = slot.holder ? `busy: ${slot.holder.label}, ${slot.holder.seconds}s, pid ${slot.holder.pid}` : "free";
    const warm = slot.warmFor ? `; warm for ${slot.warmFor} @ ${slot.head?.slice(0, 9)}` : "; never built";
    lines.push(`  slot ${slot.n}: ${who}${warm}${slot.bytes === undefined ? "" : `; ${gigabytes(slot.bytes)}`}`);
  }
  if (repository.slots.length === 0) lines.push("  no slots yet");
  return lines.join("\n");
}

interface Setup {
  readonly root: string;
  readonly slots: number;
  readonly maxConcurrent: number;
}

function setup(deps: Deps): Result<Setup, XcslotError> {
  return loadUserConfig(configPath(deps.env, deps.home)).map((config) => ({
    root: slotsRoot(deps.env, deps.home, config.root),
    slots: config.slots,
    maxConcurrent: config.maxConcurrent,
  }));
}

export function registerSlots(program: Command, deps: Deps, finish: Finish): void {
  const slots = program.command("slots").description("The warm build slots of the repository you are in");

  describe(
    slots
      .command("list")
      .description("Show each slot: who holds it, which worktree it is warm for, how big it is")
      .option("--from <dir>", "the repository to look at, instead of the current directory")
      .option("--sizes", "measure each slot on disk (takes a few seconds for large slots)", false)
      .action((options) =>
        finish(
          () =>
            setup(deps)
              .andThen(({ root }) => resolveRepo(options.from ?? deps.cwd, root))
              .map((repo) => {
                const data = describeRepository(repo.dir, lockEnv(deps), options.sizes);
                return {
                  data: { ...data, repository: repo.main },
                  next: [nextCommand("status", "it also shows the machine-wide cap and other repositories")],
                };
              }),
          (output) => renderSlots(output.data),
        ),
      ),
    {
      examples: ["xcslot slots list", "xcslot slots list --sizes --json"],
      errors: ["not_a_repository", "state_invalid"],
    },
  );

  describe(
    slots
      .command("remove")
      .description("Delete slots and their build data; the next build in a removed slot is a cold one")
      .argument("[n]", "the slot to remove", (value) => Number.parseInt(value, 10))
      .option("--all", "remove every slot of this repository", false)
      .option("--yes", "confirm the deletion", false)
      .option("--from <dir>", "the repository to act on, instead of the current directory")
      .action((n, options) =>
        finish(() =>
          setup(deps)
            .andThen(({ root }) => resolveRepo(options.from ?? deps.cwd, root))
            .andThen((repo) => {
              const existing = slotNumbers(repo.dir);
              if (n === undefined && !options.all) {
                return err(
                  failure("usage_error", "Name a slot or pass --all", { hint: "xcslot slots remove 2 --yes" }),
                );
              }
              const targets = options.all ? existing : existing.filter((slot) => slot === n);
              if (targets.length === 0 && !options.all) {
                return err(
                  failure("slot_not_found", `This repository has no slot ${n}`, {
                    next: [nextCommand("slots list", "it shows the slots that exist")],
                  }),
                );
              }
              if (!options.yes) {
                return err(
                  failure("confirmation_required", `This deletes ${targets.length} slot(s) and their build data`, {
                    hint: "Run the same command with --yes to delete them",
                    details: { slots: targets },
                    next: [nextCommand("slots list", "it shows what would be deleted, with sizes", { sizes: true })],
                  }),
                );
              }
              const env = lockEnv(deps);
              const removed: number[] = [];
              for (const slot of targets) {
                const result = removeSlot(slotPaths(repo.dir, slot), repo.main, env);
                if (result.isErr()) return err({ ...result.error, details: { slot, removed } });
                if (result.value) removed.push(slot);
              }
              const busy = targets.filter((slot) => !removed.includes(slot));
              return ok({
                data: { removed, busy },
                summary: `Removed ${removed.length} slot(s)${busy.length > 0 ? `; ${busy.join(", ")} busy, left alone` : ""}`,
              });
            }),
        ),
      ),
    {
      examples: ["xcslot slots remove 2 --yes", "xcslot slots remove --all --yes"],
      errors: [
        "not_a_repository",
        "slot_not_found",
        "confirmation_required",
        "state_invalid",
        "sync_failed",
        "tool_missing",
      ],
      destructive: true,
    },
  );

  describe(
    slots
      .command("prune")
      .description("Run the daily housekeeping now: slots of deleted repositories, and extra slots idle for a day")
      .action(() =>
        finish(() =>
          setup(deps).map(({ root, slots: configured }) => {
            const swept = sweep(root, configured, lockEnv(deps), true);
            return {
              data: swept,
              summary: `Removed ${swept.orphanedRepos.length} orphaned repositories and ${swept.expiredSlots.length} expired slots`,
            };
          }),
        ),
      ),
    { examples: ["xcslot slots prune"], errors: ["state_invalid"], destructive: true },
  );

  describe(
    program
      .command("status")
      .description("Who holds what right now: every repository's slots and the machine-wide cap")
      .action(() =>
        finish(
          () =>
            setup(deps).map(({ root, maxConcurrent }) => {
              const env = lockEnv(deps);
              const data: Status = {
                root,
                permits: {
                  max: maxConcurrent,
                  holders: permitHolders(permitsDir(root), maxConcurrent, env).map((owner) =>
                    asHolder(owner, env.now()),
                  ),
                },
                repositories: repoDirs(root).map((dir) => describeRepository(dir, env, false)),
              };
              return { data };
            }),
          ({ data }) =>
            [
              `permits: ${data.permits.holders.length} of ${data.permits.max} in use`,
              ...data.permits.holders.map((holder) => `  ${holder.label}, ${holder.seconds}s, pid ${holder.pid}`),
              ...data.repositories.map(renderSlots),
            ].join("\n"),
        ),
      ),
    { examples: ["xcslot status", "xcslot status --json"], errors: ["state_invalid"] },
  );
}
