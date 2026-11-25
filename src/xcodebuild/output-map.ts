import { existsSync } from "node:fs";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// macOS reaches /var, /tmp and /etc through /private, and tools print either form of the same path.
export const spellings = (path: string) => [...new Set([path, path.replace(/^\/private(?=\/(var|tmp|etc)\/)/, "")])];

export interface LineMapper {
  (line: string): string;
  /** Text a line must contain to be worth mapping; other lines pass through as bytes. */
  readonly needles: readonly string[];
}

// Where a printed path can end before the line does; candidates are tried from the longest down.
const PATH_END = /[\s)\]>,;]/;
// A path rarely holds more spaces than this; a compiler's command line holds thousands after one.
const MAX_ENDS = 8;

/**
 * Rewrites the slot's source paths in a command's output to the worktree's, so a diagnostic names the file the
 * agent edits. A path that exists only in the slot (a generated file) is left alone, so it still opens.
 */
export function createPathMapper(
  slotSrc: string,
  worktree: string,
  exists: (path: string) => boolean = existsSync,
): LineMapper {
  const roots = spellings(slotSrc);
  const root = `(?:${roots.map(escapeRegExp).join("|")})`;
  // A path starts after a non-path character, an ANSI style or `file://`, and runs, spaces included, to a colon,
  // a quote, a control character or the next root.
  const pattern = new RegExp(
    `(?:(?<=\\x1b\\[[0-9;]*m)|(?<=file://)|(?<![\\w/.-]))${root}((?:/(?:(?!${root})[^:'"\\x00-\\x1f])*)?)`,
    "g",
  );
  const known = new Map<string, boolean>();
  const present = (path: string) => {
    let found = known.get(path);
    if (found === undefined) {
      found = exists(path);
      known.set(path, found);
    }
    return found;
  };
  const map = (line: string) => {
    if (!roots.some((root) => line.includes(root))) return line;
    return line.replace(pattern, (whole, rest: string) => {
      if (rest === "") return worktree;
      const ends: number[] = [];
      for (let at = 1; at < rest.length && ends.length < MAX_ENDS; at++) {
        if (PATH_END.test(rest[at] as string)) ends.push(at);
      }
      if (ends.length < MAX_ENDS) ends.push(rest.length);
      return ends.reverse().some((end) => present(worktree + rest.slice(0, end))) ? worktree + rest : whole;
    });
  };
  return Object.assign(map, { needles: roots });
}

const NEWLINE = 0x0a;

/**
 * Feeds a stream to `write` line by line, so a path split across two chunks is still rewritten. Only a line that
 * mentions a needle is decoded and mapped; everything else passes through byte for byte.
 */
export async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  map: LineMapper | undefined,
  write: (chunk: Uint8Array) => void,
): Promise<void> {
  const needles = (map?.needles ?? []).map((needle) => Buffer.from(needle));
  const decoder = new TextDecoder();
  const mapLine = (line: Buffer): Buffer =>
    map && needles.some((needle) => line.includes(needle)) ? Buffer.from(map(decoder.decode(line))) : line;
  let tail = Buffer.alloc(0);
  for await (const chunk of stream) {
    const text = Buffer.concat([tail, chunk]);
    const cut = text.lastIndexOf(NEWLINE) + 1;
    tail = text.subarray(cut);
    if (cut === 0) continue;
    const parts: Buffer[] = [];
    for (let start = 0; start < cut;) {
      const end = text.indexOf(NEWLINE, start);
      parts.push(mapLine(text.subarray(start, end)), text.subarray(end, end + 1));
      start = end + 1;
    }
    write(Buffer.concat(parts));
  }
  if (tail.length > 0) write(mapLine(tail));
}
