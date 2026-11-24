# How it works

## Why a fresh worktree builds from scratch

Xcode decides what to rebuild from two things: where a file is and when it last changed. A new git worktree
changes both. It sits at a new path, and `git worktree add` stamps every file with the current time. Xcode
finds nothing it recognises and compiles everything.

Two shortcuts look like they should help and do not, measured in [benchmarks.md](benchmarks.md):

- **Copying DerivedData into the new worktree.** The build data names the old path, so nothing is reused.
- **Xcode's compilation cache.** It halves the time, but every task still runs and many projects keep it off.

What does work is not moving. The same path with unchanged timestamps is an incremental build.

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
