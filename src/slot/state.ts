import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const fileStat = z.tuple([z.number(), z.number()]);
export type FileStat = z.infer<typeof fileStat>;

export const slotStateSchema = z.object({
  /** The worktree this slot was last synced from. */
  source: z.string().optional(),
  head: z.string().optional(),
  usedAt: z.number().optional(),
  /** Input key of each prepare step that already ran in this slot. */
  prepared: z.record(z.string(), z.string()).default({}),
  /** Size and mtime of every mirrored file on both sides, as of the last sync. */
  files: z.record(z.string(), z.object({ src: fileStat, dst: fileStat })).default({}),
});
export type SlotState = z.infer<typeof slotStateSchema>;

export const emptyState = (): SlotState => ({ prepared: {}, files: {} });

/** The state is a cache of what a sync would find again, so an unreadable file means "compare everything". */
export function readState(path: string): SlotState {
  try {
    return slotStateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyState();
  }
}

export function writeState(path: string, state: SlotState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

export const repoRecordSchema = z.object({ main: z.string() });
