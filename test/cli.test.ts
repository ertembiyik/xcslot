import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import skill from "../skills/xcslot/SKILL.md" with { type: "text" };
import { splitWrapped } from "../src/run.ts";
import { addWorktree, cli, headOf, lastJson, makeRepo, scratch, sh, write } from "./helpers.ts";

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; next?: { command: string }[]; details?: Record<string, unknown> };
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

test("xcodebuild sees the same environment from every worktree and agent session, so Xcode keeps its build plan", async () => {
  const repo = makeRepo({ "A.swift": "a" });
  const second = addWorktree(repo, "two");
  const home = scratch();
  const bin = join(scratch(), "bin");
  // A file, not stdout: xcslot maps slot paths in the output back to the worktree.
  write(bin, { xcodebuild: ["#!/bin/sh", 'env | sort > "$HOME/env.txt"'].join("\n") });
  chmodSync(join(bin, "xcodebuild"), 0o755);
  const session = (id: string, from: string) => ({
    PATH: `${bin}:${process.env.PATH}`,
    PWD: from,
    OLDPWD: `/elsewhere/${id}`,
    SHLVL: id,
    TERM_SESSION_ID: id,
    CLAUDE_CODE_SESSION_ID: id,
    CODEX_THREAD_ID: id,
    KEEP_ME: "1",
  });

  const seen = async (from: string, id: string) => {
    expect((await cli(["xcodebuild", "build"], { cwd: from, home, env: session(id, from) })).code).toBe(0);
    return readFileSync(join(home, "env.txt"), "utf8");
  };
  const first = await seen(repo, "1");
  expect(await seen(second, "2")).toBe(first);
  expect(first).toContain("KEEP_ME=1\n");
  expect(first).toMatch(/^PWD=.*\/1\/src$/m);
  expect(first).not.toMatch(/^(OLDPWD|TERM_SESSION_ID|CLAUDE_|CODEX_|XCSLOT_WORKTREE)/m);

  const run = await cli(["run", "--", "sh", "-c", "echo $XCSLOT_WORKTREE"], { cwd: second, home });
  expect(run.stdout).toBe(`${second}\n`);
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

const gitAs = (cwd: string, ...args: string[]) =>
  sh(
    cwd,
    "git",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    ...args,
  );

test("a submodule's files are mirrored, and a slots folder deleted by hand is set up again", async () => {
  const sub = makeRepo({ "S.swift": "from the submodule" }, "sub");
  const repo = makeRepo({ "A.swift": "a" });
  gitAs(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "Vendor/sub");
  gitAs(repo, "commit", "-q", "-m", "submodule");
  const worktree = addWorktree(repo, "task-1");
  gitAs(worktree, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
  const home = scratch();

  write(worktree, { "Vendor/sub/New.swift": " and a new file" });
  const built = await cli(["run", "--", "cat", "Vendor/sub/S.swift", "Vendor/sub/New.swift"], { cwd: worktree, home });
  expect(built.stdout).toBe("from the submodule and a new file");
  expect(built.code).toBe(0);

  rmSync(join(home, "slots"), { recursive: true });
  const again = await cli(["run", "--", "cat", "A.swift"], { cwd: worktree, home });
  expect(again.stdout).toBe("a");
  expect(again.code).toBe(0);
});

test("a bare repository's worktree builds, --from may be a symlink, and a repository needs a first commit", async () => {
  const repo = makeRepo({ "ios/App.swift": "app" });
  const bare = join(scratch(), "proj.git");
  sh(repo, "git", "clone", "-q", "--bare", repo, bare);
  const worktree = join(dirname(bare), "wt");
  sh(bare, "git", "worktree", "add", "-q", worktree, "main");
  const home = scratch();

  const built = await cli(["run", "--", "cat", "ios/App.swift"], { cwd: worktree, home });
  expect(built.stdout).toBe("app");
  expect(built.code).toBe(0);

  const link = join(scratch(), "link");
  symlinkSync(worktree, link);
  const viaLink = await cli(["run", "--from", join(link, "ios"), "--", "pwd"], { cwd: home, home });
  expect(viaLink.stdout).toBe(`${join(worktree, "ios")}\n`);

  const empty = join(scratch(), "empty");
  mkdirSync(empty);
  sh(empty, "git", "init", "-q");
  const unborn = await cli(["run", "--", "true"], { cwd: empty, home });
  expect(unborn.code).toBe(101);
  expect(envelope(unborn.stderr).error?.message).toContain("has no commit yet");
});

test("a folder sync cannot read fails as sync_failed, not as an internal error", async () => {
  const repo = makeRepo({ "Locked/A.swift": "a" });
  const worktree = addWorktree(repo, "task-1");
  chmodSync(join(worktree, "Locked"), 0o000);
  try {
    const built = await cli(["run", "--", "true"], { cwd: worktree, home: scratch() });
    expect(envelope(built.stderr).error?.code).toBe("sync_failed");
  } finally {
    chmodSync(join(worktree, "Locked"), 0o755);
  }
});

// Clones products with `cp -c`, which only macOS has.
test.skipIf(process.platform !== "darwin")(
  "products land where the caller asked: a build setting, a used DerivedData, a --products-to checked first",
  async () => {
    const repo = makeRepo({ "A.swift": "a", ".gitignore": "out/\ndd/\n" });
    const worktree = addWorktree(repo, "task-1");
    const home = scratch();
    const bin = join(scratch(), "bin");
    write(bin, {
      xcodebuild: [
        "#!/bin/sh",
        "echo ran",
        "while [ $# -gt 0 ]; do",
        '  case "$1" in',
        '    -derivedDataPath) mkdir -p "$2/Build/Products/Debug" && echo built > "$2/Build/Products/Debug/App"; shift ;;',
        '    -resultBundlePath) mkdir -p "$2"; shift ;;',
        '    SYMROOT=*) d="${1#SYMROOT=}/Debug"; rm -rf "$d/App.app"; mkdir -p "$d/App.app"; echo built > "$d/App";',
        '      echo plist > "$d/App.app/Info.plist"; [ -n "$RESOURCE" ] && echo r > "$d/App.app/Resource" ;;',
        "  esac",
        "  shift",
        "done",
        '[ -n "$CALLER_EDIT" ] && mkdir -p "$(dirname "$CALLER_EDIT")" && echo caller > "$CALLER_EDIT"',
        "true",
      ].join("\n"),
    });
    chmodSync(join(bin, "xcodebuild"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };

    const withResource = { ...env, RESOURCE: "1" };
    const viaSetting = await cli(["xcodebuild", `SYMROOT=${worktree}/out`, "build"], {
      cwd: worktree,
      home,
      env: withResource,
    });
    expect(viaSetting.code).toBe(0);
    expect(readFileSync(join(worktree, "out/Debug/App"), "utf8")).toBe("built\n");
    expect(existsSync(join(worktree, "out/Debug/App.app/Resource"))).toBe(true);
    write(worktree, { "out/Debug/Notes.txt": "mine" });
    const rebuilt = await cli(["xcodebuild", `SYMROOT=${worktree}/out`, "build"], { cwd: worktree, home, env });
    expect(rebuilt.code).toBe(0);
    expect(existsSync(join(worktree, "out/Debug/App.app/Resource"))).toBe(false);
    expect(readFileSync(join(worktree, "out/Debug/Notes.txt"), "utf8")).toBe("mine");

    const nothingBuilt = await cli(["xcodebuild", `DSTROOT=${worktree}/dst`, "build"], { cwd: worktree, home, env });
    expect(nothingBuilt.code).toBe(0);

    const callerEdit = { ...env, CALLER_EDIT: join(worktree, "shared/Debug/App") };
    const both = await cli(["xcodebuild", `SYMROOT=${worktree}/shared`, "build"], {
      cwd: worktree,
      home,
      env: callerEdit,
    });
    expect(both.code).toBe(0);
    expect(both.stderr).toContain("left alone");
    expect(readFileSync(join(worktree, "shared/Debug/App"), "utf8")).toBe("caller\n");

    const gitFile = readFileSync(join(worktree, ".git"), "utf8");
    write(worktree, { "A.swift": "edited during the build" });
    const intoSources = await cli(["xcodebuild", `SYMROOT=${worktree}`, "build"], { cwd: worktree, home, env });
    expect(intoSources.code).toBe(0);
    expect(readFileSync(join(worktree, ".git"), "utf8")).toBe(gitFile);
    expect(readFileSync(join(worktree, "A.swift"), "utf8")).toBe("edited during the build");

    write(worktree, { "dd/Build/Products/Old/Stale": "from a plain xcodebuild" });
    const intoUsed = await cli(["xcodebuild", "-derivedDataPath", "dd", "build"], { cwd: worktree, home, env });
    expect(intoUsed.code).toBe(0);
    expect(readFileSync(join(worktree, "dd/Build/Products/Debug/App"), "utf8")).toBe("built\n");
    expect(readFileSync(join(worktree, "dd/Build/Products/Old/Stale"), "utf8")).toBe("from a plain xcodebuild");

    const filledDuring = await cli(
      ["xcodebuild", "--products-to", "fresh", "-resultBundlePath", "fresh/Result.xcresult", "build"],
      { cwd: worktree, home, env },
    );
    expect(filledDuring.code).toBe(101);
    expect(existsSync(join(worktree, "fresh/Result.xcresult"))).toBe(true);

    write(worktree, { "taken/mine.txt": "keep" });
    const refused = await cli(["xcodebuild", "--products-to", "taken", "build"], { cwd: worktree, home, env });
    expect(refused.code).toBe(101);
    expect(refused.stdout).toBe("");
    expect(readFileSync(join(worktree, "taken/mine.txt"), "utf8")).toBe("keep");
  },
);

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

test("a build past maxConcurrent waits for a permit, unless --slots asks for that many at once", async () => {
  const repo = makeRepo({ "A.swift": "a" });
  const home = scratch();
  write(home, { "config.json": JSON.stringify({ slots: 2, maxConcurrent: 1 }) });
  const holder = cli(["run", "--", "sleep", "3"], { cwd: addWorktree(repo, "one"), home });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const capped = await cli(["run", "--no-wait", "--", "true"], { cwd: addWorktree(repo, "two"), home });
  expect(capped.code).toBe(110);
  expect(envelope(capped.stderr).error?.message).toContain("maxConcurrent: 1");
  const asked = await cli(["run", "--no-wait", "--slots", "2", "--", "true"], {
    cwd: addWorktree(repo, "three"),
    home,
  });
  expect(asked.code).toBe(0);
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

function mixedTuistRepo() {
  const repo = makeRepo({
    "Tuist.swift": "",
    "Tuist/Package.swift": "",
    "Packages/Example/Package.swift": "",
    "Packages/Example/Sources/Example.swift": "",
    "Packages/Example/App/Project.swift": "",
    ".xcslot.json": JSON.stringify({
      prepare: [{ name: "custom setup", run: ["/bin/sh", "-c", "echo custom"], inputs: ["Tuist.swift"] }],
    }),
    "bin/tuist": '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TUIST_CALLS"\n',
    "bin/xcodebuild": '#!/bin/sh\nprintf "%s\\n" "$@"\n',
  });
  chmodSync(join(repo, "bin/tuist"), 0o755);
  chmodSync(join(repo, "bin/xcodebuild"), 0o755);
  const home = scratch();
  const calls = join(home, "tuist-calls");
  const cwd = join(repo, "Packages/Example");
  const env = { PATH: `${join(repo, "bin")}:${process.env.PATH}`, TUIST_CALLS: calls };
  return { repo, home, calls, cwd, env };
}

test("both wrappers skip root Tuist preparation inside a standalone package and still run custom steps", async () => {
  const { home, calls, cwd, env } = mixedTuistRepo();
  const build = await cli(["xcodebuild", "-scheme", "Example-Package", "test"], { cwd, home, env });
  expect(build.code).toBe(0);
  expect(build.stdout).toContain("Example-Package");
  expect(build.stderr).toContain("xcslot: custom setup");
  expect(existsSync(calls)).toBe(false);

  const run = await cli(["run", "--", "cat", "./Example.swift"], { cwd: join(cwd, "Sources"), home, env });
  expect(run.code).toBe(0);
  expect(existsSync(calls)).toBe(false);
});

test("explicit command paths outside the package keep Tuist preparation", async () => {
  const { repo, cwd, env } = mixedTuistRepo();
  const cases = [
    ["xcodebuild", "-workspace", "../../App.xcworkspace", "build"],
    ["xcodebuild", "-project", "../../App=Enterprise.xcodeproj", "build"],
    ["xcodebuild", "-project", join(repo, "App.xcodeproj"), "build"],
    ["xcodebuild", "-workspace", join(scratch(), "Other.xcworkspace"), "build"],
    ["run", "--", "true", "--package-path=../.."],
  ];
  for (const args of cases) {
    const result = await cli(args, { cwd, home: scratch(), env });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("xcslot: tuist generate");
  }
});

test("a Tuist manifest takes precedence over an ancestor package manifest", async () => {
  const { repo, cwd, env } = mixedTuistRepo();
  write(repo, { "Package.swift": "" });
  for (const directory of [repo, join(repo, "Tuist"), join(cwd, "App")]) {
    const result = await cli(["run", "--", "true"], { cwd: directory, home: scratch(), env });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("xcslot: tuist install");
    expect(result.stderr).toContain("xcslot: tuist generate");
  }
});

test("a deleted package manifest does not stop Tuist preparation", async () => {
  const { cwd, home, env } = mixedTuistRepo();
  rmSync(join(cwd, "Package.swift"));
  const result = await cli(["run", "--", "true"], { cwd, home, env });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("xcslot: tuist generate");
});

test("a named Xcode target beneath a nearer Tuist manifest keeps preparation", async () => {
  const { cwd, env } = mixedTuistRepo();
  for (const target of [
    ["-project", "App/App.xcodeproj"],
    ["-workspace", "App/App.xcworkspace"],
  ]) {
    const result = await cli(["xcodebuild", ...target, "build"], { cwd, home: scratch(), env });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("xcslot: tuist generate");
  }
});

test("a symlink that leads outside a standalone package keeps Tuist preparation for a not-yet-generated target", async () => {
  const { repo, cwd, home, env } = mixedTuistRepo();
  write(repo, { "App/Project.swift": "" });
  symlinkSync("../../App", join(cwd, "AppLink"));
  expect(existsSync(join(cwd, "AppLink/App.xcodeproj"))).toBe(false);
  const result = await cli(["xcodebuild", "-project", "AppLink/App.xcodeproj", "build"], { cwd, home, env });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("xcslot: tuist generate");
});

test("a package-local symlink does not trigger unnecessary Tuist preparation", async () => {
  const { cwd, home, env, calls } = mixedTuistRepo();
  symlinkSync("Sources", join(cwd, "SourceLink"));
  const result = await cli(["run", "--", "cat", "SourceLink/Example.swift"], { cwd, home, env });
  expect(result.code).toBe(0);
  expect(existsSync(calls)).toBe(false);
});

test("the parent of a symlink destination is checked before deciding to skip Tuist", async () => {
  const { repo, cwd, home, env } = mixedTuistRepo();
  write(repo, { "App/Deep/source.swift": "" });
  symlinkSync("../../App/Deep", join(cwd, "AppLink"));
  const result = await cli(["xcodebuild", "-project", "AppLink/../App.xcodeproj", "build"], { cwd, home, env });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("xcslot: tuist generate");
});

test("an explicit Xcode project without a nearer Tuist manifest still skips Tuist", async () => {
  const { cwd, home, env, calls } = mixedTuistRepo();
  write(cwd, { "Sources/Example.xcodeproj/project.pbxproj": "" });
  const result = await cli(["xcodebuild", "-project", "Sources/Example.xcodeproj", "build"], { cwd, home, env });
  expect(result.code).toBe(0);
  expect(existsSync(calls)).toBe(false);
});

test("trailing slashes do not hide a dangling project symlink from Tuist preparation", async () => {
  const { repo, cwd, env } = mixedTuistRepo();
  write(repo, { "App/Project.swift": "" });
  symlinkSync("../../App/App.xcodeproj", join(cwd, "Example.xcodeproj"));
  for (const target of ["Example.xcodeproj/", "Example.xcodeproj///"]) {
    const result = await cli(["xcodebuild", "-project", target, "build"], { cwd, home: scratch(), env });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("xcslot: tuist generate");
  }
});

test("a package-local project through a symlink with trailing slashes still skips Tuist", async () => {
  const { cwd, home, env, calls } = mixedTuistRepo();
  write(cwd, { "Sources/Example.xcodeproj/project.pbxproj": "" });
  symlinkSync("Sources/Example.xcodeproj", join(cwd, "Example.xcodeproj"));
  const result = await cli(["xcodebuild", "-project", "Example.xcodeproj/", "build"], { cwd, home, env });
  expect(result.code).toBe(0);
  expect(existsSync(calls)).toBe(false);
});

test("a bare dangling symlink to a Tuist output keeps preparation", async () => {
  const { cwd, home, repo, env } = mixedTuistRepo();
  symlinkSync("../../Derived/Generated.swift", join(cwd, "Generated.swift"));
  write(repo, {
    "bin/tuist":
      '#!/bin/sh\nif [ "$1" = generate ]; then mkdir -p Derived; echo generated > Derived/Generated.swift; fi\n',
  });
  const result = await cli(["run", "--", "cat", "Generated.swift"], { cwd, home, env });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("generated\n");
  expect(result.stderr).toContain("xcslot: tuist generate");
});

test("a bare symlink that stays inside a standalone package still skips Tuist", async () => {
  const { cwd, home, env, calls } = mixedTuistRepo();
  write(cwd, { "Sources/Example.swift": "package-local\n" });
  symlinkSync("Sources/Example.swift", join(cwd, "Local.swift"));
  const result = await cli(["run", "--", "cat", "Local.swift"], { cwd, home, env });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("package-local\n");
  expect(existsSync(calls)).toBe(false);
});

test("non-path xcodebuild arguments are not mistaken for bare symlink operands", async () => {
  const { cwd, home, env, calls } = mixedTuistRepo();
  symlinkSync("../../Derived/Generated.swift", join(cwd, "Example-Package"));
  const result = await cli(["xcodebuild", "-scheme", "Example-Package", "test"], { cwd, home, env });
  expect(result.code).toBe(0);
  expect(existsSync(calls)).toBe(false);
});

test("a PATH-search command is not mistaken for a same-named link in the package", async () => {
  const { cwd, home, env, calls } = mixedTuistRepo();
  symlinkSync("../../Derived/Generated.swift", join(cwd, "true"));
  const result = await cli(["run", "--", "true"], { cwd, home, env });
  expect(result.code).toBe(0);
  expect(existsSync(calls)).toBe(false);
});
