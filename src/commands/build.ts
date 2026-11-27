import { existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { nestedHeadlessData } from "../adapters/headless.ts";
import type { Deps } from "../context.ts";
import { type BuildEngine, loadUserConfig } from "../lib/config.ts";
import { failure, type XcslotError } from "../lib/errors.ts";
import { configPath } from "../lib/layout.ts";
import { err, type Result } from "../lib/result.ts";
import { runInSlot, type PassthroughOptions } from "./passthrough.ts";

const SIMULATOR = "generic/platform=iOS Simulator";

/** Translate only requests whose action, scheme and destination the MCP build tool can express. */
export function simpleBuild(args: readonly string[], cwd: string): string[] | undefined {
  let project: string | undefined;
  let scheme: string | undefined;
  let destination: string | undefined;
  let action = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "build" && !action) {
      action = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("-")) return undefined;
    if ((arg === "-project" || arg === "-workspace") && project === undefined) {
      if (!value.endsWith(arg === "-project" ? ".xcodeproj" : ".xcworkspace")) return undefined;
      project = resolve(cwd, value);
    } else if (arg === "-scheme" && scheme === undefined) scheme = value;
    else if (arg === "-destination" && destination === undefined && value === SIMULATOR) destination = value;
    else return undefined;
  }
  if (!scheme) return undefined;
  if (!project && existsSync(cwd)) {
    const candidates = readdirSync(cwd, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && /\.(xcodeproj|xcworkspace)$/.test(e.name),
    );
    if (candidates.length === 1) project = resolve(cwd, candidates[0]!.name);
  }
  return project && existsSync(project) ? [realpathSync(project), scheme] : undefined;
}

function unavailable(deps: Deps): string | undefined {
  if (process.platform !== "darwin") return "headless Xcode requires macOS";
  try {
    const status = Bun.spawnSync(["xcrun", "mcp-server", "status", "--format", "json"], {
      env: deps.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3000,
    });
    if (status.exitCode !== 0) return "headless Xcode is unavailable";
    const data = JSON.parse(status.stdout.toString());
    if (!data.permission?.enabled) return "headless Xcode is disabled";
    if (data.running && !Array.isArray(data.openWorkspaces)) return "headless Xcode did not respond";
  } catch {
    return "headless Xcode is unavailable";
  }
}

/** The build command has a compact output contract. The raw xcodebuild command stays untouched. */
export async function automaticBuild(
  deps: Deps,
  options: PassthroughOptions,
  args: readonly string[],
  override?: BuildEngine,
): Promise<Result<number, XcslotError>> {
  const config = loadUserConfig(configPath(deps.env, deps.home));
  if (config.isErr()) return err(config.error);
  const engine = override ?? config.value.buildEngine;
  const cwd = resolve(deps.cwd, options.from ?? ".");
  const simple = simpleBuild(args, cwd);
  const cliArgs = simple && !args.includes("-destination") ? [...args, "-destination", SIMULATOR] : args;
  const cli = (reason: string) => {
    deps.stderr.write(`xcslot: using xcodebuild (${reason})\n`);
    return runInSlot(deps, options, "xcodebuild", cliArgs);
  };
  if (engine === "xcodebuild") return cli("selected engine");
  const reason = deps.env.XCODE_XCCONFIG_FILE
    ? "caller supplied XCODE_XCCONFIG_FILE"
    : !simple
      ? "request requires xcodebuild arguments"
      : (deps.env.XCSLOT_DERIVED_DATA ?? nestedHeadlessData(deps, existsSync(cwd) ? realpathSync(cwd) : cwd))
        ? "already inside a slot"
        : unavailable(deps);
  if (reason || !simple) {
    if (engine === "mcp") return err(failure("usage_error", reason ?? "Unsupported MCP build request"));
    return cli(reason ?? "unsupported request");
  }
  deps.stderr.write("xcslot: using MCP (compatible build)\n");
  const result = await runInSlot(deps, options, "mcp-build", simple);
  if (engine === "auto" && result.isErr() && result.error.details?.beforeBuild === true) {
    return cli(result.error.code === "usage_error" ? result.error.message : "MCP setup unavailable");
  }
  return result;
}
