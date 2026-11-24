import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json" with { type: "json" };
import { REFERENCE, render } from "../scripts/docs.ts";
import { scratch, sh } from "./helpers.ts";

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
  expect(catalog.data.commands.length).toBe(10);
  expect(sh(process.cwd(), binary, "skill")).toContain("name: xcslot");
}, 60_000);
