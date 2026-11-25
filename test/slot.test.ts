import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { slotPaths } from "../src/lib/layout.ts";
import { systemProcesses } from "../src/lib/proc.ts";
import { holderOf, tryLock, tryPermit, unlock } from "../src/slot/lock.ts";
import { type PrepareStep, prepare } from "../src/slot/prepare.ts";
import { removeSlot, rotateLogs, sweep } from "../src/slot/remove.ts";
import { emptyState, readState, writeState } from "../src/slot/state.ts";
import { syncInto, writeBack } from "../src/slot/sync.ts";
import { debuggableBinaries } from "../src/xcodebuild/handout.ts";
import { addWorktree, fakeProcesses, headOf, lockEnvFor, makeRepo, scratch, sh, write } from "./helpers.ts";

test("a lock has one holder, survives nothing but its owner, and is reclaimed when the owner is gone", () => {
  const dir = join(scratch(), "lock");
  const alive: Record<number, string> = { 10: "Mon 1", 20: "Mon 2" };
  const first = lockEnvFor(10, fakeProcesses(alive));
  const second = lockEnvFor(20, fakeProcesses(alive));
  expect(tryLock(dir, "build A", first)).toBe(true);
  expect(tryLock(dir, "build B", second)).toBe(false);
  expect(holderOf(dir, second)?.label).toBe("build A");
  unlock(dir, second);
  expect(holderOf(dir, second)?.pid).toBe(10);

  delete alive[10];
  expect(holderOf(dir, second)).toBeUndefined();
  expect(tryLock(dir, "build B", second)).toBe(true);
  expect(holderOf(dir, first)?.label).toBe("build B");
});

test("a reused pid with another start time does not keep a dead owner's lock", () => {
  const dir = join(scratch(), "lock");
  expect(tryLock(dir, "old", lockEnvFor(10, fakeProcesses({ 10: "Mon 1" })))).toBe(true);
  expect(tryLock(dir, "new", lockEnvFor(20, fakeProcesses({ 10: "Tue 9", 20: "Tue 9" })))).toBe(true);
});

test("a process's start time reads the same in every time zone and locale", () => {
  const proc = join(import.meta.dir, "../src/lib/proc.ts");
  const script = `const { systemProcesses } = await import(${JSON.stringify(proc)}); console.log(systemProcesses.startOf(${process.pid}))`;
  const read = (TZ: string, LC_ALL: string) =>
    Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, TZ, LC_ALL } }).stdout.toString();
  expect(read("Pacific/Auckland", "de_DE.UTF-8")).toBe(read("UTC", "C"));
});

test("a lock written by xcslot 0.1.4, with its owner's local start time, still counts as held", () => {
  const dir = join(scratch(), "lock");
  mkdirSync(dir);
  const started = systemProcesses.localStartOf?.(process.pid) as string;
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, started, label: "old", since: 1 }));
  const reader = { pid: 1, processes: systemProcesses, now: () => Date.now() };
  expect(holderOf(dir, reader)?.label).toBe("old");
  expect(tryLock(dir, "new", reader)).toBe(false);
});

test("two callers taking over the same dead lock end with one holder", () => {
  const dir = join(scratch(), "lock");
  expect(tryLock(dir, "dead", lockEnvFor(10, fakeProcesses({ 10: "Mon 1" })))).toBe(true);
  const alive: Record<number, string> = { 20: "Mon 2", 30: "Mon 3" };
  let aGot = false;
  let interleaved = false;
  // B's first look at the dead owner lets A take the lock over in between.
  const b = lockEnvFor(20, {
    startOf: (pid) => {
      if (pid === 10 && !interleaved) {
        interleaved = true;
        aGot = tryLock(dir, "A", lockEnvFor(30, fakeProcesses(alive)));
      }
      return alive[pid];
    },
  });
  const bGot = tryLock(dir, "B", b);
  expect({ aGot, bGot }).toEqual({ aGot: true, bGot: false });
  expect(holderOf(dir, b)?.label).toBe("A");
});

test("a breaker owns its guard while it checks the dead lock, so a pause cannot let anyone take the guard", () => {
  const dir = join(scratch(), "lock");
  expect(tryLock(dir, "dead", lockEnvFor(10, fakeProcesses({ 10: "Mon 1" })))).toBe(true);
  let guardOwner: number | undefined;
  const b = lockEnvFor(20, {
    startOf: (pid) => {
      const guard = join(`${dir}.breaking`, "owner.json");
      if (pid === 10 && existsSync(guard)) guardOwner = JSON.parse(readFileSync(guard, "utf8")).pid;
      return pid === 20 ? "Mon 2" : undefined;
    },
  });
  expect(tryLock(dir, "B", b)).toBe(true);
  expect(guardOwner).toBe(20);
  expect(existsSync(`${dir}.breaking`)).toBe(false);
});

