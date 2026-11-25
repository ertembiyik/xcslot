# AGENTS.md

`xcslot` is a prefix for build commands: `xcslot xcodebuild …` mirrors the caller's git worktree into a slot at
a fixed path and runs the command there, so Xcode's build data stays warm across worktrees. Its users are
mostly coding agents. [README.md](README.md) is the product description and [docs/](docs) the reference;
this file is what you need to change the code. `CLAUDE.md` is a symlink to it.

## Commands

```sh
bun install                         # also wires the git hooks (husky)
bun run verify                      # format check, types, reference tables, fast tests; the pre-push hook runs it
bun run xcslot -- <args>            # the CLI from source
XCSLOT_E2E=1 bun test test/e2e.test.ts   # real xcodebuild on a generated Swift package; macOS, about 10 s warm
bun fmt                             # format
bun run docs                        # regenerate the tables in docs/reference.md after changing src/commands/schemas.ts
bun run build                       # standalone binaries in dist/
bun run art                         # re-render the header, chart and chips from scripts/art/*.html (needs Chrome)
```

Use bun for everything. `bun lint` joins `verify` when Bun 1.4.6 is stable; it is not in 1.4.5.

## The invariants

- **A slot's path never changes and unchanged files keep their mtime.** Both are what makes a build incremental.
  `syncInto` rewrites a file only when its content differs. Anything that touches files in a slot's `src`
  without need turns the next build cold; the end-to-end test asserts zero `SwiftCompile` lines for a fresh
  worktree.
- **A changed file gets a new mtime.** An APFS clone carries the source's mtime, so `copyEntry` stamps "now".
- **xcslot never models the wrapped command.** It rewrites path arguments (`src/xcodebuild/args.ts`) and
  nothing else. It adds no build settings; in particular it does not turn on Xcode's compilation cache.
- **stdout belongs to the wrapped command.** xcslot's own lines go to stderr with an `xcslot:` prefix, and its
  own failures are one JSON object on stderr with an exit code from `src/lib/errors.ts` (100 and up, outside
  the range xcodebuild uses).
- **Expected failures are Results.** `neverthrow` is imported only through `src/lib/result.ts`; a thrown
  exception is a bug and surfaces as `internal_error`. `run()` returns the exit code and never calls
  `process.exit`.
- **Never prompt.** A destructive command needs `--yes` and otherwise fails with `confirmation_required`.
- **A `next` hint names only a command in `READ_ONLY_COMMANDS`** and must run as printed.
- **A lock's owner is a pid plus that process's start time**, so a reused pid cannot hold a dead lock. A slot
  with a live lock is never removed, by anyone.

## When you change something

| Change                                             | Also do                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Any code                                           | `bun run verify`. Test observable behaviour through `cli()` in `test/helpers.ts`, with made-up data.                   |
| Sync, hand-out, argument rewriting, output mapping | Run the end-to-end test; it is the only one that proves the build stays warm.                                          |
| A new error code                                   | Add it to `exitCodes` and `retryable`; the build fails until both have it. Add it to the table in `docs/reference.md`. |
| An output shape in `schemas.ts`                    | `bun run docs`; a test fails while `docs/reference.md` is stale.                                                       |
| `skills/xcslot/SKILL.md`                           | Every `bash` line must be a real command with real options; a test checks them against the catalog.                    |
| A new command                                      | Wrap it in `describe(...)` with examples and errors, or it is missing from `xcslot commands`.                          |

## Learned the hard way

- **macOS spells one path two ways.** A slot under `/private/var/…` appears in xcodebuild's output and in debug
  info as `/var/…`. The output mapper and the dSYM remapping record both spellings (`spellings()`).
- **xcodebuild's options are single-dashed words.** A parser reads `-scheme` as a cluster of short flags, so
  `splitWrapped` inserts `--` before the first word that is not one of xcslot's own options.
- **`git ls-files -o` lists a nested repository or worktree as one entry ending in `/`.** It is not a file.
- **Debug builds keep debug info in the slot's object files.** After the slot is rebuilt, a debugger attached
  to an older product shows wrong lines without failing. Products are handed out with a dSYM for that reason.
- **Debug app bundles keep their code in `<Name>.debug.dylib`**, not in the small launcher executable.
- **`bun fmt` reflows HTML text.** Terminal text in `scripts/art/*.html` lives in `<pre>`, which it leaves alone;
  anything else loses its line breaks, and the next `bun run art` renders it as one line.
- **A git hook exports `GIT_DIR`.** Inherited, it aims every git call at the hook's repository: tests run by the
  pre-push hook in a worktree once made the repository bare and committed into its branch. `exec`, the wrapped
  command and the test helper drop git's repository variables.
- **`xcodebuild -list` without `-derivedDataPath` writes package checkouts into Xcode's default DerivedData.**
  Metadata queries go through the slot too.

## Releases

A tag `vX.Y.Z` that matches `package.json` runs `.github/workflows/release.yml`: verify, both macOS binaries,
checksums, a GitHub Release, then the Homebrew formula pushed to the tap with the tap's deploy key. Never
publish from a local machine, and never move or delete a release tag.
