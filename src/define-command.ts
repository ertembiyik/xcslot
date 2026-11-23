import type { CommandUnknownOpts } from "@commander-js/extra-typings";
import type { ErrorCode, XcslotError } from "./lib/errors.ts";
import type { CommandOutput } from "./lib/output.ts";
import type { Result } from "./lib/result.ts";

/** Facts about a command that its help text and `xcslot commands` are both built from. */
export interface CommandMeta {
  readonly examples: readonly string[];
  /** Expected failures. Parse failures and bugs are added for every command. */
  readonly errors: readonly ErrorCode[];
  /** Deletes something; needs `--yes`. */
  readonly destructive?: boolean;
  /** Passes its arguments to another program, whose output and exit code it hands through. */
  readonly passthrough?: boolean;
}

export type Handler<Data> = () =>
  Result<CommandOutput<Data>, XcslotError> | Promise<Result<CommandOutput<Data>, XcslotError>>;
export type Finish = <Data>(handler: Handler<Data>, render?: (output: CommandOutput<Data>) => string) => Promise<void>;

const registry = new WeakMap<object, CommandMeta>();

export function describe<C extends CommandUnknownOpts>(command: C, meta: CommandMeta): C {
  const errors = [...new Set<ErrorCode>(["usage_error", "internal_error", ...meta.errors])];
  registry.set(command, { ...meta, errors });
  command.addHelpText(
    "after",
    [
      "",
      "Examples:",
      ...meta.examples.map((example) => `  $ ${example}`),
      "",
      `Errors: ${errors.join(", ")}`,
      meta.passthrough
        ? "Output: the wrapped command's own stdout, stderr and exit code; xcslot's lines go to stderr with an `xcslot:` prefix"
        : "Output: JSON when piped or with --json: { ok, data, summary?, next? } on stdout; failures as { ok: false, error } on stderr",
    ].join("\n"),
  );
  return command;
}

export const metaOf = (command: object): CommandMeta | undefined => registry.get(command);
