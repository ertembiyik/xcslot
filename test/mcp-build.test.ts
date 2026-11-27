import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { headlessProductData } from "../src/adapters/headless.ts";
import { addWorktree, cli, makeRepo, scratch, sh, write } from "./helpers.ts";

const project = {
  localizations: { development: "en", supported: ["en"] },
  configurations: ["Debug"],
  "default-configuration": "Debug",
  files: [
    { kind: "folder", path: "Sources", "target-membership": ["Demo"] },
    {
      kind: "group",
      name: "Products",
      children: [{ path: "<PRODUCTS>/Demo.app", type: "wrapper.application", index: false }],
    },
  ],
  targets: [
    {
      name: "Demo",
      id: "A00000000000000000000001",
      product: "Products/Demo.app",
      "product-type": "application",
      "build-phases": [
        "compile-sources",
        "frameworks",
        "resources",
        {
          kind: "script",
          name: "Write generated metadata",
          "run-on-every-build": true,
          shell: "/bin/sh",
          script: [
            'if [ -f "$SRCROOT/../headless-session.json" ]; then echo " " >> "$SRCROOT/Localizable.xcstrings"; fi',
          ],
        },
      ],
      "build-settings": {
        SDKROOT: "iphoneos",
        SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
        IPHONEOS_DEPLOYMENT_TARGET: "17.0",
        PRODUCT_BUNDLE_IDENTIFIER: "org.example.xcslot.demo",
        PRODUCT_NAME: "Demo",
        GENERATE_INFOPLIST_FILE: "YES",
        CODE_SIGNING_ALLOWED: "NO",
        DEBUG_INFORMATION_FORMAT: "dwarf-with-dsym",
        SWIFT_VERSION: "5.0",
        ENABLE_USER_SCRIPT_SANDBOXING: "NO",
        ENABLE_DEBUG_DYLIB: "YES",
        SWIFT_OPTIMIZATION_LEVEL: "-Onone",
        GCC_GENERATE_DEBUGGING_SYMBOLS: "YES",
      },
    },
  ],
};

test("explicit export fails when a successful command produced no products", async () => {
  const work = makeRepo({ "file.txt": "input" });
  const run = await cli(["run", "--products-to", "out", "--", "true"], { cwd: work, home: scratch() });
  expect(run.code).toBe(114);
  expect(run.stderr).toContain("No built products");
  expect(existsSync(join(work, "out"))).toBe(false);
  write(work, { "out/.xcslot-products": "", "out/previous.txt": "previous export" });
  const retry = await cli(["run", "--products-to", "out", "--", "true"], { cwd: work, home: scratch() });
  expect(retry.code).toBe(114);
  expect(readFileSync(join(work, "out", "previous.txt"), "utf8")).toBe("previous export");
});

test.skipIf(process.platform !== "darwin")(
  "export matches the actual workspace even when an old Products directory exists",
  () => {
    const root = scratch();
    const current = join(root, "Current.xcodeproj");
    const old = join(root, "Old.xcodeproj");
    write(root, { "Current.xcodeproj/project.xcproj": "{}", "Old.xcodeproj/project.xcproj": "{}" });
    const cache = (name: string, owner: string) =>
      write(root, {
        [name + "/info.plist"]:
          `<plist version="1.0"><dict><key>WorkspacePath</key><string>${owner}</string></dict></plist>`,
        [name + "/Build/Products/Debug/Demo"]: "binary",
      });
    cache("old-cache", old);
    expect(headlessProductData(root, current).isErr()).toBe(true);
    cache("current-cache", current);
    expect(headlessProductData(root, current)._unsafeUnwrap()).toBe(join(root, "current-cache"));
    cache("ambiguous-cache", current);
    expect(headlessProductData(root, current).isErr()).toBe(true);
  },
);

