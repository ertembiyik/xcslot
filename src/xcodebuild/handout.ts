import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
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
 * The binaries that carry code: plain executables and libraries outside bundles, at any depth, and inside each
 * bundle (flat, or laid out as on macOS) the executable plus, in Debug builds, the `*.debug.dylib` that holds
 * the code.
 */
export function debuggableBinaries(products: string): string[] {
  const found = new Set<string>();
  const machOIn = (dir: string) => {
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (file.isFile() && !file.name.endsWith(".o") && isMachO(join(dir, file.name))) found.add(join(dir, file.name));
    }
  };
  const walk = (dir: string, inBundle: boolean) => {
    if (!inBundle) machOIn(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (!entry.isDirectory() || entry.name.endsWith(".dSYM")) continue;
      const bundle = BUNDLE.test(entry.name);
      if (bundle) {
        for (const base of [path, join(path, "Contents", "MacOS"), join(path, "Versions", "A")]) {
          if (existsSync(base)) machOIn(base);
        }
      }
      walk(path, inBundle || bundle);
    }
  };
  if (existsSync(products)) walk(products, false);
  return [...found];
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

const binaryUUIDs = (path: string): string[] =>
  exec(["dwarfdump", "--uuid", path]).match(
    (done) =>
      done.code === 0 ? [...done.stdout.matchAll(/^UUID: ([0-9A-F-]+) /gm)].map((m) => m[1] as string).sort() : [],
    () => [],
  );

/** Keep Xcode's own dSYM when its DWARF payloads identify binaries we actually exported. */
function matchingSymbols(dsym: string, binaries: readonly string[]): string[] {
  const dwarf = join(dsym, "Contents", "Resources", "DWARF");
  if (!existsSync(dwarf)) return [];
  const ids: string[] = [];
  const payloads = readdirSync(dwarf);
  const mainDebug = binaries.find((binary) => binary.endsWith(".debug.dylib") && dirname(binary) === dsym.slice(0, -5));
  if (mainDebug && !payloads.includes(basename(mainDebug))) return [];
  for (const name of payloads) {
    const expected = binaryUUIDs(join(dwarf, name));
    if (
      expected.length === 0 ||
      !binaries.some((binary) => basename(binary) === name && binaryUUIDs(binary).join() === expected.join())
    )
      return [];
    ids.push(...expected);
  }
  return ids;
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
      let uuids = matchingSymbols(dsym, binaries);
      if (!uuids.length) {
        const done = Bun.spawn(["dsymutil", ...binaries, "-o", dsym], { stdout: "ignore", stderr: "pipe" });
        const warnings = await new Response(done.stderr).text();
        const empty = warnings.split("no debug symbols in executable").length - 1 >= binaries.length;
        if ((await done.exited) !== 0 || empty) {
          rmSync(dsym, { recursive: true, force: true });
          return false;
        }
        uuids = binaryUUIDs(dsym);
      }
      for (const uuid of uuids) {
        writeFileSync(join(dsym, "Contents", "Resources", `${uuid}.plist`), remapPlist(slotSrc, worktree));
      }
      return uuids.length > 0;
    }),
  );
  return made.filter(Boolean).length;
}

/**
 * Clones the slot's built products into a `--products-to` folder, which xcslot owns and replaces whole. An APFS
 * clone is instant, takes no space until either side changes, and outlives the next build in the slot.
 */
export function cloneProducts(derivedData: string, destination: string): Result<string, XcslotError> {
  const products = join(derivedData, "Build", "Products");
  if (!existsSync(products) || readdirSync(products).length === 0)
    return err(failure("sync_failed", `No built products to export from ${products}`));
  const usable = checkProductsDestination(destination);
  if (usable.isErr()) return err(usable.error);
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

/**
 * Clones built products into a folder the caller shares with other output: folders merge, and each file or
 * bundle is replaced whole, so a rebuilt app never keeps a resource it dropped. Anything else stays. Paths `keep`
 * names are left alone. Returns how many entries were cloned.
 */
export function mergeProducts(
  from: string,
  to: string,
  keep: (path: string) => boolean = () => false,
): Result<number, XcslotError> {
  if (!existsSync(from)) return ok(0);
  let cloned = 0;
  const merge = (source: string, target: string): Result<void, XcslotError> => {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const [inner, outer] = [join(source, entry.name), join(target, entry.name)];
      if (keep(outer)) continue;
      if (entry.isDirectory() && !BUNDLE.test(entry.name) && !entry.name.endsWith(".dSYM")) {
        if (existsSync(outer) && !lstatSync(outer).isDirectory()) rmSync(outer);
        const merged = merge(inner, outer);
        if (merged.isErr()) return merged;
        continue;
      }
      rmSync(outer, { recursive: true, force: true });
      const done = exec(["cp", "-c", "-R", inner, outer]);
      if (done.isErr()) return err(done.error);
      if (done.value.code !== 0) {
        return err(failure("sync_failed", `Could not clone ${inner} to ${outer}: ${done.value.stderr.trim()}`));
      }
      cloned++;
    }
    return ok(undefined);
  };
  return merge(from, to).map(() => cloned);
}
