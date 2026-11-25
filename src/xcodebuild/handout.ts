import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { failure, type XcslotError } from "../lib/errors.ts";
import { exec } from "../lib/proc.ts";
import { err, ok, type Result } from "../lib/result.ts";
import { PRODUCTS_MARKER } from "../slot/sync.ts";
import { spellings } from "./output-map.ts";

const BUNDLE = /\.(app|appex|framework|xctest)$/;
const MACH_O_MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(path: string): boolean {
  const header = Buffer.alloc(4);
  const fd = openSync(path, "r");
  try {
    return readSync(fd, header, 0, 4, 0) === 4 && MACH_O_MAGIC.has(header.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

/**
 * The binaries that carry code: plain executables and libraries in a configuration folder, and inside each
 * bundle (flat, or laid out as on macOS) the executable plus, in Debug builds, the `*.debug.dylib` that holds
 * the code.
 */
export function debuggableBinaries(products: string): string[] {
  const found: string[] = [];
  const machOIn = (dir: string) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((file) => file.isFile() && !file.name.endsWith(".o") && isMachO(join(dir, file.name)))
      .map((file) => join(dir, file.name));
  const walk = (dir: string, depth: number) => {
    if (depth === 1) found.push(...machOIn(dir));
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (!entry.isDirectory() || entry.name.endsWith(".dSYM")) continue;
      if (BUNDLE.test(entry.name)) {
        for (const base of [path, join(path, "Contents", "MacOS"), join(path, "Versions", "A")]) {
          if (existsSync(base)) found.push(...machOIn(base));
        }
      }
      walk(path, depth + 1);
    }
  };
  walk(products, 0);
  return found;
}

const remapPlist = (from: string, to: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>DBGVersion</key><string>3</string>
<key>DBGSourcePathRemapping</key><dict>
${spellings(from)
  .map((spelling) => `<key>${escapeXml(spelling)}</key><string>${escapeXml(to)}</string>`)
  .join("\n")}
</dict>
</dict></plist>
`;
const escapeXml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Where a binary's dSYM goes: beside the outermost bundle that holds it. A file added inside a signed bundle
 * breaks its seal, and a debugger looks for `<Bundle>.dSYM` next to the bundle anyway.
 */
function dsymFor(products: string, binary: string): string {
  const parts = relative(products, binary).split(sep);
  const outer = parts.findIndex((part) => BUNDLE.test(part));
  return outer === -1 ? `${binary}.dSYM` : `${join(products, ...parts.slice(0, outer + 1))}.dSYM`;
}

/**
 * Debug builds keep their debug info in the slot's object files, which the next build in the slot replaces; a
 * debugger would then show wrong lines. A dSYM made while the slot is still held carries the debug info with
 * the product, and its remapping record points source paths at the worktree.
 */
export async function embedDebugSymbols(products: string, slotSrc: string, worktree: string): Promise<number> {
  const groups = Map.groupBy(debuggableBinaries(products), (binary) => dsymFor(products, binary));
  const made = await Promise.all(
    [...groups].map(async ([dsym, binaries]) => {
      const done = Bun.spawn(["dsymutil", ...binaries, "-o", dsym], { stdout: "ignore", stderr: "pipe" });
      const warnings = await new Response(done.stderr).text();
      const empty = warnings.split("no debug symbols in executable").length - 1 >= binaries.length;
      if ((await done.exited) !== 0 || empty) {
        rmSync(dsym, { recursive: true, force: true });
        return false;
      }
      const uuids = exec(["dwarfdump", "--uuid", dsym]).match(
        (out) => [...out.stdout.matchAll(/^UUID: ([0-9A-F-]+) /gm)].map((match) => match[1] as string),
        () => [],
      );
      for (const uuid of uuids) {
        writeFileSync(join(dsym, "Contents", "Resources", `${uuid}.plist`), remapPlist(slotSrc, worktree));
      }
      return uuids.length > 0;
    }),
  );
  return made.filter(Boolean).length;
}

/**
 * Clones the slot's built products to a directory the caller owns. An APFS clone is instant, takes no space
 * until either side changes, and outlives the next build in the slot.
 */
export function cloneProducts(derivedData: string, destination: string): Result<string, XcslotError> {
  const products = join(derivedData, "Build", "Products");
  if (!existsSync(products)) return ok(destination);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  return exec(["cp", "-c", "-R", products, destination]).andThen((done) => {
    if (done.code !== 0) return err(failure("sync_failed", `Could not clone products: ${done.stderr.trim()}`));
    writeFileSync(join(destination, PRODUCTS_MARKER), "");
    return ok(destination);
  });
}

/** A `--products-to` folder is replaced on every build, so it must be new, empty or one xcslot made. */
export function checkProductsDestination(destination: string): Result<string, XcslotError> {
  if (
    existsSync(destination) &&
    readdirSync(destination).length > 0 &&
    !existsSync(join(destination, PRODUCTS_MARKER))
  ) {
    return err(
      failure("usage_error", `${destination} exists and was not created by xcslot`, {
        hint: "Pass an empty or new directory for the products, or remove this one yourself",
      }),
    );
  }
  return ok(destination);
}

/** Clones a folder's contents over another, leaving whatever else the destination holds. */
export function cloneInto(from: string, to: string): Result<string, XcslotError> {
  if (!existsSync(from)) return ok(to);
  mkdirSync(to, { recursive: true });
  return exec(["cp", "-c", "-R", `${from}/.`, to]).andThen((done) =>
    done.code === 0 ? ok(to) : err(failure("sync_failed", `Could not clone ${from} to ${to}: ${done.stderr.trim()}`)),
  );
}