test("the binaries that get dSYMs include plain ones at the folder's root and in nested bundles", () => {
  const products = scratch();
  const machO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
  for (const path of ["tool", "Debug/lib.dylib", "App.app/App", "App.app/PlugIns/Ext.appex/Ext"]) {
    write(products, { [path]: "" });
    writeFileSync(join(products, path), machO);
  }
  write(products, { readme: "text", "App.app/Info.plist": "plist" });
  expect(
    debuggableBinaries(products)
      .map((path) => path.slice(products.length + 1))
      .sort(),
  ).toEqual(["App.app/App", "App.app/PlugIns/Ext.appex/Ext", "Debug/lib.dylib", "tool"]);
});

test("a lock folder without an owner is taken over only after the grace period", () => {
  const dir = join(scratch(), "lock");
  mkdirSync(dir);
  const clock = { now: Date.now() };
  const env = lockEnvFor(20, fakeProcesses({ 20: "Mon 2" }), clock);
  expect(tryLock(dir, "new", env)).toBe(false);
  clock.now += 11_000;
  expect(tryLock(dir, "new", env)).toBe(true);
});

test("permits cap how many commands run at once", () => {
  const permits = join(scratch(), "permits");
  const processes = fakeProcesses({ 1: "a", 2: "b", 3: "c" });
  const one = tryPermit(permits, 2, "one", lockEnvFor(1, processes));
  expect(one).toBeDefined();
  expect(tryPermit(permits, 2, "two", lockEnvFor(2, processes))).toBeDefined();
  expect(tryPermit(permits, 2, "three", lockEnvFor(3, processes))).toBeUndefined();
  unlock(one as string, lockEnvFor(1, processes));
  expect(tryPermit(permits, 2, "three", lockEnvFor(3, processes))).toBeDefined();
});

function slotFor(repo: string) {
  const slot = slotPaths(join(scratch(), "slots"), 1);
  mkdirSync(slot.dir, { recursive: true });
  sh(repo, "git", "worktree", "add", "-q", "--detach", slot.src, "HEAD");
  return slot;
}

const OLD = new Date("2020-01-01T00:00:00Z");

test("sync rewrites only files whose content differs, so every other file keeps its mtime", () => {
  const repo = makeRepo({ "A.swift": "a", "B.swift": "b", "Dir/C.swift": "c", ".gitignore": "*.xcconfig\nbuild/\n" });
  const slot = slotFor(repo);
  for (const name of ["A.swift", "B.swift", "Dir/C.swift"]) utimesSync(join(slot.src, name), OLD, OLD);

  const fresh = addWorktree(repo, "fresh");
  write(fresh, { "B.swift": "b changed", "New.swift": "n", "Local.xcconfig": "X = 1", "build/out.o": "ignored" });
  write(fresh, { "out/Products/.xcslot-products": "", "out/Products/Debug/App.app/App": "binary" });
  sh(fresh, "rm", "Dir/C.swift");
  symlinkSync("A.swift", join(fresh, "Link.swift"));
  mkdirSync(join(fresh, "nested"));
  sh(join(fresh, "nested"), "git", "init", "-q");
  write(join(fresh, "nested"), { "x.txt": "x" });

  const state = emptyState();
  const result = syncInto(fresh, headOf(fresh), slot.src, state, ["*.xcconfig"])._unsafeUnwrap();
  expect(result).toEqual({ files: 6, changed: 4, removed: 1 });
  expect(lstatSync(join(slot.src, "A.swift")).mtime).toEqual(OLD);
  expect(lstatSync(join(slot.src, "B.swift")).mtime).not.toEqual(OLD);
  expect(readFileSync(join(slot.src, "B.swift"), "utf8")).toBe("b changed");
  expect(readFileSync(join(slot.src, "Local.xcconfig"), "utf8")).toBe("X = 1");
  expect(readlinkSync(join(slot.src, "Link.swift"))).toBe("A.swift");
  expect(existsSync(join(slot.src, "Dir/C.swift"))).toBe(false);
  expect(existsSync(join(slot.src, "build/out.o"))).toBe(false);
  expect(existsSync(join(slot.src, "nested"))).toBe(false);
  expect(existsSync(join(slot.src, "out"))).toBe(false);

  const again = syncInto(fresh, headOf(fresh), slot.src, state, ["*.xcconfig"])._unsafeUnwrap();
  expect(again).toEqual({ files: 6, changed: 0, removed: 0 });

  sh(fresh, "rm", "Local.xcconfig");
  expect(syncInto(fresh, headOf(fresh), slot.src, state, ["*.xcconfig"])._unsafeUnwrap().removed).toBe(1);
  expect(existsSync(join(slot.src, "Local.xcconfig"))).toBe(false);
});

