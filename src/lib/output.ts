import type { NextCommand, XcslotError } from "./errors.ts";

export interface Writer {
  write(chunk: string | Uint8Array): unknown;
}

export type OutputMode = "json" | "human";

export interface CommandOutput<Data> {
  readonly data: Data;
  readonly summary?: string;
  readonly next?: readonly NextCommand[];
}

export function chooseMode(flags: { json: boolean }, stdoutIsTTY: boolean): OutputMode {
  return flags.json || !stdoutIsTTY ? "json" : "human";
}

// Escape and control characters, bidirectional overrides and tag characters could rewrite what a terminal shows.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩\u{e0000}-\u{e007f}]/gu;

export function forTerminal(text: string): string {
  return text.replace(UNSAFE, "�");
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "string" ? forTerminal(item) : item));
}

export function writeSuccess<Data>(
  mode: OutputMode,
  stdout: Writer,
  output: CommandOutput<Data>,
  render?: (output: CommandOutput<Data>) => string,
): void {
  if (mode === "json") {
    stdout.write(`${toJson({ ok: true, ...output })}\n`);
    return;
  }
  const text = render ? render(output) : (output.summary ?? toJson(output.data));
  stdout.write(`${forTerminal(text)}\n`);
  for (const hint of output.next ?? [])
    stdout.write(`  next: ${forTerminal(hint.command)}  (${forTerminal(hint.why)})\n`);
}

/** Failures always go to stderr, so a wrapped command's stdout stays its own. */
export function writeFailure(mode: OutputMode, stderr: Writer, error: XcslotError): void {
  if (mode === "json") {
    stderr.write(`${toJson({ ok: false, error })}\n`);
    return;
  }
  stderr.write(`xcslot: ${forTerminal(error.message)} [${error.code}]\n`);
  if (error.hint) stderr.write(`  ${forTerminal(error.hint)}\n`);
  for (const hint of error.next ?? [])
    stderr.write(`  next: ${forTerminal(hint.command)}  (${forTerminal(hint.why)})\n`);
}
