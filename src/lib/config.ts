import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { failure, type XcslotError } from "./errors.ts";
import { nextCommand } from "./next.ts";
import { err, ok, type Result } from "./result.ts";

export const userConfigSchema = z.strictObject({
  /** Warm slots kept per repository. */
  slots: z.int().min(1).max(16).default(3),
  /** Heavy commands running at once on this Mac, across repositories. */
  maxConcurrent: z.int().min(1).max(32).default(3),
  /** How long a command waits for a free slot before failing with `slots_busy`. */
  waitSeconds: z.int().min(0).default(3600),
  /** Where slots live; fixed paths are what keeps DerivedData warm, so moving this makes every slot cold. */
  root: z.string().min(1).optional(),
});
export type UserConfig = z.infer<typeof userConfigSchema>;

const prepareStepSchema = z.strictObject({
  name: z.string().min(1),
  /** The command and its arguments, run in the slot's copy of the repository root. */
  run: z.array(z.string().min(1)).min(1),
  /** Git pathspecs of the files whose content decides whether the step runs again. */
  inputs: z.array(z.string().min(1)).min(1),
  /** Names of generated directories; files in them rewritten with identical content keep their old mtime. */
  outputs: z.array(z.string().min(1)).default([]),
});

export const projectConfigSchema = z.strictObject({
  prepare: z.array(prepareStepSchema).default([]),
  sync: z
    .strictObject({
      /** Git pathspecs of ignored files that are build inputs and must reach the slot. */
      includeIgnored: z.array(z.string().min(1)).default(["*.xcconfig"]),
    })
    .default({ includeIgnored: ["*.xcconfig"] }),
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type PrepareStepConfig = z.infer<typeof prepareStepSchema>;

export const PROJECT_CONFIG_NAME = ".xcslot.json";

function load<Schema extends z.ZodType>(path: string, schema: Schema): Result<z.infer<Schema>, XcslotError> {
  let raw: unknown = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      return err(invalid(path, error instanceof Error ? error.message : String(error)));
    }
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(invalid(path, z.prettifyError(parsed.error)));
}

const invalid = (path: string, problem: string) =>
  failure("state_invalid", `${path} is not a valid xcslot config`, {
    hint: problem,
    details: { path },
    next: [nextCommand("doctor", "it lists every problem with the config and the slots")],
  });

export const loadUserConfig = (path: string) => load(path, userConfigSchema);
export const loadProjectConfig = (repoRoot: string) => load(join(repoRoot, PROJECT_CONFIG_NAME), projectConfigSchema);
