import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json" with { type: "json" };
import { REFERENCE, render } from "../scripts/docs.ts";
import { makeRepo, scratch, sh } from "./helpers.ts";

test("the reference's output tables match the schemas", () => {
  const reference = readFileSync(REFERENCE, "utf8");
  expect(render(reference)).toBe(reference);
});

test("the compiled binary starts, reports its version and prints the catalog as one JSON document", () => {
  const dir = scratch();
  const binary = join(dir, "xcslot");
  // Bun 1.4.5 leaves a copy of itself in the directory it compiles from; the scratch directory takes it.
  sh(dir, "bun", "build", "--compile", join(process.cwd(), "src/bin.ts"), "--outfile", binary);
  expect(sh(process.cwd(), binary, "--version").trim()).toBe(version);
  const catalog = JSON.parse(sh(process.cwd(), binary, "commands")) as { ok: boolean; data: { commands: unknown[] } };
  expect(catalog.ok).toBe(true);
  expect(catalog.data.commands.length).toBe(11);
  expect(sh(process.cwd(), binary, "skill")).toContain("name: xcslot");
}, 60_000);

test("a reader that stops early, like head, ends nothing: the wrapped command finishes and its exit code comes back", () => {
  const repo = makeRepo({ "A.swift": "a" });
  const home = scratch();
  const bin = join(process.cwd(), "src/bin.ts");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XCSLOT_HOME: join(home, "slots"),
    XCSLOT_CONFIG: join(home, "c.json"),
  };
  const piped = (redirect: string) =>
    Bun.spawnSync(
      ["bash", "-c", `set -o pipefail; bun ${bin} run -- sh -c 'seq 1 200000; exit 3' ${redirect}| head -1`],
      {
        cwd: repo,
        env,
      },
    );

  const stdoutOnly = piped("");
  expect(stdoutOnly.stdout.toString()).toBe("1\n");
  expect(stdoutOnly.stderr.toString()).not.toContain("EPIPE");
  expect(stdoutOnly.exitCode).toBe(3);
  expect(piped("2>&1 ").exitCode).toBe(3);
}, 30_000);
