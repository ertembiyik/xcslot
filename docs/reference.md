# Reference

Every command, its options, what it prints and how it fails. `xcslot commands --json` prints the same catalog
for an agent, with examples.

## Commands

| Command                                  | What it does                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `xcslot xcodebuild <xcodebuild args>`    | Runs `xcodebuild` in a warm slot. Builds, tests and archives.               |
| `xcslot run -- <command>`                | Runs any other build command in the slot's copy of the current directory.   |
| `xcslot status`                          | Who holds what right now: every repository's slots and the machine-wide cap |
| `xcslot slots list [--sizes]`            | This repository's slots: holder, the worktree each is warm for, size.       |
| `xcslot slots remove <n> \| --all --yes` | Deletes slots and their build data. The next build there is a cold one.     |
| `xcslot slots prune`                     | Runs the daily housekeeping now.                                            |
| `xcslot doctor`                          | Checks the tools, the config and the slots folder; each failure says how.   |
| `xcslot commands [--json]`               | Lists every command with its options, examples and errors.                  |
| `xcslot skill`                           | Prints the skill that teaches an agent to build through xcslot.             |
| `xcslot skill install --dir <folder>`    | Writes the skill into a skills folder as `xcslot/SKILL.md`.                 |

## Options of `xcodebuild` and `run`

`xcslot`'s own options are double-dashed and come right after the command word. Everything from the first other
word goes to the wrapped command untouched.

```text
xcslot xcodebuild --products-to build/out -scheme App -configuration Debug build
                  └── xcslot's ────────┘ └── xcodebuild's ───────────────────┘
```

