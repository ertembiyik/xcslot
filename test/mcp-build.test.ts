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
          script: ['echo " " >> "$SRCROOT/Localizable.xcstrings"'],
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
    const repo = makeRepo({
      ".gitignore": "xcuserdata/\n",
      "Demo.xcodeproj/project.xcproj": JSON.stringify(project),
      "Example.xcworkspace/contents.xcworkspacedata":
        '<Workspace version="1.0"><FileRef location="group:Demo.xcodeproj"/></Workspace>',
      "Sources/main.swift": 'print("demo")\n',
      "Localizable.xcstrings": catalog,
    });
    const home = scratch();
    const work = addWorktree(repo, "second");
    const out = join(scratch(), "Products");
    const build = (cwd: string) =>
      cli(["mcp-build", "--products-to", out, "Demo.xcodeproj", "Demo"], {
        cwd,
        home,
        env: { HOME: process.env.HOME as string },
      });
    const first = await build(repo);
    expect(first.code, first.stdout + first.stderr).toBe(0);
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
    const broken = '#error("ExpectedMembershipDiagnostic")\n';
    write(work, { "Sources/New.swift": broken });
    const failed = await build(work);
    expect(failed.code, failed.stdout + failed.stderr).toBe(65);
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
    const workspace = await cli(["mcp-build", "--products-to", out, "Example.xcworkspace", "Demo"], {
      cwd: work,
      home,
      env: { HOME: process.env.HOME as string },
    });
    expect(workspace.code, workspace.stdout + workspace.stderr).toBe(0);
    expect(sh(work, "nm", "-arch", "arm64", binary)).toContain("_xcslotSecondTree");
    expect(uuids(dsym)).toEqual([...uuids(launcher), ...uuids(binary)].sort());
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
    const cleanup = await cli(["slots", "remove", "--all", "--yes"], { cwd: work, home });
    expect(cleanup.code, cleanup.stderr).toBe(0);
    expect(existsSync(join(slots, repoDir, "1"))).toBe(false);
    expect(sh(work, "xcrun", "mcp-server", "status", "--format", "json")).not.toContain(
      join(slots, repoDir, "1", "src"),
    );
  },
  300_000,
);
