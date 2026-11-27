import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addWorktree, cli, makeRepo, scratch, sh, write } from "./helpers.ts";

// Real xcodebuild, real APFS clones: minutes, not seconds, so it runs only where asked (the macOS CI job).
const enabled = process.env.XCSLOT_E2E === "1" && process.platform === "darwin" && Bun.which("xcodebuild") !== null;

const PACKAGE = `// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "demo",
  products: [.library(name: "Greeter", type: .dynamic, targets: ["Greeter"])],
  targets: [.target(name: "Greeter"), .executableTarget(name: "demo", dependencies: ["Greeter"])]
)
`;
const GREETER = `public func greeting(_ name: String) -> String {
  let text = "hello, " + name
  return text
}
`;
const BUILD = ["xcodebuild", "-scheme", "demo-Package", "-destination", "platform=macOS", "build"];
const compiled = (output: string) => output.split("\n").filter((line) => line.startsWith("SwiftCompile ")).length;

describe.skipIf(!enabled)("with real xcodebuild", () => {
  test("a standalone package nested under Tuist builds without generating the workspace", async () => {
    const repo = makeRepo({
      "Tuist.swift": "",
      "Tuist/Package.swift": "",
      "Packages/demo/Package.swift": PACKAGE,
      "Packages/demo/Sources/demo/main.swift": 'import Greeter\nprint(greeting("slot"))\n',
      "Packages/demo/Sources/Greeter/Greeter.swift": GREETER,
      ".gitignore": ".build/\n",
      "bin/tuist": "#!/bin/sh\nexit 71\n",
    });
    chmodSync(join(repo, "bin/tuist"), 0o755);
    const result = await cli(BUILD, {
      cwd: join(repo, "Packages/demo"),
      home: scratch(),
      env: { PATH: `${join(repo, "bin")}:${process.env.PATH}` },
    });
    expect(result.code, result.stderr + result.stdout.slice(-2000)).toBe(0);
    expect(compiled(result.stdout)).toBeGreaterThan(0);
  }, 120_000);

  test("a fresh worktree compiles nothing, an edit compiles, a diagnostic names the worktree, products debug correctly", async () => {
    const repo = makeRepo(
      {
        "Package.swift": PACKAGE,
        "Sources/demo/main.swift": 'import Greeter\nprint(greeting("slot"))\n',
        "Sources/Greeter/Greeter.swift": GREETER,
        ".gitignore": ".build/\nout/\n",
      },
      "demo",
    );
    const home = scratch();
    const first = addWorktree(repo, "first");
    const second = addWorktree(repo, "second");

    const cold = await cli(BUILD, { cwd: first, home });
    expect(cold.code, cold.stdout.slice(-2000)).toBe(0);
    expect(compiled(cold.stdout)).toBeGreaterThan(0);

    const warm = await cli(BUILD, { cwd: second, home });
    expect(warm.code).toBe(0);
    expect(compiled(warm.stdout)).toBe(0);
    expect(warm.stderr).toContain("slot 1: synced 0 changed files");

    write(second, { "Sources/Greeter/Greeter.swift": GREETER.replace("hello", "good day") });
    const edited = await cli(BUILD, { cwd: second, home });
    expect(edited.code).toBe(0);
    expect(compiled(edited.stdout)).toBeGreaterThan(0);

    const out = await cli(["xcodebuild", "--products-to", "out", ...BUILD.slice(1)], { cwd: second, home });
    expect(out.code).toBe(0);
    const config = readdirSync(join(second, "out")).find((name) => name.startsWith("Debug")) as string;
    const binary = join(second, "out", config, "demo");
    expect(sh(second, binary)).toBe("good day, slot\n");
    const plists = readdirSync(join(`${binary}.dSYM`, "Contents", "Resources")).filter((name) =>
      name.endsWith(".plist"),
    );
    expect(readFileSync(join(`${binary}.dSYM`, "Contents", "Resources", plists[0] as string), "utf8")).toContain(
      second,
    );

    // A bundle's dSYM sits beside it: a file added inside a signed bundle breaks its seal.
    const framework = join(second, "out", config, "PackageFrameworks", "Greeter.framework");
    expect(existsSync(`${framework}.dSYM/Contents/Resources/DWARF/Greeter`)).toBe(true);
    expect(readdirSync(framework, { recursive: true }).filter((name) => String(name).includes(".dSYM"))).toEqual([]);

    write(second, { "Sources/Greeter/Greeter.swift": `${GREETER}let broken: Int = "oops"\n` });
    const failed = await cli(BUILD, { cwd: second, home });
    expect(failed.code).toBe(65);
    const diagnostics = (failed.stdout + failed.stderr).split("\n").filter((line) => line.includes(": error:"));
    expect(diagnostics[0]).toStartWith(`${second}/Sources/Greeter/Greeter.swift:5:19: error:`);

    // The slot has since been rebuilt from a broken tree; the handed-out binary must still debug by worktree paths.
    const lldb = sh(
      second,
      "xcrun",
      "lldb",
      "-b",
      "-o",
      `breakpoint set --file ${second}/Sources/Greeter/Greeter.swift --line 2`,
      binary,
    );
    expect(lldb).toMatch(/Breakpoint 1: where = demo`.*Greeter\.swift:2/);
    expect(existsSync(join(home, "slots"))).toBe(true);
  }, 600_000);
});
