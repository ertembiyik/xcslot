// Regenerates the output tables in docs/reference.md from the zod schemas: `bun scripts/docs.ts`, or `--check` to only compare.
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { documentedOutputs } from "../src/commands/schemas.ts";

export const REFERENCE = "docs/reference.md";

interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
}

function rows(schema: JsonSchema, prefix = ""): string[] {
  return Object.entries(schema.properties ?? {}).flatMap(([name, field]) => {
    const path = `${prefix}${name}`;
    const element = field.type === "array" ? field.items : undefined;
    const type = element ? `${element.type ?? "object"}[]` : (field.type ?? "object");
    const optional = schema.required?.includes(name) ? "" : " (optional)";
    const nested = element?.properties ? rows(element, `${path}[].`) : field.properties ? rows(field, `${path}.`) : [];
    return [`| \`${path}\` | ${type}${optional} | ${field.description ?? ""} |`, ...nested];
  });
}

export function render(reference: string): string {
  let text = reference;
  for (const [command, schema] of Object.entries(documentedOutputs)) {
    const table = ["| Field | Type | Meaning |", "|---|---|---|", ...rows(z.toJSONSchema(schema) as JsonSchema)].join(
      "\n",
    );
    const start = `<!-- output:${command} -->`;
    const end = `<!-- /output:${command} -->`;
    const from = text.indexOf(start);
    const to = text.indexOf(end);
    if (from < 0 || to < 0) throw new Error(`${REFERENCE} has no ${start} … ${end} block`);
    text = `${text.slice(0, from + start.length)}\n${table}\n${text.slice(to)}`;
  }
  return formatted(text);
}

// The formatter aligns table columns, so the generated text goes through it before it is written or compared.
function formatted(markdown: string): string {
  const done = Bun.spawnSync(["bun", "fmt", "--stdin-filepath", REFERENCE], { stdin: Buffer.from(markdown) });
  if (done.exitCode !== 0) throw new Error(`bun fmt failed: ${done.stderr.toString()}`);
  return done.stdout.toString();
}

if (import.meta.main) {
  const current = readFileSync(REFERENCE, "utf8");
  const fresh = render(current);
  if (process.argv.includes("--check")) {
    if (fresh !== current) {
      console.error(`${REFERENCE} output tables are stale: run \`bun scripts/docs.ts\``);
      process.exit(1);
    }
  } else writeFileSync(REFERENCE, fresh);
}
