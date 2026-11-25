import { expect, test } from "bun:test";
import { errorCodes, exitCodes, retryable } from "../src/lib/errors.ts";
import { nextCommand, READ_ONLY_COMMANDS, shellQuote } from "../src/lib/next.ts";
import { catalog } from "../src/commands/misc.ts";
import { createProgram } from "../src/run.ts";
import { rewriteArgs, needsNoProject } from "../src/xcodebuild/args.ts";
import { createPathMapper, pumpLines } from "../src/xcodebuild/output-map.ts";
import { orderSlots } from "../src/slot/select.ts";
import { emptyState } from "../src/slot/state.ts";
import { systemProcesses } from "../src/lib/proc.ts";

const program = () =>
  createProgram(
    {
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      stdoutIsTTY: false,
      env: {},
      cwd: "/",
      home: "/",
      version: "0",
      pid: 1,
      processes: systemProcesses,
      now: () => 0,
      sleep: async () => {},
    },
    { exitCode: 0 },
  );

test("every error code has its own exit code outside the range a wrapped command uses", () => {
  const codes = errorCodes.map((code) => exitCodes[code]);
  expect(new Set(codes).size).toBe(errorCodes.length);
  for (const code of codes) expect(code >= 100 && code < 126).toBe(true);
  expect(Object.keys(retryable).sort()).toEqual([...errorCodes].sort());
});

test("every error a command declares is a known code, and every command is in the catalog", () => {
  const entries = catalog(program());
  expect(entries.map((entry) => entry.command).sort()).toEqual(
    [
      "commands",
      "doctor",
      "run",
      "skill install",
      "skill print",
      "slots list",
      "slots prune",
      "slots remove",
      "status",
      "xcodebuild",
    ].sort(),
  );
  for (const entry of entries) for (const code of entry.errors) expect(errorCodes as string[]).toContain(code);
  for (const entry of entries) expect(entry.examples.length).toBeGreaterThan(0);
});

test("a next command is built only for read-only commands that exist, with values quoted", () => {
  const commands = catalog(program()).map((entry) => entry.command);
  for (const path of READ_ONLY_COMMANDS) expect(commands).toContain(path);
  expect(nextCommand("slots list", "why", { sizes: true }).command).toBe("xcslot slots list --sizes");
  expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
});

const places = { cwd: "/w/app/ios", worktree: "/w/app", slotSrc: "/s/1/src", slotDerivedData: "/s/1/DerivedData" };

test("xcodebuild arguments: tree inputs resolve in the slot, everything else stays where the caller meant it", () => {
  const rewritten = rewriteArgs(
    [
      "-workspace",
      "App.xcworkspace",
      "-xcconfig",
      "/w/app/Config/Local.xcconfig",
      "-scheme",
      "App",
      "-resultBundlePath",
      "out/Test.xcresult",
      "-derivedDataPath",
      "build/dd",
      "-only-testing:@/w/app/ios/tests.txt",
      "SYMROOT=/w/app/build",
      "OTHER=/elsewhere/x",
      "test",
    ],
    places,
  );
  expect(rewritten.cwd).toBe("/s/1/src/ios");
  expect(rewritten.derivedDataAsked).toBe("/w/app/ios/build/dd");
  expect(rewritten.args).toEqual([
    "-workspace",
    "App.xcworkspace",
    "-xcconfig",
    "/s/1/src/Config/Local.xcconfig",
    "-scheme",
    "App",
    "-resultBundlePath",
    "/w/app/ios/out/Test.xcresult",
    "-only-testing:@/s/1/src/ios/tests.txt",
    "SYMROOT=/s/1/src/build",
    "OTHER=/elsewhere/x",
    "test",
    "-derivedDataPath",
    "/s/1/DerivedData",
  ]);
  expect(rewritten.handOut).toEqual([{ from: "/s/1/src/build", to: "/w/app/build" }]);

  const settings = rewriteArgs(["SYMROOT=$(SRCROOT)/build", "CONFIGURATION_BUILD_DIR=/w/app", "build"], places);
  expect(settings.args.slice(0, 2)).toEqual(["SYMROOT=$(SRCROOT)/build", "CONFIGURATION_BUILD_DIR=/s/1/src"]);
  expect(settings.handOut).toEqual([]);
  expect(needsNoProject(["-version"])).toBe(true);
  expect(needsNoProject(["-scheme", "App", "build"])).toBe(false);
});