const live = process.platform === "darwin" && process.env.XCSLOT_MCP_E2E === "1";
test.skipIf(!live)(
  "headless Xcode detects added and deleted sources, isolates source writes, and exports the current app with symbols",
  async () => {
    const catalog = '{"sourceLanguage":"en","strings":{},"version":"1.0"}\n';
    const home = scratch();
    const nestedBin = join(scratch(), "xcslot");
    sh(scratch(), "bun", "build", "--compile", join(import.meta.dir, "../src/bin.ts"), "--outfile", nestedBin);
    const nestedProject = structuredClone(project);
    const phase = nestedProject.targets[0]!["build-phases"].find((p) => typeof p === "object");
    if (typeof phase !== "object") throw new Error("Missing script phase");
    phase.script.push(
      `if [ -f "$SRCROOT/../headless-session.json" ]; then unset XCSLOT_DERIVED_DATA; XCSLOT_HOME="${home}/slots" XCSLOT_CONFIG="${home}/config.json" "${nestedBin}" run --no-wait -- sh -c 'test "$(pwd -P)" = "$(cd "$SRCROOT" && pwd -P)"' || exit 1; fi`,
    );
    const repo = makeRepo({
      ".gitignore": "xcuserdata/\n",
      "Demo.xcodeproj/project.xcproj": JSON.stringify(nestedProject),
      "Example.xcworkspace/contents.xcworkspacedata":
        '<Workspace version="1.0"><FileRef location="group:Demo.xcodeproj"/></Workspace>',
      "Sources/main.swift": 'print("demo")\n',
      "Localizable.xcstrings": catalog,
    });
    const work = addWorktree(repo, "second");
    const out = join(scratch(), "Products");
    const build = (cwd: string) =>
      cli(["build", "--products-to", out, "-project", "Demo.xcodeproj", "-scheme", "Demo"], {
        cwd,
        home,
        env: { HOME: process.env.HOME as string },
      });
    try {
      const first = await build(repo);
      expect(first.code, first.stdout + first.stderr).toBe(0);
      expect(first.stderr).toContain("using MCP");
      expect(first.stderr).not.toContain("using xcodebuild");
      const slots = join(home, "slots");
      const repoDir = readdirSync(slots).find((name) => name.startsWith("app-")) as string;
      const generated = join(slots, repoDir, "1", "src", "Localizable.xcstrings");
      expect(readFileSync(generated, "utf8")).not.toBe(catalog);
      const binary = join(out, "Debug-iphonesimulator/Demo.app/Demo.debug.dylib");
      const launcher = join(out, "Debug-iphonesimulator/Demo.app/Demo");
      const dsym = join(out, "Debug-iphonesimulator/Demo.app.dSYM");
      const uuids = (path: string) =>
        sh(repo, "dwarfdump", "--uuid", path)
          .split("\n")
          .filter(Boolean)
          .map((s) => s.split(" ")[1])
          .sort();
      const firstIDs = uuids(binary);
      expect(firstIDs.length).toBeGreaterThan(0);
      expect(uuids(dsym)).toEqual([...uuids(launcher), ...uuids(binary)].sort());
      expect(sh(repo, "git", "status", "--porcelain")).toBe("");
      // Existing-source compiler errors are returned directly by MCP.
      write(work, { "Sources/main.swift": '#error("ExpectedExistingSourceDiagnostic")\n' });
      const existingFailure = await build(work);
      expect(existingFailure.code, existingFailure.stdout + existingFailure.stderr).toBe(65);
      expect(existingFailure.stdout).toContain("ExpectedExistingSourceDiagnostic");
      expect(existingFailure.stderr).not.toContain("using xcodebuild");
      write(work, { "Sources/main.swift": 'print("demo")\n' });
      const broken = '#error("ExpectedMembershipDiagnostic")\n';
      write(work, { "Sources/New.swift": broken });
      const forced = await cli(["build", "--engine", "mcp", "-project", "Demo.xcodeproj", "-scheme", "Demo"], {
        cwd: work,
        home,
        env: { HOME: process.env.HOME as string },
      });
      expect(forced.code).toBe(101);
      expect(forced.stderr).toContain("MCP workspace inputs changed");
      const failed = await build(work);
      expect(failed.code, failed.stdout + failed.stderr).toBe(65);
      expect(failed.stderr).toContain("using xcodebuild (MCP workspace inputs changed)");
      expect(failed.stdout).toContain("ExpectedMembershipDiagnostic");
      expect(failed.stdout).toContain(join(work, "Sources/New.swift"));
      expect(uuids(dsym)).toEqual([...uuids(launcher), ...uuids(binary)].sort());
      expect(uuids(binary)).toEqual(firstIDs);
      unlinkSync(join(work, "Sources/New.swift"));
      write(work, { "Sources/main.swift": 'print("second")\n@_cdecl("xcslotSecondTree") public func mark() {}\n' });
      const recovered = await build(work);
      expect(recovered.code, recovered.stdout + recovered.stderr).toBe(0);
      expect(sh(work, "nm", "-arch", "arm64", binary)).toContain("_xcslotSecondTree");
      expect(uuids(binary)).not.toEqual(firstIDs);
      expect(uuids(dsym)).toEqual([...uuids(launcher), ...uuids(binary)].sort());
      expect(readFileSync(join(work, "Localizable.xcstrings"), "utf8")).toBe(catalog);
      expect(sh(work, "git", "status", "--porcelain").trim()).toBe("M Sources/main.swift");
      const marker = join(slots, repoDir, "1", "headless-session.json");
      expect(existsSync(marker)).toBe(true);
      const switched = await cli(["run", "--", "true"], { cwd: work, home });
      expect(switched.code, switched.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(join(work, "Localizable.xcstrings"), "utf8")).toBe(catalog);
      const parallelOut = join(scratch(), "other-products");
      const [unchanged, edited] = await Promise.all([
        build(repo),
        cli(["mcp-build", "--products-to", parallelOut, "Demo.xcodeproj", "Demo"], {
          cwd: work,
          home,
          env: { HOME: process.env.HOME as string },
        }),
      ]);
      expect(unchanged.code, unchanged.stdout + unchanged.stderr).toBe(0);
      expect(edited.code, edited.stdout + edited.stderr).toBe(0);
      expect(sh(repo, "nm", "-arch", "arm64", binary)).not.toContain("_xcslotSecondTree");
      const otherBinary = join(parallelOut, "Debug-iphonesimulator/Demo.app/Demo.debug.dylib");
      expect(sh(work, "nm", "-arch", "arm64", otherBinary)).toContain("_xcslotSecondTree");
      const workspaceHome = scratch();
      try {
        const workspace = await cli(["mcp-build", "--products-to", out, "Example.xcworkspace", "Demo"], {
          cwd: work,
          home: workspaceHome,
          env: { HOME: process.env.HOME as string },
        });
        expect(workspace.code, workspace.stdout + workspace.stderr).toBe(0);
        expect(sh(work, "nm", "-arch", "arm64", binary)).toContain("_xcslotSecondTree");
        expect(uuids(dsym)).toEqual([...uuids(launcher), ...uuids(binary)].sort());
      } finally {
        const closed = await cli(["slots", "remove", "--all", "--yes"], { cwd: work, home: workspaceHome });
        expect(closed.code, closed.stderr).toBe(0);
      }
    } finally {
      const cleanup = await cli(["slots", "remove", "--all", "--yes"], { cwd: work, home });
      expect(cleanup.code, cleanup.stderr).toBe(0);
    }
  },
  300_000,
);