| Option                          | Meaning                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--products-to <dir>`           | Clone the built products to a folder you own. They outlive the slot's next build and carry debug symbols. |
| `--no-dsym`                     | Hand products out without debug symbols.                                                                  |
| `--wait <seconds>`, `--no-wait` | How long to wait for a free slot. The default is an hour.                                                 |
| `--slots <count>`               | Use up to this many slots for this run. Slots above the configured count are removed after a day unused.  |
| `--from <dir>`                  | The worktree to build, instead of the current directory.                                                  |

## What comes back

- **Output and exit code** of the wrapped command, unchanged. Lines that start with `xcslot:` are xcslot's own
  and go to stderr; the last one names the slot, the products and the full log (the last ten are kept).
- **Paths.** The slot's source paths in the output are rewritten to your worktree's, so
  `Sources/App/View.swift:12:5: error:` names the file you edit.
- **Files the build wrote** into the source tree (recorded snapshot references, an updated `Package.resolved`,
  linter fixes) are copied back to the worktree and listed. A file that you also changed during the build is
  left alone and named.
- **Products.** With `--products-to`, your own `-derivedDataPath`, or a build setting that puts products in
  the worktree (`SYMROOT`, `DSTROOT`, `BUILD_DIR`, `BUILD_ROOT`, `CONFIGURATION_BUILD_DIR`), the products are
  built in the slot and cloned to where you asked. A `--products-to` folder must be new, empty or one xcslot made,
  and is checked before the build. Each app, framework and plain binary gets a dSYM beside it (never inside a bundle, so
  signatures stay valid) with a record that maps source paths to your worktree, so a debugger shows the right
  lines after the slot is reused.

A filter such as `xcsift` or `xcbeautify` reads stdout. Keep stderr out of that pipe, or xcslot's own lines are
swallowed with it:

```sh
set -o pipefail; xcslot xcodebuild -scheme App build | xcbeautify
```

## Waiting

There are a few slots per repository and a machine-wide cap on commands running at once. When everything is
busy, `xcslot` says who holds each slot and waits; it never looks hung. `xcslot status` shows the same at any
time. After the wait runs out it fails with `slots_busy` (exit code 110).

## JSON and errors

Data commands print one JSON document on stdout when piped or with `--json`:

```json
{ "ok": true, "data": {}, "summary": "…", "next": [] }
```

xcslot's own failures are one JSON document on stderr, and each `next` command is safe to run as printed:

```json
{
  "ok": false,
  "error": {
    "code": "slots_busy",
    "message": "…",
    "hint": "…",
    "retryable": true,
    "next": [{ "command": "xcslot status", "why": "…" }]
  }
}
```

The wrapped command's own failures keep its exit code (65 for a failed `xcodebuild`). xcslot's start at 100:

| Error                   | Exit code | Meaning                                                    |
| ----------------------- | --------- | ---------------------------------------------------------- |
| `internal_error`        | 100       | A bug in xcslot.                                           |
| `usage_error`           | 101       | An option xcslot does not know, or a missing value.        |
| `not_a_repository`      | 102       | The directory is not inside a git repository.              |
| `tool_missing`          | 103       | A program xcslot needs is not on `PATH`.                   |
| `slots_busy`            | 110       | No slot came free within the wait. Safe to retry.          |
| `slot_not_found`        | 111       | No slot has that number.                                   |
| `confirmation_required` | 112       | A deleting command was run without `--yes`.                |
| `prepare_failed`        | 113       | A step before the build (`tuist generate`, yours) failed.  |
| `sync_failed`           | 114       | The worktree could not be mirrored. Safe to retry.         |
| `state_invalid`         | 115       | A config file does not match its schema; the message says. |

## Output of `slots list` and `status`

`xcslot slots list --json`, `data`:

<!-- output:slots list -->

| Field                    | Type               | Meaning                                                                         |
| ------------------------ | ------------------ | ------------------------------------------------------------------------------- |
| `repository`             | string             | The repository's main checkout                                                  |
| `directory`              | string             | Where its slots live                                                            |
| `slots`                  | object[]           | One entry per slot that exists                                                  |
| `slots[].n`              | integer            | Slot number                                                                     |
| `slots[].path`           | string             | The slot's folder: `src` is the mirrored checkout, `DerivedData` the build data |
| `slots[].busy`           | boolean            | Whether a command holds the slot now                                            |
| `slots[].holder`         | object (optional)  | Who holds it, when busy                                                         |
| `slots[].holder.pid`     | integer            | Process that holds it                                                           |
| `slots[].holder.label`   | string             | The command it runs and the worktree it runs for                                |
| `slots[].holder.seconds` | integer            | How long it has held it                                                         |
| `slots[].warmFor`        | string (optional)  | The worktree it was last synced from                                            |
| `slots[].head`           | string (optional)  | The commit it last built                                                        |
| `slots[].lastUsed`       | string (optional)  | When it was last used, ISO 8601                                                 |
| `slots[].bytes`          | integer (optional) | Size on disk; only with --sizes                                                 |

<!-- /output:slots list -->

`xcslot status --json`, `data`:

<!-- output:status -->

| Field                                   | Type               | Meaning                                                                         |
| --------------------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `root`                                  | string             | The folder all slots live in                                                    |
| `permits`                               | object             | The machine-wide cap                                                            |
| `permits.max`                           | integer            | Heavy commands allowed at once on this Mac                                      |
| `permits.holders`                       | object[]           | The commands running now                                                        |
| `permits.holders[].pid`                 | integer            | Process that holds it                                                           |
| `permits.holders[].label`               | string             | The command it runs and the worktree it runs for                                |
| `permits.holders[].seconds`             | integer            | How long it has held it                                                         |
| `repositories`                          | object[]           | Every repository that has slots                                                 |
| `repositories[].repository`             | string             | The repository's main checkout                                                  |
| `repositories[].directory`              | string             | Where its slots live                                                            |
| `repositories[].slots`                  | object[]           | One entry per slot that exists                                                  |
| `repositories[].slots[].n`              | integer            | Slot number                                                                     |
| `repositories[].slots[].path`           | string             | The slot's folder: `src` is the mirrored checkout, `DerivedData` the build data |
| `repositories[].slots[].busy`           | boolean            | Whether a command holds the slot now                                            |
| `repositories[].slots[].holder`         | object (optional)  | Who holds it, when busy                                                         |
| `repositories[].slots[].holder.pid`     | integer            | Process that holds it                                                           |
| `repositories[].slots[].holder.label`   | string             | The command it runs and the worktree it runs for                                |
| `repositories[].slots[].holder.seconds` | integer            | How long it has held it                                                         |
| `repositories[].slots[].warmFor`        | string (optional)  | The worktree it was last synced from                                            |
| `repositories[].slots[].head`           | string (optional)  | The commit it last built                                                        |
| `repositories[].slots[].lastUsed`       | string (optional)  | When it was last used, ISO 8601                                                 |
| `repositories[].slots[].bytes`          | integer (optional) | Size on disk; only with --sizes                                                 |

<!-- /output:status -->
