import { expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { simpleBuild } from "../src/commands/build.ts";
import { cli, makeRepo, scratch, write } from "./helpers.ts";

const REQUEST = ["-project", "App.xcodeproj", "-scheme", "App", "build"];

test("automatic builds translate only unambiguous build requests", () => {
  const cwd = makeRepo({ "App.xcodeproj/project.xcproj": "{}" });
  expect(simpleBuild(REQUEST, cwd)).toEqual([join(cwd, "App.xcodeproj"), "App"]);
  expect(simpleBuild(["-scheme", "App"], cwd)).toEqual([join(cwd, "App.xcodeproj"), "App"]);
  for (const extra of [
    ["-configuration", "Release"],
    ["-destination", "platform=iOS Simulator,id=123"],
    ["CODE_SIGNING_ALLOWED=NO"],
    ["-resultBundlePath", "out"],
    ["test"],
    ["archive"],
    ["clean"],
    ["-scheme", "Other"],
    ["-quiet"],
    ["-derivedDataPath", "dd"],
  ])
    expect(simpleBuild([...REQUEST, ...extra], cwd)).toBeUndefined();
  write(cwd, { "Other.xcworkspace/contents.xcworkspacedata": "<Workspace/>" });
  expect(simpleBuild(["-scheme", "App"], cwd)).toBeUndefined();
});

function setupMCP(enabled: boolean) {
  const cwd = makeRepo({ "App.xcodeproj/project.xcproj": "{}" });
  const home = scratch();
  const bin = join(scratch(), "bin");
  // Report the headless service status, then fail to find the launcher. This models a
  // service that disappears between selection and opening the workspace.
  write(bin, {
    xcrun: `#!/bin/sh
if [ "$1 $2" = "mcp-server status" ]; then
  printf '%s\\n' '${JSON.stringify({ running: false, permission: { enabled } })}'
else
  exit 1
fi
`,
    xcodebuild: '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 0\n',
  });
  for (const name of ["xcrun", "xcodebuild"]) chmodSync(join(bin, name), 0o755);
  return { cwd, home, env: { PATH: `${bin}:${process.env.PATH}` } };
}

test("auto chooses CLI for unsupported flags and honors configuration and per-call overrides", async () => {
  const setup = setupMCP(false);
  const unsupported = await cli(["build", ...REQUEST, "-configuration", "Release"], setup);
  expect(unsupported.code).toBe(0);
  expect(unsupported.stderr).toContain("request requires xcodebuild arguments");
  expect(unsupported.stdout).toContain("-configuration\nRelease\n");
  const disabled = await cli(["build", ...REQUEST], setup);
  expect(disabled.code).toBe(0);
  expect(disabled.stderr).toContain("using xcodebuild");
  expect(disabled.stdout).toContain("-destination\ngeneric/platform=iOS Simulator");
  write(setup.home, { "config.json": '{"buildEngine":"mcp"}' });
  const forced = await cli(["build", ...REQUEST, "test"], setup);
  expect(forced.code).toBe(101);
  expect(forced.stdout).toBe("");
  const override = await cli(["build", "--engine", "xcodebuild", ...REQUEST], setup);
  expect(override.code).toBe(0);
  expect(override.stderr).toContain("selected engine");
  const raw = await cli(["xcodebuild", ...REQUEST], setup);
  expect(raw.code).toBe(0);
  expect(raw.stdout).not.toContain("-destination");
  expect(raw.stderr).not.toContain("using MCP");
  write(setup.home, { "config.json": '{"buildEngine":"xcodebuild"}' });
  expect((await cli(["build", ...REQUEST], setup)).stderr).toContain("selected engine");
});

test.skipIf(process.platform !== "darwin")(
  "auto retries CLI only after a safe MCP setup failure; forced MCP reports its own error",
  async () => {
    const setup = setupMCP(true);
    const auto = await cli(["build", ...REQUEST], setup);
    expect(auto.code, auto.stderr).toBe(0);
    expect(auto.stderr).toContain("using MCP");
    expect(auto.stderr).toContain("using xcodebuild (MCP setup unavailable)");
    expect(auto.stdout).toContain("-scheme\nApp\nbuild");
    const forced = await cli(["build", "--engine", "mcp", ...REQUEST], setup);
    expect(forced.code).toBe(103);
    expect(forced.stderr).not.toContain("using xcodebuild");
    const envelope = JSON.parse(forced.stderr.trim().split("\n").at(-1)!);
    expect(envelope.error.code).toBe("tool_missing");
  },
);

test("nested headless build phases reuse their active slot without acquiring another permit", async () => {
  const repo = makeRepo({ "file.txt": "input" });
  const home = scratch();
  const initial = await cli(["run", "--", "true"], { cwd: repo, home });
  expect(initial.code).toBe(0);
  const { readdirSync } = await import("node:fs");
  const repoDir = join(
    home,
    "slots",
    readdirSync(join(home, "slots")).find((n) => n.startsWith("app-"))!,
  );
  const slot = join(repoDir, "1");
  const src = join(slot, "src");
  const { tryLock, unlock } = await import("../src/slot/lock.ts");
  const { systemProcesses } = await import("../src/lib/proc.ts");
  const env = { pid: process.pid, processes: systemProcesses, now: Date.now };
  expect(tryLock(join(slot, "lock"), "headless build", env)).toBe(true);
  try {
    write(slot, { "headless-session.json": JSON.stringify({ ready: false, project: join(src, "App.xcodeproj") }) });
    const nested = await cli(["run", "--no-wait", "--", "cat", "file.txt"], { cwd: src, home });
    expect(nested.code, nested.stderr).toBe(0);
    expect(nested.stdout).toBe("input");
    expect(nested.stderr).toBe("");
  } finally {
    unlock(join(slot, "lock"), env);
  }
});
