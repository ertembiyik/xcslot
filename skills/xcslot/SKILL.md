---
name: xcslot
description: Warm build slots for Xcode. Use before running xcodebuild, swift build, swift test or a Tuist build from a git worktree, and when a build waits on another agent's build.
---

# xcslot

Xcode reuses build data only at the same path with the same file timestamps, so a fresh worktree builds from
scratch. `xcslot` mirrors the worktree into a slot at a fixed path and runs the command there, which makes the
first build incremental.

1. **Use the automatic builder for normal builds.** It chooses MCP when compatible and uses xcodebuild
   otherwise. It defaults to the generic iOS Simulator for simple scheme builds with no destination.
   Use the xcodebuild passthrough when consuming native build output in a filter or a script.

   ```bash
   xcslot build -scheme App -destination 'generic/platform=iOS Simulator' build
   xcslot build --engine xcodebuild -scheme App build
   xcslot run -- swift test
   ```

2. **A waiting line means wait.** It names who holds each slot, and your build starts when one frees. Leave
   other sessions' builds running. Exit code 110 means every slot stayed busy: report the holders.

   ```bash
   xcslot status
   ```

3. **Work in your worktree.** Paths in the output already point there, and the CLI runner copies back and lists files the build writes into
   the source tree. The MCP runner keeps IDE-generated edits in the slot. Run, install and debug the products you take out with
   `--products-to`: they outlive the slot's next build and carry their debug symbols.

   ```bash
   xcslot build --products-to build/Products -scheme App -destination 'generic/platform=iOS Simulator' build
   ```

4. **Bring your own simulator.** `-destination 'platform=iOS Simulator,id=<udid>'` passes through. When several
   agents each need one, lease it first with a simulator lease tool such as Simlock.

## Reading the result

- The xcodebuild and run passthrough commands preserve native output and exit codes. The automatic builder prints the selected engine and returns the build result. Lines starting with `xcslot:` go to stderr;
  the last one names the slot, the products and the full log file.
- Exit codes 100 to 115 are xcslot's own failures: one JSON object on stderr with a `code`, a `hint`, and a `next`
  command that runs as printed.

Every command, option and error is listed by:

```bash
xcslot commands --json
```
