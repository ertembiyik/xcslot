import { existsSync } from "node:fs";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// macOS reaches /var, /tmp and /etc through /private, and tools print either form of the same path.
export const spellings = (path: string) => [...new Set([path, path.replace(/^\/private(?=\/(var|tmp|etc)\/)/, "")])];

/**
 * Rewrites the slot's source paths in a command's output to the worktree's, so a diagnostic names the file the
 * agent edits. A path that exists only in the slot (a generated file) is left alone, so it still opens.
 */
export function createPathMapper(
  slotSrc: string,
  worktree: string,
  exists: (path: string) => boolean = existsSync,
): (line: string) => string {
  const roots = spellings(slotSrc);
  const pattern = new RegExp(`(?<![\\w/.-])(?:${roots.map(escapeRegExp).join("|")})((?:/[^\\s:'"]*)?)`, "g");
  const known = new Map<string, boolean>();
  return (line) => {
    if (!roots.some((root) => line.includes(root))) return line;
    return line.replace(pattern, (whole, rest: string) => {
      const mapped = worktree + rest;
      let present = known.get(mapped);
      if (present === undefined) {
        present = exists(mapped);
        known.set(mapped, present);
      }
      return present ? mapped : whole;
    });
  };
}

/** Feeds a stream to `write` line by line, so a path split across two chunks is still rewritten. */
export async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  map: (line: string) => string,
  write: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let tail = "";
  for await (const chunk of stream) {
    const text = tail + decoder.decode(chunk, { stream: true });
    const cut = text.lastIndexOf("\n") + 1;
    tail = text.slice(cut);
    if (cut > 0) write(text.slice(0, cut).split("\n").map(map).join("\n"));
  }
  if (tail) write(map(tail));
}
