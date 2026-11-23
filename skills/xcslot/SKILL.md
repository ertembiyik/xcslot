---
name: xcslot
description: Warm build slots for Xcode. Use before running xcodebuild, swift build, swift test or a Tuist build from a git worktree, and when a build waits on another agent's build.
---

# xcslot

Xcode reuses build data only at the same path with the same file timestamps, so a fresh worktree builds from
scratch. `xcslot` mirrors the worktree into a slot at a fixed path and runs the command there, which makes the
first build incremental.

1. **Prefix the build command.** Keep every argument as it was; the slot supplies the DerivedData.

   ```bash
   xcslot xcodebuild -scheme App -destination 'generic/platform=iOS Simulator' build
   xcslot run -- swift test
   ```

2. **A waiting line means wait.** It names who holds each slot, and your build starts when one frees. Leave
   other sessions' builds running. Exit code 110 means every slot stayed busy: report the holders.

   ```bash
   xcslot status
   ```

3. **Work in your worktree.** Paths in the output already point there, and files the build writes into the
   source tree are copied back and listed. Run, install and debug the products you take out with
   `--products-to`: they outlive the slot's next build and carry their debug symbols.

   ```bash
   xcslot xcodebuild --products-to build/Products -scheme App -destination 'generic/platform=iOS Simulator' build
   ```

4. **Bring your own simulator.** `-destination 'platform=iOS Simulator,id=<udid>'` passes through. When several
   agents each need one, lease it first with a simulator lease tool such as Simlock.

## Reading the result

- The wrapped command's output and exit code come through unchanged. Lines starting with `xcslot:` go to stderr;
  the last one names the slot, the products and the full log file.
- Exit codes 100 to 115 are xcslot's own failures: one JSON object on stderr with a `code`, a `hint`, and a `next`
  command that runs as printed.

Every command, option and error is listed by:

```bash
xcslot commands --json
```
