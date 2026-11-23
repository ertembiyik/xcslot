#!/usr/bin/env bun
import { homedir } from "node:os";
import { version } from "../package.json" with { type: "json" };
import { systemProcesses } from "./lib/proc.ts";
import { run } from "./run.ts";

process.exitCode = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdoutIsTTY: process.stdout.isTTY === true,
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  version,
  pid: process.pid,
  processes: systemProcesses,
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
});
