import { expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeRepo, scratch, write } from "./helpers.ts";

const HOOK = resolve(import.meta.dir, "../hooks/xcodebuild.sh");

function withXcslot(): string {
  const bin = join(scratch(), "bin");
  write(bin, { xcslot: "#!/bin/sh\n" });
  chmodSync(join(bin, "xcslot"), 0o755);
  return `${bin}:/usr/bin:/bin`;
}

/** The command the hook hands back to the agent, or undefined when it lets the command run. */
function hook(command: string, options: { cwd?: string; path?: string; env?: Record<string, string> } = {}) {
  const input = {
    cwd: options.cwd ?? makeRepo({ "A.swift": "a" }),
    tool_name: "Bash",
    tool_input: { command },
  };
  const done = Bun.spawnSync([HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: { PATH: options.path ?? withXcslot(), ...options.env },
  });
  expect(done.exitCode).toBe(0);
  const out = done.stdout.toString();
  if (out === "") return undefined;
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  const reason: string = parsed.hookSpecificOutput.permissionDecisionReason;
  return reason.match(/warm slot: ([\s\S]*)\nRun it unchanged/)?.[1];
}

// The hook reads its input with macOS's plutil; elsewhere it lets every command run.
test.skipIf(process.platform !== "darwin")(
  "the hook puts xcslot in front of xcodebuild wherever a command starts",
  () => {
    const standalone = "xcodebuild -scheme App -destination 'generic/platform=iOS Simulator' build";
    expect(hook(standalone)).toBe("xcslot build -scheme App -destination 'generic/platform=iOS Simulator' build");
    expect(hook(standalone + " | xcbeautify")).toBe("xcslot " + standalone + " | xcbeautify");
    expect(hook("xcodebuild -scheme App build")).toBe("xcslot xcodebuild -scheme App build");
    expect(hook("cd ios && NSUnbufferedIO=YES xcodebuild -scheme App build | xcbeautify")).toBe(
      "cd ios && NSUnbufferedIO=YES xcslot xcodebuild -scheme App build | xcbeautify",
    );
    expect(hook("set -o pipefail; xcrun xcodebuild test")).toBe("set -o pipefail; xcslot xcodebuild test");
    expect(hook("xcodebuild clean\nxcodebuild build")).toBe("xcslot xcodebuild clean\nxcslot xcodebuild build");
  },
);

test("the hook leaves everything else alone", () => {
  expect(hook("xcslot xcodebuild build")).toBeUndefined();
  expect(hook("tail -n 50 xcodebuild.log")).toBeUndefined();
  expect(hook("echo xcodebuild")).toBeUndefined();
  expect(hook("swift build")).toBeUndefined();
  expect(hook("xcodebuild build", { cwd: scratch() })).toBeUndefined();
  expect(hook("xcodebuild build", { path: "/usr/bin:/bin" })).toBeUndefined();
  expect(hook("xcodebuild build", { env: { XCSLOT_HOOK: "0" } })).toBeUndefined();
  expect(hook("xcodebuild build", { env: { XCSLOT_DERIVED_DATA: "/slot/DerivedData" } })).toBeUndefined();
});
