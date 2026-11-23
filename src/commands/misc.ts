import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "@commander-js/extra-typings";
import skill from "../../skills/xcslot/SKILL.md" with { type: "text" };
import type { Deps } from "../context.ts";
import { describe, type Finish, metaOf } from "../define-command.ts";
import { loadProjectConfig, loadUserConfig } from "../lib/config.ts";
import { configPath, resolveRepo, slotsRoot } from "../lib/layout.ts";
import { exec, gitList } from "../lib/proc.ts";
import { ok } from "../lib/result.ts";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly fix?: string;
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

function tool(name: string, argv: string[], fix: string): Check {
  return exec(argv).match(
    (done): Check =>
      done.code === 0
        ? { name, ok: true, detail: firstLine(done.stdout || done.stderr) }
        : { name, ok: false, detail: firstLine(done.stderr || done.stdout), fix },
    (error): Check => ({ name, ok: false, detail: error.message, fix }),
  );
}

/** Slots cost no disk and no time to hand out only when the volume can clone files. */
function cloneCheck(root: string): Check {
  const probe = join(root, `.clone-probe-${process.pid}`);
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(probe, "probe");
    const cloned = exec(["cp", "-c", probe, `${probe}.clone`]);
    const works = cloned.isOk() && cloned.value.code === 0;
    return {
      name: "clone",
      ok: works,
      detail: works ? `${root} supports APFS clones` : `${root} cannot clone files`,
      ...(!works && { fix: "Put the slots root on an APFS volume (set `root` in the config)" }),
    };
  } catch (error) {
    return { name: "clone", ok: false, detail: String(error), fix: `Make ${root} writable` };
  } finally {
    rmSync(probe, { force: true });
    rmSync(`${probe}.clone`, { force: true });
  }
}

function doctor(deps: Deps): Check[] {
  const checks: Check[] = [
    tool("git", ["git", "--version"], "Install the Xcode command line tools: xcode-select --install"),
    tool(
      "xcodebuild",
      ["xcodebuild", "-version"],
      "Install Xcode and select it: sudo xcode-select -s /Applications/Xcode.app",
    ),
    tool(
      "dsymutil",
      ["xcrun", "--find", "dsymutil"],
      "Install Xcode; without it handed-out products carry no debug symbols",
    ),
  ];
  const path = configPath(deps.env, deps.home);
  const config = loadUserConfig(path);
  checks.push(
    config.match(
      (value): Check => ({
        name: "config",
        ok: true,
        detail: `${existsSync(path) ? path : "defaults"}: ${value.slots} slots per repository, ${value.maxConcurrent} commands at once`,
      }),
      (error): Check => ({ name: "config", ok: false, detail: error.message, fix: error.hint ?? `Fix ${path}` }),
    ),
  );
  const root = slotsRoot(deps.env, deps.home, config.isOk() ? config.value.root : undefined);
  checks.push(cloneCheck(root));
  const repo = resolveRepo(deps.cwd, root);
  if (repo.isOk()) {
    const project = loadProjectConfig(repo.value.worktree);
    checks.push(
      project.match(
        (value): Check => ({
          name: "project",
          ok: true,
          detail: `${repo.value.worktree}: ${value.prepare.length} prepare steps, ignored inputs ${value.sync.includeIgnored.join(" ") || "none"}`,
        }),
        (error): Check => ({
          name: "project",
          ok: false,
          detail: error.message,
          fix: error.hint ?? "Fix .xcslot.json",
        }),
      ),
    );
    const tuist = gitList(repo.value.worktree, "ls-files", "--", "Tuist.swift", "*/Tuist.swift");
    if (tuist.isOk() && tuist.value.length > 0) {
      checks.push(
        tool(
          "tuist",
          ["sh", "-c", "mise exec -- tuist version 2>/dev/null || tuist version"],
          "Install Tuist, or pin it with mise",
        ),
      );
    }
  }
  return checks;
}

interface CatalogEntry {
  readonly command: string;
  readonly description: string;
  readonly arguments: { name: string; required: boolean; description: string }[];
  readonly options: { flags: string; description: string; default?: unknown }[];
  readonly examples: readonly string[];
  readonly errors: readonly string[];
  readonly destructive: boolean;
  readonly passthrough: boolean;
}

export function catalog(root: Command): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const visit = (command: Command, path: string[]) => {
    for (const child of command.commands) {
      const childPath = [...path, child.name()];
      if (child.commands.length > 0) visit(child as Command, childPath);
      const meta = metaOf(child);
      if (!meta) continue;
      entries.push({
        command: childPath.join(" "),
        description: child.description(),
        arguments: child.registeredArguments.map((argument) => ({
          name: argument.name(),
          required: argument.required,
          description: argument.description,
        })),
        options: child.options.map((option) => ({
          flags: option.flags,
          description: option.description,
          ...(option.defaultValue !== undefined && { default: option.defaultValue }),
        })),
        examples: meta.examples,
        errors: meta.errors,
        destructive: meta.destructive ?? false,
        passthrough: meta.passthrough ?? false,
      });
    }
  };
  visit(root, []);
  return entries;
}

export function registerMisc(program: Command, deps: Deps, finish: Finish): void {
  describe(
    program
      .command("doctor")
      .description("Check the tools, the config and the slots root; each failed check says how to fix it")
      .action(() =>
        finish(
          () => {
            const checks = doctor(deps);
            const failed = checks.filter((check) => !check.ok).length;
            return ok({
              data: { checks },
              summary:
                failed === 0 ? "Everything xcslot needs is in place" : `${failed} of ${checks.length} checks failed`,
            });
          },
          ({ data, summary }) =>
            [
              ...data.checks.map(
                (check) =>
                  `${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}${check.fix ? `\n     fix: ${check.fix}` : ""}`,
              ),
              summary ?? "",
            ].join("\n"),
        ),
      ),
    { examples: ["xcslot doctor", "xcslot doctor --json"], errors: [] },
  );

  describe(
    program
      .command("commands")
      .description("List every command with its options, examples and errors, for agents")
      .action(() => finish(() => ok({ data: { version: deps.version, commands: catalog(program) } }))),
    { examples: ["xcslot commands --json"], errors: [] },
  );

  const skillCommand = program
    .command("skill")
    .description("The agent skill that teaches a coding agent to build through xcslot");
  describe(
    skillCommand
      .command("print", { isDefault: true })
      .description("Print the skill")
      .action(() => {
        deps.stdout.write(skill);
      }),
    { examples: ["xcslot skill"], errors: [] },
  );
  describe(
    skillCommand
      .command("install")
      .description("Write the skill into an agent's skills folder as xcslot/SKILL.md")
      .requiredOption("--dir <dir>", "the skills folder, for example ~/.claude/skills")
      .action((options) =>
        finish(() => {
          const target = join(resolve(deps.cwd, options.dir.replace(/^~(?=\/|$)/, deps.home)), "xcslot");
          mkdirSync(target, { recursive: true });
          writeFileSync(join(target, "SKILL.md"), skill);
          return ok({
            data: { path: join(target, "SKILL.md") },
            summary: `Installed the skill at ${join(target, "SKILL.md")}`,
          });
        }),
      ),
    { examples: ["xcslot skill install --dir ~/.claude/skills"], errors: [] },
  );
}
