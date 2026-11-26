#!/usr/bin/env bun
import { homedir } from "node:os";
import { version } from "../package.json" with { type: "json" };
import type { Writer } from "./lib/output.ts";
import { systemProcesses } from "./lib/proc.ts";
import { run } from "./run.ts";

/** Once the reader is gone (`| head`), later output is dropped instead of crashing, so the wrapped command finishes. */
function untilReaderCloses(stream: NodeJS.WriteStream): Writer {
  let closed = false;
  const isClosed = (error: unknown) => (error as NodeJS.ErrnoException).code === "EPIPE";
  stream.on("error", (error) => {
    if (!isClosed(error)) throw error;
    closed = true;
  });
  return {
    write(chunk) {
      if (closed) return;
      try {
        stream.write(chunk);
      } catch (error) {
        if (!isClosed(error)) throw error;
        closed = true;
      }
    },
  };
}

process.exitCode = await run(process.argv.slice(2), {
  stdout: untilReaderCloses(process.stdout),
  stderr: untilReaderCloses(process.stderr),
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
