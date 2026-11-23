// Compiles the standalone binaries: `bun scripts/build.ts` for both Macs, `--target host` for this machine only.
import { mkdirSync, readdirSync, rmSync } from "node:fs";

const TARGETS = { "darwin-arm64": "bun-darwin-arm64", "darwin-x64": "bun-darwin-x64" } as const;
const host = process.argv.includes("--target") && process.argv[process.argv.indexOf("--target") + 1] === "host";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
const builds = host
  ? [{ name: "xcslot", target: undefined }]
  : Object.entries(TARGETS).map(([name, target]) => ({ name: `xcslot-${name}`, target }));
for (const { name, target } of builds) {
  const done = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      "--minify",
      ...(target ? [`--target=${target}`] : []),
      "src/bin.ts",
      "--outfile",
      `dist/${name}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (done.exitCode !== 0) process.exit(done.exitCode);
}
// Bun 1.4.5 leaves a copy of itself (`.<hash>.bun-build`) in the working directory after each compile.
for (const name of readdirSync(".")) if (name.endsWith(".bun-build")) rmSync(name);
