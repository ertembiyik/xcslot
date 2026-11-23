import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectConfig } from "../lib/config.ts";
import type { XcslotError } from "../lib/errors.ts";
import { gitList } from "../lib/proc.ts";
import { ok, type Result } from "../lib/result.ts";
import type { PrepareStep } from "../slot/prepare.ts";

const TUIST_MANIFEST = /(^|\/)(Project|Tuist|Workspace|Package)\.swift$|\/Tuist\/.*\.swift$|Package\.resolved$/;
const TUIST_PACKAGES = /(^|\/)Tuist\/Package\.(swift|resolved)$/;
const MISE_FILES = ["mise.toml", ".mise.toml", ".tool-versions"];

/** A repository that pins Tuist with mise is run through mise, so the slot builds with the pinned version. */
function tuistCommand(slotSrc: string, projectDir: string): string[] {
  const pinned = [slotSrc, projectDir].some((dir) =>
    MISE_FILES.some((name) => existsSync(join(dir, name)) && /\btuist\b/.test(readFileSync(join(dir, name), "utf8"))),
  );
  return pinned ? ["mise", "exec", "--", "tuist"] : ["tuist"];
}

/**
 * A Tuist project is generated inside the slot: the generated workspace holds absolute paths, and `tuist
 * install` checkouts do too, so neither can be mirrored from the worktree.
 */
function tuistSteps(slotSrc: string, tracked: readonly string[]): PrepareStep[] {
  const manifest = tracked
    .filter((path) => path === "Tuist.swift" || path.endsWith("/Tuist.swift"))
    .sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (manifest === undefined) return [];
  const rel = dirname(manifest);
  const projectDir = join(slotSrc, rel);
  const inProject = tracked.filter((path) => rel === "." || path.startsWith(`${rel}/`));
  const tuist = tuistCommand(slotSrc, projectDir);
  const packages = inProject.filter((path) => TUIST_PACKAGES.test(path));
  const steps: PrepareStep[] = [];
  if (packages.length > 0) {
    steps.push({
      name: "tuist install",
      argv: [...tuist, "install"],
      cwd: projectDir,
      inputs: packages.map((path) => join(slotSrc, path)),
      outputs: [],
      requires: [join(projectDir, "Tuist", ".build")],
    });
  }
  steps.push({
    name: "tuist generate",
    argv: [...tuist, "generate", "--no-open"],
    cwd: projectDir,
    inputs: inProject.filter((path) => TUIST_MANIFEST.test(path)).map((path) => join(slotSrc, path)),
    // Manifests glob sources, so a file added or removed changes the project without touching a manifest.
    salt: inProject.join("\0"),
    outputs: ["*.xcodeproj", "*.xcworkspace", "Derived"],
  });
  return steps;
}

/** The steps a slot needs before a build: Tuist's when the repository is a Tuist project, then the project's own. */
export function prepareSteps(slotSrc: string, config: ProjectConfig): Result<PrepareStep[], XcslotError> {
  return gitList(slotSrc, "ls-files", "-co", "--exclude-standard").andThen((tracked) => {
    const steps = tuistSteps(slotSrc, tracked);
    for (const step of config.prepare) {
      const inputs = gitList(slotSrc, "ls-files", "-co", "--exclude-standard", "--", ...step.inputs);
      if (inputs.isErr()) return inputs.map(() => steps);
      steps.push({
        name: step.name,
        argv: step.run,
        cwd: slotSrc,
        inputs: inputs.value.map((path) => join(slotSrc, path)),
        outputs: step.outputs,
      });
    }
    return ok(steps);
  });
}
