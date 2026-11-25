import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// Size, mtime and mode; a state written before the mode was kept compares its files by content once.
const fileStat = z.union([
  z.tuple([z.number(), z.number(), z.number()]),
  z.tuple([z.number(), z.number()]).transform(([size, mtime]): [number, number, number] => [size, mtime, -1]),
]);
export type FileStat = z.output<typeof fileStat>;

export const slotStateSchema = z.object({
  /** The worktree this slot was last synced from. */
  source: z.string().optional(),
  head: z.string().optional(),
  usedAt: z.number().optional(),
  /** Per prepare step that ran in this slot: the key of the inputs it was given and of the inputs it left. */
  prepared: z.record(z.string(), z.union([z.array(z.string()), z.string().transform((key) => [key])])).default({}),
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
