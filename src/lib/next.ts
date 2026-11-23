import type { NextCommand } from "./errors.ts";

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** `value` as one POSIX shell word. */
export function shellQuote(value: string): string {
  return SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Commands a hint may name: they read, and decide nothing for the person. */
export const READ_ONLY_COMMANDS = ["status", "slots list", "doctor", "commands"] as const;
export type ReadOnlyCommand = (typeof READ_ONLY_COMMANDS)[number];

export function nextCommand(
  path: ReadOnlyCommand,
  why: string,
  flags: Readonly<Record<string, string | boolean>> = {},
): NextCommand {
  const words = ["xcslot", ...path.split(" ")];
  for (const [name, value] of Object.entries(flags)) {
    if (value === false) continue;
    words.push(value === true ? `--${name}` : `--${name}=${shellQuote(value)}`);
  }
  return { command: words.join(" "), why };
}
