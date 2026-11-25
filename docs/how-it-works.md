# How it works

## Why a fresh worktree builds from scratch

Xcode decides what to rebuild from two things: where a file is and when it last changed. A new git worktree
changes both. It sits at a new path, and `git worktree add` stamps every file with the current time. Xcode
finds nothing it recognises and compiles everything.

What does work is not moving. The same path with unchanged timestamps is an incremental build.

## Other ways to warm a fresh worktree

Measured on one project in [benchmarks.md](benchmarks.md), where a cold build takes 85 s:

| Approach                                          | First build | Why                                                                                                                      |
| ------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Clone DerivedData into the new worktree           | 107 s       | The build records name the old path, so nothing is reused.                                                               |
| Clone DerivedData and rewrite the paths inside it | not tried   | Can work, but means editing Xcode's undocumented build database and task signatures, which any Xcode release may change. |
| Xcode's compilation cache with prefix mapping     | 43 s        | Every lookup hits, and every task still runs: 1,510 Swift compile tasks, each fetching its result.                       |
| A slot at a fixed path                            | 4.8 s       | Nothing moved and no timestamp changed, so Xcode finds no task to run.                                                   |

xcslot never moves a build, so it reads and writes nothing of Xcode's own. The compilation cache combines with
it: with the cache already filled, a new slot's first build took 43 s instead of 85 s. xcslot does not turn
the cache on; set `COMPILATION_CACHE_ENABLE_CACHING=YES` in your project if you want it.

## The slot

A slot is a folder that never moves:

```text
~/Library/Developer/xcslot/<repository>-<hash>/<n>/
  src/           a checkout of the repository, kept in step with whichever worktree builds next
  DerivedData/   Xcode's build data for that checkout
  state.json     what was mirrored and which steps ran
```

`xcslot xcodebuild …` does this, in order:

1. **Takes a free slot.** Its own last slot first, then the one whose last tree is closest to yours, then the
   least recently used. If all are busy it says who holds them and waits.
2. **Mirrors your worktree into `src`.** Tracked files and untracked files that git does not ignore. A file is
   rewritten only when its content differs, so every other file keeps its timestamp. A fresh worktree of a
   commit the slot already built changes nothing.
3. **Prepares the project** when its inputs changed: `tuist install` and `tuist generate`, or the steps you
   declare. Generated files that come out identical get their old timestamps back.
4. **Runs your command there**, with paths in its arguments pointed at the slot and `-derivedDataPath` set to
   the slot's.
5. **Hands everything back**: output with paths rewritten to your worktree, files the build wrote, and the
   products if you asked for them.

Your worktree is never built in and never locked. You keep editing while the build runs; the next build picks
the edits up.

## Which worktrees share slots

Slots belong to a repository, found through git's common directory, so every worktree of it shares the same
slots: ones made with `git worktree add`, and the ones Claude Code, Codex or Cursor make for their agents. A
worktree nested inside the main checkout is not mirrored when the main checkout builds.

A slot is held only while a command runs, and nothing in it refers to a worktree afterwards. Deleting a
worktree needs no cleanup; products handed out with `--products-to` stay where they were put.

## Disk

| What                          | How it is stored                                                               |
| ----------------------------- | ------------------------------------------------------------------------------ |
| A slot's checkout (`src`)     | APFS clones of your worktree's files: no extra disk until either copy changes. |
| A slot's DerivedData          | Its own, as large as any DerivedData of the project. Slots do not share it.    |
| Products from `--products-to` | APFS clones of the slot's products.                                            |

So the cost is about one DerivedData per slot, three per repository by default, however many worktrees there
are. Plain `xcodebuild` names its default DerivedData folder after the project's path, so every worktree built
that way leaves one more under `~/Library/Developer/Xcode/DerivedData` until you delete it.
[Configuration](configuration.md#disk) has the commands that show and remove slots.

## What moves between the slot and your worktree

**Into the slot:** file contents, and the commit your worktree is on (`HEAD` and the index move, so build
scripts that ask git for the commit see yours).

**Out of the slot:**

- **Output.** A path under the slot's `src` is rewritten to the same file in your worktree when that file
  exists there. A generated file that exists only in the slot keeps its slot path, so it still opens.
- **Files the command wrote.** After the command, files in `src` that changed are copied to your worktree:
  recorded snapshots, an updated `Package.resolved`, linter fixes. A file you edited during the build is left
  alone and named in the output.
- **Products**, when you pass `--products-to <dir>` or your own `-derivedDataPath`: an APFS clone, which is
  instant and takes no disk until either side changes.

## Debugging a handed-out product

Debug builds keep their debug information in the slot's object files. The next build in the slot replaces
those files, and a debugger attached to the older product would show the wrong lines without any error.

So products are handed out with a dSYM made while the slot is still held: one `<Bundle>.dSYM` beside each app
or framework, and `<binary>.dSYM` beside a plain executable. Nothing is written inside a bundle, so its code
signature stays valid and a device build still installs. Each dSYM records that the slot's source path is
your worktree's, so breakpoints set by file and line resolve. `--no-dsym` skips the step.

## Waiting and the cap

Two limits keep a machine usable when many agents build at once:

- **Slots per repository** (3 by default). One command per slot.
- **Commands at once on the machine** (3 by default), across all repositories.

A lock belongs to a process id plus that process's start time, so a crashed build never leaves a slot stuck
and a reused process id cannot hold one. A waiting command prints who holds each slot, then one line a minute.

## Housekeeping

Once a day, at the start of a command, xcslot removes slots of repositories that no longer exist and slots
above the configured count that sat unused for a day. It keeps the last ten logs per repository. A slot that a
command holds is never removed.
