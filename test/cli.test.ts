import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import skill from "../skills/xcslot/SKILL.md" with { type: "text" };
import { splitWrapped } from "../src/run.ts";
import { addWorktree, cli, headOf, lastJson, makeRepo, scratch, sh, write } from "./helpers.ts";

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; next?: { command: string }[]; details?: Record<string, unknown> };
}
const envelope = (text: string) => lastJson(text) as Envelope;

test("own options stay with xcslot and everything after them reaches the wrapped command untouched", () => {
  expect(splitWrapped(["xcodebuild", "--products-to", "out", "--no-wait", "-scheme", "App", "build"])).toEqual([
    "xcodebuild",
    "--products-to",
    "out",
    "--no-wait",
    "--",
    "-scheme",
    "App",
    "build",
  ]);
  expect(splitWrapped(["run", "--", "swift", "build"])).toEqual(["run", "--", "swift", "build"]);
  expect(splitWrapped(["run", "swift", "build", "--verbose"])).toEqual(["run", "--", "swift", "build", "--verbose"]);
  expect(splitWrapped(["--json", "status"])).toEqual(["--json", "status"]);
});

test("a command line that does not parse is a usage error whose next command runs as printed", async () => {
  const home = scratch();
  const failed = await cli(["slots", "bogus"], { cwd: home, home });
  expect(failed.code).toBe(101);
  expect(failed.stdout).toBe("");
  const next = envelope(failed.stderr).error?.next?.[0]?.command ?? "";
  expect(next.startsWith("xcslot ")).toBe(true);
  const followed = await cli(next.split(" ").slice(1), { cwd: home, home });
  expect(followed.code).toBe(0);
  expect(envelope(followed.stdout).ok).toBe(true);
});

test("outside a repository a build command fails with not_a_repository", async () => {
  const home = scratch();
  const result = await cli(["run", "--", "true"], { cwd: home, home });
  expect(result.code).toBe(102);
  expect(envelope(result.stderr).error?.code).toBe("not_a_repository");
});

test("a command runs in the slot's copy of the caller's directory and its exit code comes back", async () => {
  const repo = makeRepo({ "ios/App.swift": "let a = 1\n", "README.md": "x" });
  const home = scratch();
  const worktree = addWorktree(repo, "task-1");

  const built = await cli(
    ["run", "--", "sh", "-c", 'echo "$PWD/App.swift:1:5: error: made up"; echo made > Generated.txt; exit 7'],
    {
      cwd: join(worktree, "ios"),
      home,
    },
  );
  expect(built.code).toBe(7);
  expect(built.stdout).toBe(`${worktree}/ios/App.swift:1:5: error: made up\n`);
  expect(readFileSync(join(worktree, "ios/Generated.txt"), "utf8")).toBe("made\n");
  expect(built.stderr).toContain("returned 1 files the command wrote: ios/Generated.txt");
  expect(built.stderr).toMatch(/xcslot: slot 1: sh exited 7 after [\d.]+s; log: /);

  const slots = envelope((await cli(["slots", "list"], { cwd: worktree, home })).stdout);
  expect(slots.data?.repository).toBe(repo);
  expect(slots.data?.slots).toMatchObject([{ n: 1, busy: false, warmFor: worktree }]);

  const logs = readdirSync(join(home, "slots")).filter((name) => name.startsWith("app-"));
  expect(readdirSync(join(home, "slots", logs[0] as string, "logs")).length).toBe(1);
});

test("a second worktree reuses the slot, and a command inside a slot takes no second one", async () => {
  const repo = makeRepo({ "A.swift": "a" });
  const home = scratch();
  const first = addWorktree(repo, "one");
  const second = addWorktree(repo, "two");
  write(second, { "A.swift": "a edited" });

  expect((await cli(["run", "--", "true"], { cwd: first, home })).stderr).toContain("slot 1: synced 0 changed files");
  const reused = await cli(["run", "--", "cat", "A.swift"], { cwd: second, home });
  expect(reused.stdout).toBe("a edited");
  expect(reused.stderr).toContain("slot 1: synced 1 changed files");

  const nested = await cli(["run", "--", "sh", "-c", "echo $XCSLOT_DERIVED_DATA"], {
    cwd: second,
    home,
    env: { XCSLOT_DERIVED_DATA: "/outer/DerivedData" },
  });
  expect(nested.stdout).toBe("/outer/DerivedData\n");
  expect(nested.stderr).toBe("");
});

test("git variables exported by a hook point neither xcslot nor the wrapped command at another repository", async () => {
  const repo = makeRepo({ "A.swift": "a" });
  const bystander = makeRepo({ "B.swift": "b" }, "bystander");
  const home = scratch();
  const worktree = addWorktree(repo, "task-1");
  const hookEnv = { GIT_DIR: join(bystander, ".git"), GIT_INDEX_FILE: join(bystander, ".git/index") };
  const before = headOf(bystander);

  Object.assign(process.env, hookEnv);
  let built: Awaited<ReturnType<typeof cli>>;
  try {
    built = await cli(["run", "--", "git", "rev-parse", "HEAD"], { cwd: worktree, home, env: hookEnv });
  } finally {
    for (const key of Object.keys(hookEnv)) delete process.env[key];
  }

  expect(built.code).toBe(0);
  expect(built.stdout).toBe(`${headOf(worktree)}\n`);
  expect(headOf(bystander)).toBe(before);
  expect(sh(bystander, "git", "status", "--porcelain")).toBe("");
});