test("output paths point at the worktree, except for files that exist only in the slot", async () => {
  const map = createPathMapper("/s/1/src", "/w/app", (path) => path !== "/w/app/Derived/Gen.swift");
  expect(map("/s/1/src/A.swift:3:5: error: boom")).toBe("/w/app/A.swift:3:5: error: boom");
  expect(map("/s/1/src/Derived/Gen.swift:1:1: warning: x")).toBe("/s/1/src/Derived/Gen.swift:1:1: warning: x");
  expect(map("cd /s/1/src")).toBe("cd /w/app");
  expect(map("/s/1/DerivedData/Build stays")).toBe("/s/1/DerivedData/Build stays");

  const viaPrivate = createPathMapper("/private/var/x/src", "/w/app", () => true);
  expect(viaPrivate("/var/x/src/A.swift:1:1: error: e")).toBe("/w/app/A.swift:1:1: error: e");
  expect(viaPrivate("cd /private/var/x/src/Sub")).toBe("cd /w/app/Sub");

  const encoder = new TextEncoder();
  const chunks = ["one /s/1/s", "rc/A.swift:1\ntwo", " end"].map((text) => encoder.encode(text));
  const written: Uint8Array[] = [];
  await pumpLines(new Blob(chunks.map((chunk) => chunk.slice())).stream(), map, (chunk) => void written.push(chunk));
  expect(Buffer.concat(written).toString()).toBe("one /w/app/A.swift:1\ntwo end");

  const inWorktree = new Set(["/w/app/My App/View.swift", "/w/app/A.swift", "/w/app/B.swift"]);
  const spaced = createPathMapper("/s/1/src", "/w/app", (path) => inWorktree.has(path));
  expect(spaced("/s/1/src/My App/View.swift:3:1: error: e")).toBe("/w/app/My App/View.swift:3:1: error: e");
  expect(spaced("\x1b[1m/s/1/src/A.swift:1:1: \x1b[0m")).toBe("\x1b[1m/w/app/A.swift:1:1: \x1b[0m");
  expect(spaced("open file:///s/1/src/A.swift")).toBe("open file:///w/app/A.swift");
  expect(spaced("(/s/1/src/A.swift) and /s/1/src/B.swift here")).toBe("(/w/app/A.swift) and /w/app/B.swift here");
  expect(spaced("/s/1/src/Gen Only.swift:1: e")).toBe("/s/1/src/Gen Only.swift:1: e");

  let looks = 0;
  const counted = createPathMapper("/s/1/src", "/w/app", (path) => {
    looks++;
    return path === "/w/app/X.swift";
  });
  const flags = Array.from({ length: 3000 }, (_, i) => `-Xflag${i} /elsewhere/p${i}`).join(" ");
  expect(counted(`swift-frontend -primary-file /s/1/src/X.swift ${flags}`)).toStartWith(
    "swift-frontend -primary-file /w/app/X.swift -Xflag0",
  );
  expect(looks).toBeLessThan(10);

  const binary = Uint8Array.from([0xff, 0xfe, 0x00, 0x0a, 0x80, 0xc3]);
  const passed: Uint8Array[] = [];
  await pumpLines(new Blob([binary]).stream(), spaced, (chunk) => void passed.push(chunk));
  expect(Buffer.concat(passed)).toEqual(Buffer.from(binary));
});

test("slot choice: own slot, then the nearest by changed files, the longest unused on a tie, never-built last", () => {
  const slot = (n: number, source?: string, head?: string, usedAt?: number) => ({
    n,
    state: { ...emptyState(), ...(source && { source }), ...(head && { head }), ...(usedAt && { usedAt }) },
  });
  const distance: Record<string, number> = { far: 40, near: 2, tieOld: 5, tieNew: 5 };
  const order = orderSlots(
    [
      slot(1),
      slot(2, "/w/other", "far", 9),
      slot(3, "/w/mine", "x", 1),
      slot(4, "/w/b", "tieNew", 8),
      slot(5, "/w/c", "tieOld", 3),
      slot(6, "/w/d", "near", 7),
    ],
    "/w/mine",
    (head) => distance[head],
  );
  expect(order).toEqual([3, 6, 5, 4, 2, 1]);
});