test.skipIf(!live)(
  "macOS app exports a debug dylib even if its native dSYM initially contains only the launcher",
  async () => {
    const dir = scratch();
    const products = join(dir, "Products");
    const app = join(products, "Demo.app");
    const launcher = join(app, "Contents/MacOS/Demo");
    const dylib = launcher + ".debug.dylib";
    write(dir, {
      "main.swift": 'print("demo")\n',
      "library.swift": "public func value() -> Int { 12 }\n",
      "Products/Demo.app/Contents/MacOS/.keep": "",
    });
    sh(dir, "xcrun", "swiftc", "-g", "main.swift", "-o", launcher);
    sh(dir, "xcrun", "swiftc", "-g", "-emit-library", "library.swift", "-o", dylib);
    const dsym = app + ".dSYM";
    sh(dir, "dsymutil", launcher, "-o", dsym);
    expect(existsSync(join(dsym, "Contents/Resources/DWARF/Demo.debug.dylib"))).toBe(false);
    const { embedDebugSymbols } = await import("../src/xcodebuild/handout.ts");
    expect(await embedDebugSymbols(products, dir, dir)).toBe(1);
    const uuids = (path: string) =>
      sh(dir, "dwarfdump", "--uuid", path)
        .split("\n")
        .filter(Boolean)
        .map((s) => s.split(" ")[1])
        .sort();
    expect(uuids(dsym)).toEqual([...uuids(launcher), ...uuids(dylib)].sort());
  },
  60_000,
);
