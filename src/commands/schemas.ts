import { z } from "zod";

/** Output contracts. The field tables in docs/reference.md are generated from these, and a test fails when they drift. */
export const holderSchema = z.object({
  pid: z.int().describe("Process that holds it"),
  label: z.string().describe("The command it runs and the worktree it runs for"),
  seconds: z.int().describe("How long it has held it"),
});

export const slotSchema = z.object({
  n: z.int().describe("Slot number"),
  path: z.string().describe("The slot's folder: `src` is the mirrored checkout, `DerivedData` the build data"),
  busy: z.boolean().describe("Whether a command holds the slot now"),
  holder: holderSchema.optional().describe("Who holds it, when busy"),
  warmFor: z.string().optional().describe("The worktree it was last synced from"),
  head: z.string().optional().describe("The commit it last built"),
  lastUsed: z.string().optional().describe("When it was last used, ISO 8601"),
  bytes: z.int().optional().describe("Size on disk; only with --sizes"),
});

export const repositorySlotsSchema = z.object({
  repository: z.string().describe("The repository's main checkout"),
  directory: z.string().describe("Where its slots live"),
  slots: z.array(slotSchema).describe("One entry per slot that exists"),
});

export const statusSchema = z.object({
  root: z.string().describe("The folder all slots live in"),
  permits: z
    .object({
      max: z.int().describe("Heavy commands allowed at once on this Mac"),
      holders: z.array(holderSchema).describe("The commands running now"),
    })
    .describe("The machine-wide cap"),
  repositories: z.array(repositorySlotsSchema).describe("Every repository that has slots"),
});

export type Holder = z.infer<typeof holderSchema>;
export type SlotInfo = z.infer<typeof slotSchema>;
export type RepositorySlots = z.infer<typeof repositorySlotsSchema>;
export type Status = z.infer<typeof statusSchema>;

export const documentedOutputs = {
  "slots list": repositorySlotsSchema,
  status: statusSchema,
} as const;
