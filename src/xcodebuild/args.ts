import { isAbsolute, join, relative, resolve } from "node:path";

/** Options whose value names a file in the source tree; it is read from the slot's copy. */
const TREE_INPUTS = new Set(["-project", "-workspace", "-xcconfig", "-exportOptionsPlist"]);

/** Options whose value names a place outside the source tree; it stays where the caller meant it. */
const OUTSIDE_PATHS = new Set([
  "-resultBundlePath",
  "-resultStreamPath",
  "-archivePath",
  "-exportPath",
  "-xctestrun",
  "-testProductsPath",
  "-localizationPath",
  "-codesizeProfileOutputDir",
  "-importPath",
  "-authenticationKeyPath",
]);

/** Build settings that name where products go: built in the slot to stay warm, then cloned to where asked. */
const PRODUCT_SETTINGS = new Set(["SYMROOT", "DSTROOT", "BUILD_DIR", "BUILD_ROOT", "CONFIGURATION_BUILD_DIR"]);

/** Invocations that touch no project: they run where they are, without a slot. */
const NO_PROJECT = new Set([
  "-help",
  "-usage",
  "-version",
  "-showsdks",
  "-license",
  "-runFirstLaunch",
  "-checkFirstLaunchStatus",
  "-downloadPlatform",
  "-downloadAllPlatforms",
  "-importPlatform",
  "-downloadComponent",
  "-importComponent",
  "-create-xcframework",
  "-exportArchive",
  "-exportNotarizedApp",
]);

export const needsNoProject = (args: readonly string[]) => args.some((arg) => NO_PROJECT.has(arg));

export interface Places {
  /** Where the caller ran the command. */
  readonly cwd: string;
  readonly worktree: string;
  readonly slotSrc: string;
  readonly slotDerivedData: string;
}

export interface Rewritten {
  readonly args: string[];
  /** The slot directory that mirrors the caller's cwd. */
  readonly cwd: string;
  /** The DerivedData the caller asked for; the built products are handed out under it. */
  readonly derivedDataAsked?: string;
  /** Product folders a build setting placed in the worktree, built in the slot and cloned back after. */
  readonly handOut: readonly { readonly from: string; readonly to: string }[];
}

const isUnder = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const intoSlot = (path: string, places: Places) =>
  isAbsolute(path) && isUnder(path, places.worktree) ? join(places.slotSrc, relative(places.worktree, path)) : path;

/**
 * Points an xcodebuild command line at a slot without changing what it means: source-tree paths resolve in the
 * slot, everything else lands where the caller expects, and DerivedData is the slot's.
 */
export function rewriteArgs(args: readonly string[], places: Places): Rewritten {
  const out: string[] = [];
  const handOut: { from: string; to: string }[] = [];
  let derivedDataAsked: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const value = args[i + 1];
    if (arg === "-derivedDataPath" && value !== undefined) {
      derivedDataAsked = resolve(places.cwd, value);
      i++;
    } else if (TREE_INPUTS.has(arg) && value !== undefined) {
      out.push(arg, intoSlot(value, places));
      i++;
    } else if (OUTSIDE_PATHS.has(arg) && value !== undefined) {
      out.push(arg, resolve(places.cwd, value));
      i++;
    } else if (arg === "-test-enumeration-output-path" && value !== undefined) {
      out.push(arg, value === "-" ? value : resolve(places.cwd, value));
      i++;
    } else if (/^-(only|skip)-testing:@/.test(arg)) {
      const at = arg.indexOf("@");
      out.push(arg.slice(0, at + 1) + intoSlot(arg.slice(at + 1), places));
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      const at = arg.indexOf("=");
      const [name, setting] = [arg.slice(0, at), arg.slice(at + 1)];
      if (PRODUCT_SETTINGS.has(name)) {
        const asked = resolve(places.cwd, setting);
        const built = intoSlot(asked, places);
        if (built !== asked) handOut.push({ from: built, to: asked });
        out.push(`${name}=${built}`);
      } else {
        out.push(`${name}=${intoSlot(setting, places)}`);
      }
    } else {
      out.push(arg);
    }
  }
  out.push("-derivedDataPath", places.slotDerivedData);
  return {
    args: out,
    cwd: join(places.slotSrc, relative(places.worktree, places.cwd)),
    handOut,
    ...(derivedDataAsked !== undefined && { derivedDataAsked }),
  };
}
