import type { Env } from "./lib/layout.ts";
import type { Writer } from "./lib/output.ts";
import type { ProcessTable } from "./lib/proc.ts";

/** Everything the CLI takes from the outside world, so tests can run it in-process. */
export interface Deps {
  readonly stdout: Writer;
  readonly stderr: Writer;
  readonly stdoutIsTTY: boolean;
  readonly env: Env;
  readonly cwd: string;
  readonly home: string;
  readonly version: string;
  readonly pid: number;
  readonly processes: ProcessTable;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}
