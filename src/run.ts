import { Command, CommanderError } from "@commander-js/extra-typings";
import { registerMisc } from "./commands/misc.ts";
import { type PassthroughOptions, runInSlot, type Wrapped } from "./commands/passthrough.ts";
import { registerSlots } from "./commands/slots.ts";
import type { Deps } from "./context.ts";
import { describe, type Finish } from "./define-command.ts";
import { exitCodes, failure, type XcslotError } from "./lib/errors.ts";
import { nextCommand } from "./lib/next.ts";
import { chooseMode, writeFailure, writeSuccess } from "./lib/output.ts";

interface RunState {
  exitCode: number;
}

const WRAPPED = new Set<string>(["xcodebuild", "run"]);
const OWN_VALUE_OPTIONS = new Set(["--products-to", "--wait", "--slots", "--from"]);

/**
 * xcslot's own options are double-dashed and come right after the command word; xcodebuild's are
 * single-dashed. Everything from the first word that is not ours goes to the wrapped command untouched, so a
 * `--` is put in front of it before the parser can read `-scheme` as a cluster of short flags.
 */
export function splitWrapped(argv: readonly string[]): string[] {
  const at = argv.findIndex((word) => !word.startsWith("-"));
  const command = argv[at];
  if (command === undefined || !WRAPPED.has(command)) return [...argv];
  let end = at + 1;
  while (end < argv.length) {
    const word = argv[end] as string;
    if (word === "--") return [...argv];
    if (!word.startsWith("--")) break;
    end += OWN_VALUE_OPTIONS.has(word) ? 2 : 1;
  }
  return [...argv.slice(0, end), "--", ...argv.slice(end)];
}

const wholeNumber = (name: string) => (value: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new CommanderError(1, "commander.invalidArgument", `${name} takes a whole number, got ${value}`);
  return parsed;
};

export function createProgram(deps: Deps, state: RunState): Command {
  const program = new Command()
    .name("xcslot")
    .description("Warm Xcode build slots for parallel coding agents")
    .version(deps.version, "-v, --version")
    .option("--json", "print JSON even in a terminal (always on when output is piped)", false)
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({ writeOut: (text) => deps.stdout.write(text), writeErr: () => {} });

  const mode = () => chooseMode({ json: program.opts().json }, deps.stdoutIsTTY);
  const fail = (error: XcslotError) => {
    writeFailure(mode(), deps.stderr, error);
    state.exitCode = exitCodes[error.code];
  };

  const finish: Finish = async (handler, render) => {
    const result = await handler();
    if (result.isErr()) return fail(result.error);
    writeSuccess(mode(), deps.stdout, result.value, render);
  };

  const wrap = (wrapped: Wrapped, description: string, examples: string[]) =>
    describe(
      program
        .command(wrapped)
        .description(description)
        .argument(
          "[args...]",
          wrapped === "mcp-build"
            ? "project or workspace, scheme, and optional destination display title"
            : wrapped === "run"
              ? "the command and its arguments, after --"
              : "xcodebuild's arguments, unchanged",
        )
        .option(
          "--products-to <dir>",
          "clone the built products here, with debug symbols; they outlive the slot's next build",
        )
        .option(
          "--no-dsym",
          "hand products out without debug symbols (faster, but a debugger may show wrong lines later)",
        )
        .option(
          "--wait <seconds>",
          "how long to wait for a free slot (default: the config's waitSeconds)",
          wholeNumber("--wait"),
        )
        .option("--no-wait", "fail at once with slots_busy when no slot is free")
        .option(
          "--slots <count>",
          "use up to this many slots for this run, and let as many builds run at once; extra slots are removed after a day unused",
          wholeNumber("--slots"),
        )
        .option("--from <dir>", "the worktree to build, instead of the current directory")
        .action(async (args, options) => {
          const passthrough: PassthroughOptions = {
            dsym: options.dsym,
            ...(options.from !== undefined && { from: options.from }),
            ...(options.wait !== undefined && { wait: options.wait }),
            ...(options.slots !== undefined && { slots: Math.max(1, options.slots) }),
            ...(options.productsTo !== undefined && { productsTo: options.productsTo }),
          };
          const result = await runInSlot(deps, passthrough, wrapped, args);
          if (result.isErr()) return fail(result.error);
          state.exitCode = result.value;
        }),
      {
        examples,
        errors: ["not_a_repository", "tool_missing", "slots_busy", "prepare_failed", "sync_failed", "state_invalid"],
        passthrough: true,
      },
    );

  wrap("xcodebuild", "Run xcodebuild in a warm slot: put `xcslot` in front of the command you already have", [
    "xcslot xcodebuild -scheme App -destination 'generic/platform=iOS Simulator' build",
    "xcslot xcodebuild --products-to build/Products -scheme App -destination 'generic/platform=iOS Simulator' build",
    "xcslot xcodebuild --no-wait -scheme App test",
  ]);
  wrap("run", "Run any build command in a warm slot, in the slot's copy of the current directory", [
    "xcslot run -- swift build",
    "xcslot run -- swift test --filter ParserTests",
  ]);
  wrap("mcp-build", "Build a project or workspace in a warm slot with Apple's headless Xcode service", [
    "xcslot mcp-build App.xcodeproj App",
    'xcslot mcp-build --products-to out App.xcworkspace "Demo App" "My Mac"',
  ]);
  registerSlots(program, deps, finish);
  registerMisc(program, deps, finish);
  return program;
}

/** Runs the CLI and returns its exit code; it never calls `process.exit`, so output always drains. */
export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  const state: RunState = { exitCode: 0 };
  const program = createProgram(deps, state);
  const mode = chooseMode({ json: argv.includes("--json") }, deps.stdoutIsTTY);
  try {
    await program.parseAsync(splitWrapped(argv), { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      if (error.code === "commander.help") {
        deps.stdout.write(program.helpInformation());
        return exitCodes.usage_error;
      }
      const usage = failure("usage_error", error.message.replace(/^error: /, ""), {
        hint: "Every command, its options and examples are in the catalog",
        next: [nextCommand("commands", "it lists every command with options and examples", { json: true })],
      });
      writeFailure(mode, deps.stderr, usage);
      return exitCodes.usage_error;
    }
    // Reaching here is a bug in xcslot, not something the caller did.
    writeFailure(
      mode,
      deps.stderr,
      failure("internal_error", error instanceof Error ? (error.stack ?? error.message) : String(error)),
    );
    return exitCodes.internal_error;
  }
  return state.exitCode;
}