test("when every slot is busy the command says who holds them and fails with slots_busy", async () => {
  const repo = makeRepo({ "A.swift": "a" });
  const home = scratch();
  write(home, { "config.json": JSON.stringify({ slots: 1 }) });
  const worktree = addWorktree(repo, "one");
  const holder = cli(["run", "--", "sleep", "3"], { cwd: worktree, home });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const blocked = await cli(["run", "--no-wait", "--", "true"], { cwd: addWorktree(repo, "two"), home });
  expect(blocked.code).toBe(110);
  const error = envelope(blocked.stderr).error;
  expect(error?.code).toBe("slots_busy");
  expect(error?.next?.[0]?.command).toBe("xcslot status");
  expect(JSON.stringify(error?.details)).toContain("sleep 3");

  const status = envelope((await cli(["status"], { cwd: home, home })).stdout);
  expect(JSON.stringify(status.data)).toContain("sleep 3");
  expect((await holder).code).toBe(0);
});

test("removing slots needs --yes and reports what it removed", async () => {
  const repo = makeRepo({ "A.swift": "a" });
  const home = scratch();
  await cli(["run", "--", "true"], { cwd: repo, home });

  const refused = await cli(["slots", "remove", "--all"], { cwd: repo, home });
  expect(refused.code).toBe(112);
  expect(envelope(refused.stderr).error?.code).toBe("confirmation_required");
  expect((await cli(["slots", "remove", "9", "--yes"], { cwd: repo, home })).code).toBe(111);

  const removed = envelope((await cli(["slots", "remove", "1", "--yes"], { cwd: repo, home })).stdout);
  expect(removed.data).toEqual({ removed: [1], busy: [] });
  expect(envelope((await cli(["slots", "list"], { cwd: repo, home })).stdout).data?.slots).toEqual([]);
});

test("an invalid config is reported with the file and the problem", async () => {
  const repo = makeRepo({ "A.swift": "a" });
  const home = scratch();
  write(home, { "config.json": JSON.stringify({ slots: 0, colour: "red" }) });
  const result = await cli(["run", "--", "true"], { cwd: repo, home });
  expect(result.code).toBe(115);
  expect(envelope(result.stderr).error?.details).toEqual({ path: join(home, "config.json") });
});

test("the skill installs where asked, and every command it shows exists with the options it uses", async () => {
  const home = scratch();
  const installed = await cli(["skill", "install", "--dir", join(home, "skills")], { cwd: home, home });
  expect(installed.code).toBe(0);
  expect(readFileSync(join(home, "skills/xcslot/SKILL.md"), "utf8")).toBe(skill);
  expect((await cli(["skill"], { cwd: home, home })).stdout).toBe(skill);

  const catalog = envelope((await cli(["commands"], { cwd: home, home })).stdout).data?.commands as {
    command: string;
    options: { flags: string }[];
  }[];
  const examples = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((block) =>
    (block[1] ?? "").trim().split("\n"),
  );
  expect(examples.length).toBeGreaterThan(4);
  for (const example of examples) {
    const words = example.trim().split(/\s+/);
    expect(words[0]).toBe("xcslot");
    const entry = catalog
      .filter((candidate) => words.slice(1).join(" ").startsWith(candidate.command))
      .sort((a, b) => b.command.length - a.command.length)[0];
    expect(entry, example).toBeDefined();
    const own = splitWrapped(words.slice(1));
    const end = own.includes("--") ? own.indexOf("--") : own.length;
    for (const word of own.slice(0, end).filter((part) => part.startsWith("--"))) {
      const known = word === "--json" || entry?.options.some((option) => option.flags.split(/[ ,]+/).includes(word));
      expect(known, `${word} in: ${example}`).toBe(true);
    }
  }
  expect(existsSync(join(home, "slots"))).toBe(false);
});

test("a Tuist project is generated only for a command that touches it", async () => {
  const repo = makeRepo({
    "app/Tuist.swift": "",
    "app/Project.swift": "",
    "tools/cli/Package.swift": "",
    "bin/tuist": '#!/bin/sh\necho "$@" >> "$TUIST_CALLS"\n',
  });
  chmodSync(join(repo, "bin/tuist"), 0o755);
  const home = scratch();
  const calls = join(home, "tuist-calls");
  const env = { PATH: `${join(repo, "bin")}:${process.env.PATH}`, TUIST_CALLS: calls };
  const generated = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0);

  expect((await cli(["run", "--", "true"], { cwd: join(repo, "tools/cli"), home, env })).code).toBe(0);
  expect(generated()).toBe(0);

  const named = await cli(["run", "--", "ls", "../../app/Project.swift"], { cwd: join(repo, "tools/cli"), home, env });
  expect(named.stderr).toContain("xcslot: tuist generate");
  expect(generated()).toBe(1);

  expect((await cli(["run", "--", "true"], { cwd: join(repo, "app"), home, env })).stderr).toContain("tuist generate");
  expect((await cli(["run", "--", "true"], { cwd: repo, home, env })).stderr).toContain("tuist generate");
  expect(generated()).toBe(3);
});
