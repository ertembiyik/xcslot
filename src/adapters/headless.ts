import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import type { SlotPaths } from "../lib/layout.ts";
import headlessBuild from "./headless-build.py" with { type: "text" };
import { join } from "node:path";
import { failure, type XcslotError } from "../lib/errors.ts";
import { exec } from "../lib/proc.ts";
import { err, ok, type Result } from "../lib/result.ts";

/** Xcode owns the subdirectory name. Its metadata identifies the workspace even if another cache is present. */
export function headlessProductData(root: string, workspace: string): Result<string, XcslotError> {
  const candidates: string[] = [];
  for (const entry of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const info = join(dir, "info.plist");
    if (!existsSync(info) || !existsSync(join(dir, "Build", "Products"))) continue;
    const owner = exec(["/usr/bin/plutil", "-extract", "WorkspacePath", "raw", "-o", "-", info]);
    if (owner.isErr()) return err(owner.error);
    const path = owner.value.stdout.trim();
    if (owner.value.code === 0 && existsSync(path) && realpathSync(path) === realpathSync(workspace))
      candidates.push(dir);
  }
  return candidates.length === 1
    ? ok(candidates[0] as string)
    : err(failure("sync_failed", "Could not identify this workspace's built products"));
}

export const headlessMarker = (slot: SlotPaths) => join(slot.dir, "headless-session.json");

export function reusableWorkspace(slot: SlotPaths, project: string, data: string): boolean {
  try {
    const record = JSON.parse(readFileSync(headlessMarker(slot), "utf8"));
    if (!record.ready || record.project !== project || record.data !== data) return false;
    const launcher = exec(["xcrun", "--find", "mcp-server"]);
    return launcher.isOk() && launcher.value.code === 0 && launcher.value.stdout.trim() === record.launcher;
  } catch {
    return false;
  }
}

export const headlessCommand = (...args: string[]) => ["/usr/bin/python3", "-I", "-c", headlessBuild, ...args];

/** Called while holding the slot lock, including before the directory is removed. */
export function closeHeadlessWorkspace(slot: SlotPaths): Result<void, XcslotError> {
  if (!existsSync(headlessMarker(slot))) return ok(undefined);
  return exec(headlessCommand("--close", slot.src)).andThen((done) =>
    done.code === 0
      ? ok(undefined)
      : err(failure("sync_failed", `Could not close the slot workspace: ${done.stderr.trim()}`)),
  );
}