test("sync follows a path changing kind, a case-only rename and a mode change, and never writes outside the slot", () => {
  const outside = scratch();
  writeFileSync(join(outside, "a.txt"), "keep");
  const repo = makeRepo({ "A.swift": "a", "gen.sh": "echo", foo: "file", "dir/x": "x" });
  const slot = slotFor(repo);
  const fresh = addWorktree(repo, "fresh");
  symlinkSync(outside, join(fresh, "lib"));
  const state = emptyState();
  syncInto(fresh, headOf(fresh), slot.src, state, [])._unsafeUnwrap();
  expect(readlinkSync(join(slot.src, "lib"))).toBe(outside);
  utimesSync(join(slot.src, "gen.sh"), OLD, OLD);

  sh(fresh, "rm", "lib", "foo");
  sh(fresh, "rm", "-r", "dir");
  write(fresh, { "lib/a.txt": "new", "foo/bar": "bar", dir: "now a file" });
  sh(fresh, "git", "mv", "A.swift", "a.swift");
  sh(fresh, "chmod", "+x", "gen.sh");
  syncInto(fresh, headOf(fresh), slot.src, state, [])._unsafeUnwrap();

  expect(readFileSync(join(outside, "a.txt"), "utf8")).toBe("keep");
  expect(readFileSync(join(slot.src, "lib/a.txt"), "utf8")).toBe("new");
  expect(readFileSync(join(slot.src, "foo/bar"), "utf8")).toBe("bar");
  expect(readFileSync(join(slot.src, "dir"), "utf8")).toBe("now a file");
  expect(readdirSync(slot.src).filter((name) => name.toLowerCase() === "a.swift")).toEqual(["a.swift"]);
  expect(readFileSync(join(slot.src, "a.swift"), "utf8")).toBe("a");
  expect(lstatSync(join(slot.src, "gen.sh")).mode & 0o111).not.toBe(0);
  expect(lstatSync(join(slot.src, "gen.sh")).mtime).toEqual(OLD);

  expect(syncInto(fresh, headOf(fresh), slot.src, state, [])._unsafeUnwrap()).toMatchObject({ changed: 0, removed: 0 });
});

test("files a command wrote in the slot return to the worktree; a file both sides changed is left alone", () => {
  const repo = makeRepo({ "A.swift": "a", "Package.resolved": "{}", "Edited.swift": "e" });
  const slot = slotFor(repo);
  const fresh = addWorktree(repo, "fresh");
  const state = emptyState();
  syncInto(fresh, headOf(fresh), slot.src, state, [])._unsafeUnwrap();

  write(slot.src, {
    "Tests/__Snapshots__/ref.txt": "recorded",
    "Package.resolved": '{"pins":1}',
    "Edited.swift": "by build",
  });
  write(fresh, { "Edited.swift": "by agent" });

  const back = writeBack(slot.src, state)._unsafeUnwrap();
  expect(back.returned.sort()).toEqual(["Package.resolved", "Tests/__Snapshots__/ref.txt"]);
  expect(back.conflicts).toEqual(["Edited.swift"]);
  expect(readFileSync(join(fresh, "Tests/__Snapshots__/ref.txt"), "utf8")).toBe("recorded");
  expect(readFileSync(join(fresh, "Package.resolved"), "utf8")).toBe('{"pins":1}');
  expect(readFileSync(join(fresh, "Edited.swift"), "utf8")).toBe("by agent");

  const before = lstatSync(join(slot.src, "Package.resolved")).mtimeMs;
  expect(syncInto(fresh, headOf(fresh), slot.src, state, [])._unsafeUnwrap().changed).toBe(1);
  expect(lstatSync(join(slot.src, "Package.resolved")).mtimeMs).toBe(before);
  expect(readFileSync(join(slot.src, "Edited.swift"), "utf8")).toBe("by agent");
});

