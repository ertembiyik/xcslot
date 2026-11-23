# xcslot

Warm Xcode build slots for parallel coding agents.

A fresh git worktree builds from scratch, because Xcode reuses build data only at the same path with the same
file timestamps. `xcslot` keeps a few build slots at fixed paths, mirrors your worktree into a free one and runs
your build command there. The first build of a new worktree becomes an incremental one.

```sh
xcslot xcodebuild -scheme App -destination 'generic/platform=iOS Simulator' build
```

Put `xcslot` in front of the command you already run. It passes every argument through, and the output and exit
code come back unchanged, with paths pointing at your worktree.

## What it saves

Measured on [IceCubesApp](https://github.com/Dimillian/IceCubesApp) at commit `9efcb16` (1,510 Swift files with
dependencies), Xcode 27.0, a 12-core Apple silicon Mac with other work running. Wall time of `xcodebuild`, one
run each unless noted.

| A fresh worktree's first build                    | Time                                                      | Swift files compiled            |
| ------------------------------------------------- | --------------------------------------------------------- | ------------------------------- |
| Its own DerivedData (cold)                        | 82 to 107 s over four runs                                | 1,510                           |
| DerivedData cloned in from another worktree       | 107 s                                                     | 1,510                           |
| Xcode's compilation cache shared across worktrees | 43 s                                                      | 0 misses, every task still runs |
| Through a warm slot                               | 4.7 s, 4.8 s and 19 s over three runs, plus 0.2 s to sync | 0                               |

A one-file edit costs the same everywhere (33 to 35 s here, because the edited module has dependents). Moving a
slot to a commit ten commits away rebuilt exactly the files an in-place `git checkout` rebuilds (1,284).

## Install

```sh
brew install ertembiyik/tap/xcslot
```

macOS only, Apple silicon and Intel. `xcslot doctor` checks that everything it needs is in place.

## Use

```sh
xcslot xcodebuild <any xcodebuild arguments>   # builds, tests, archives
xcslot run -- swift build                      # any other build command
xcslot status                                  # who holds which slot right now
```

`xcslot`'s own options are double-dashed and come right after the command word; everything from the first other
word goes to the wrapped command untouched.

| Option                          | Meaning                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--products-to <dir>`           | Clone the built products to a folder you own. They outlive the slot's next build and carry debug symbols. |
| `--no-dsym`                     | Hand products out without debug symbols.                                                                  |
| `--wait <seconds>`, `--no-wait` | How long to wait for a free slot. The default is an hour.                                                 |
| `--slots <count>`               | Use up to this many slots for this run. Slots above the configured count are removed after a day unused.  |
| `--from <dir>`                  | The worktree to build, instead of the current directory.                                                  |

### What comes back

- **Output and exit code** of the wrapped command, unchanged. Lines that start with `xcslot:` are xcslot's own
  and go to stderr; the last one names the slot, the products and the full log (the last ten are kept).
- **Paths.** The slot's source paths in the output are rewritten to your worktree's, so
  `Sources/App/View.swift:12:5: error:` names the file you edit.
- **Files the build wrote** into the source tree (recorded snapshot references, an updated `Package.resolved`,
  linter fixes) are copied back to the worktree and listed. A file that you also changed during the build is
  left alone and named.
- **Products.** With `--products-to`, or when you pass your own `-derivedDataPath`, the products are cloned to
  where you asked. Each app, framework and plain binary gets a dSYM beside it (never inside a bundle, so
  signatures stay valid) with a record that maps source paths to your worktree, so a debugger shows the right
  lines after the slot is reused.

### Waiting

There are a few slots per repository and a machine-wide cap on commands running at once. When everything is
busy, `xcslot` says who holds each slot and waits; it never looks hung. `xcslot status` shows the same at any
time. After the wait runs out it fails with `slots_busy` (exit code 110).

## Projects

| Project                                                      | What happens before the build                                                                                                                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.xcodeproj` or workspace (`.pbxproj` or the JSON `.xcproj`) | Nothing. Swift packages resolve into the slot and stay warm.                                                                                                                                               |
| Tuist (`Tuist.swift`)                                        | `tuist install` and `tuist generate` run in the slot when their inputs change; generated files that come out identical keep their timestamps. Tuist runs through `mise` when the repository pins it there. |
| Swift package                                                | Nothing; use `xcslot run -- swift build`. `.build` stays in the slot.                                                                                                                                      |
| Anything else that generates a project                       | Declare the step in `.xcslot.json`.                                                                                                                                                                        |

`.xcslot.json` in the repository root is optional:

```json
{
  "prepare": [
    { "name": "xcodegen", "run": ["xcodegen", "generate"], "inputs": ["project.yml"], "outputs": ["*.xcodeproj"] }
  ],
  "sync": { "includeIgnored": ["*.xcconfig", "GoogleService-Info.plist"] }
}
```

Tracked files and untracked files that git does not ignore are mirrored. Ignored files reach the slot only when
`sync.includeIgnored` names them (`*.xcconfig` by default).

## Configuration and disk

`~/.config/xcslot/config.json`, all keys optional:

```json
{ "slots": 3, "maxConcurrent": 3, "waitSeconds": 3600 }
```

Slots live in `~/Library/Developer/xcslot/<repository>-<hash>/<n>/`, each with its mirrored checkout (`src`), its
`DerivedData` and its state. A slot costs about what one DerivedData of the project costs. Once a day, at the
start of a command, slots of repositories that no longer exist are removed, and so are slots above the
configured count that sat unused for a day. `xcslot slots list --sizes` shows what is there, and
`xcslot slots remove --all --yes` deletes it; the next build is then a cold one.

## Limits

- A new slot's first build is a cold build. Three slots mean up to three cold builds per repository.
- A slot is warm for the tree it built last. A worktree far from that tree rebuilds what differs, as a
  checkout in place would.
- Build inputs outside the repository (a `../Shared` folder) are not mirrored.
- Result bundles and binaries not handed out keep the slot's paths.
- Xcode's own window does not use slots. Simulators are yours to pick: `-destination id=<udid>` passes through,
  and a lease tool such as [Simlock](https://github.com/callstackincubator/simlock) hands one to each agent.

## For agents

`xcslot skill` prints a skill that teaches a coding agent to build through xcslot;
`xcslot skill install --dir ~/.claude/skills` writes it into a skills folder. `xcslot commands --json` lists
every command with its options, examples and errors.

Data commands print one JSON document on stdout when piped or with `--json`: `{ "ok": true, "data": … }`.
xcslot's own failures are one JSON document on stderr, `{ "ok": false, "error": { "code", "message", "hint",
"retryable", "next" } }`, and each `next` command is safe to run as printed.

| Error                   | Exit code |
| ----------------------- | --------- |
| `internal_error`        | 100       |
| `usage_error`           | 101       |
| `not_a_repository`      | 102       |
| `tool_missing`          | 103       |
| `slots_busy`            | 110       |
| `slot_not_found`        | 111       |
| `confirmation_required` | 112       |
| `prepare_failed`        | 113       |
| `sync_failed`           | 114       |
| `state_invalid`         | 115       |

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

## License

MIT