test("a prepare step runs when its inputs change, and unchanged generated files keep their mtime", async () => {
  const root = scratch();
  write(root, { "project.yml": "v1" });
  const runs: string[] = [];
  const step: PrepareStep = {
    name: "generate",
    argv: ["gen"],
    cwd: root,
    inputs: [join(root, "project.yml")],
    outputs: ["*.proj"],
  };
  const generate = async () => {
    runs.push("gen");
    write(root, {
      "App.proj/stable.txt": "same",
      "App.proj/derived.txt": readFileSync(join(root, "project.yml"), "utf8"),
    });
    return 0;
  };
  const state = emptyState();
  const log = { write: () => {} };
  expect((await prepare([step], state, generate, log))._unsafeUnwrap()).toEqual(["generate"]);
  expect((await prepare([step], state, generate, log))._unsafeUnwrap()).toEqual([]);

  for (const name of ["stable.txt", "derived.txt"]) utimesSync(join(root, "App.proj", name), OLD, OLD);
  writeFileSync(join(root, "project.yml"), "v2");
  expect((await prepare([step], state, generate, log))._unsafeUnwrap()).toEqual(["generate"]);
  expect(lstatSync(join(root, "App.proj/stable.txt")).mtime).toEqual(OLD);
  expect(lstatSync(join(root, "App.proj/derived.txt")).mtime).not.toEqual(OLD);
  expect(runs.length).toBe(2);

  const failed = await prepare([{ ...step, name: "broken" }], state, async () => 3, log);
  expect(failed._unsafeUnwrapErr().code).toBe("prepare_failed");
  expect(failed._unsafeUnwrapErr().details).toEqual({ step: "broken", exitCode: 3 });
});

test("housekeeping removes slots of deleted repositories and idle extra slots, never a held one", () => {
  const root = join(scratch(), "slots");
  const repo = makeRepo({ "A.swift": "a" });
  const day = 24 * 60 * 60 * 1000;
  const clock = { now: Date.now() };
  const env = lockEnvFor(1, fakeProcesses({ 1: "a", 2: "b" }), clock);
  const make = (repoDir: string, main: string, n: number, usedAt: number) => {
    const slot = slotPaths(repoDir, n);
    mkdirSync(slot.src, { recursive: true });
    writeFileSync(join(repoDir, "repo.json"), JSON.stringify({ main }));
    writeState(slot.state, { ...emptyState(), usedAt });
    return slot;
  };
  const live = join(root, "app-11111111");
  const gone = join(root, "old-22222222");
  make(live, repo, 1, clock.now - 3 * day);
  make(live, repo, 4, clock.now - 2 * day);
  make(live, repo, 5, clock.now - 1000);
  const held = make(live, repo, 6, clock.now - 2 * day);
  tryLock(held.lock, "building", lockEnvFor(2, fakeProcesses({ 1: "a", 2: "b" }), clock));
  make(gone, join(scratch(), "deleted-repo"), 1, clock.now);

  const swept = sweep(root, 3, env);
  expect(existsSync(slotPaths(live, 1).dir)).toBe(true);
  expect(existsSync(slotPaths(live, 4).dir)).toBe(false);
  expect(existsSync(slotPaths(live, 5).dir)).toBe(true);
  expect(existsSync(held.dir)).toBe(true);
  expect(existsSync(gone)).toBe(false);
  expect(swept.orphanedRepos).toEqual([gone]);
  expect(swept.expiredSlots).toEqual([slotPaths(live, 4).dir]);

  make(live, repo, 7, clock.now - 2 * day);
  sweep(root, 3, env);
  expect(existsSync(slotPaths(live, 7).dir)).toBe(true);
  clock.now += day + 1;
  sweep(root, 3, env);
  expect(existsSync(slotPaths(live, 7).dir)).toBe(false);

  expect(removeSlot(held, repo, env)).toBe(false);
  expect(readState(slotPaths(live, 1).state).usedAt).toBeDefined();
});

test("only the newest logs are kept", () => {
  const repoDir = scratch();
  for (let i = 10; i < 25; i++) write(repoDir, { [`logs/2026-01-${i}.log`]: "x" });
  rotateLogs(repoDir, 10);
  const kept = sh(repoDir, "ls", "logs").trim().split("\n");
  expect(kept.length).toBe(10);
  expect(kept[0]).toBe("2026-01-15.log");
});

test("a step that rewrites its own input is done for the input it was given and for the one it left", async () => {
  const root = scratch();
  write(root, { "deps.lock": "resolved by someone else" });
  const step: PrepareStep = {
    name: "resolve",
    argv: ["resolve"],
    cwd: root,
    inputs: [join(root, "deps.lock")],
    outputs: [],
  };
  let runs = 0;
  const resolve = async () => {
    runs++;
    writeFileSync(join(root, "deps.lock"), "resolved here");
    return 0;
  };
  const state = emptyState();
  const log = { write: () => {} };
  expect((await prepare([step], state, resolve, log))._unsafeUnwrap()).toEqual(["resolve"]);
  expect((await prepare([step], state, resolve, log))._unsafeUnwrap()).toEqual([]);

  // The next worktree still holds the lock file as it was committed.
  writeFileSync(join(root, "deps.lock"), "resolved by someone else");
  expect((await prepare([step], state, resolve, log))._unsafeUnwrap()).toEqual([]);

  writeFileSync(join(root, "deps.lock"), "a new dependency");
  expect((await prepare([step], state, resolve, log))._unsafeUnwrap()).toEqual(["resolve"]);
  expect(runs).toBe(2);
});
