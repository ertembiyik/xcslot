# Configuration

xcslot needs no configuration. Two optional files change its defaults.

## Projects

| Project                                                      | What happens before the build                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.xcodeproj` or workspace (`.pbxproj` or the JSON `.xcproj`) | Nothing. Swift packages resolve into the slot and stay warm.                                                                                                                                                                                                                                                                                                  |
| Tuist (`Tuist.swift`)                                        | `tuist install` and `tuist generate` run in the slot when their inputs change; generated files that come out identical keep their timestamps. Tuist runs through `mise` when the repository pins it there. A command that runs elsewhere in the repository and names nothing in the Tuist project, such as `swift build` in a standalone package, skips both. |
| Swift package                                                | Nothing; use `xcslot run -- swift build`. `.build` stays in the slot.                                                                                                                                                                                                                                                                                         |
| Anything else that generates a project                       | Declare the step in `.xcslot.json`.                                                                                                                                                                                                                                                                                                                           |

For a standalone Swift package inside a Tuist repository, run `xcslot run -- swift test` or `xcslot xcodebuild`
from the package directory (or a subdirectory). If the nearest manifest is that package's `Package.swift`
and the command's path arguments stay in the package, xcslot skips automatic Tuist installation and generation.
Tuist's own `Tuist/Package.swift` does not count as a standalone package. Custom `prepare` steps still run.

## `.xcslot.json`, per repository

In the repository root, all keys optional:

```json
{
  "prepare": [
    { "name": "xcodegen", "run": ["xcodegen", "generate"], "inputs": ["project.yml"], "outputs": ["*.xcodeproj"] }
  ],
  "sync": { "includeIgnored": ["*.xcconfig", "GoogleService-Info.plist"] }
}
```

- **`prepare`** lists commands to run in the slot before the build. A step runs again when one of its `inputs`
  changes or its `outputs` are missing.
- **`sync.includeIgnored`** names files that git ignores but the build needs, such as a local `.xcconfig`
  with secrets. The default is `["*.xcconfig"]`. Tracked files and untracked files that git does not ignore
  are always mirrored.

### Expo and React Native

A slot mirrors the git-tracked files, and an Expo project keeps what a build needs in ignored folders:
`node_modules`, `ios/` with its `Pods`, and often a generated `.env`. Declare the steps that create them, and
build with `xcslot xcodebuild`, not `xcslot run -- expo run:ios`:

```json
{
  "sync": { "includeIgnored": ["*.xcconfig", ".env"] },
  "prepare": [
    {
      "name": "install",
      "run": ["bun", "install", "--frozen-lockfile"],
      "inputs": ["package.json", "bun.lock", "patches/**"],
      "outputs": ["node_modules"]
    },
    {
      "name": "prebuild",
      "run": ["bunx", "expo", "prebuild", "--platform", "ios"],
      "inputs": ["package.json", "bun.lock", "app.config.ts", "plugins/**"],
      "outputs": ["ios"]
    }
  ]
}
```

```bash
xcslot xcodebuild --products-to build/Products -workspace ios/App.xcworkspace -scheme App \
  -configuration Debug -destination 'platform=iOS Simulator,id=<udid>' build
xcrun simctl install <udid> build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch <udid> <bundle id>
```

Start Metro from the worktree itself. `inputs` come from `git ls-files`, so an ignored file such as `.env` cannot
be an input: when it changes what `prebuild` produces, touch a tracked input to rerun the step.

## `~/.config/xcslot/config.json`, per machine

```json
{ "slots": 3, "maxConcurrent": 3, "waitSeconds": 3600 }
```

| Key             | Default                      | Meaning                                              |
| --------------- | ---------------------------- | ---------------------------------------------------- |
| `slots`         | 3                            | Slots per repository.                                |
| `maxConcurrent` | 3                            | Wrapped commands running at once on this Mac.        |
| `waitSeconds`   | 3600                         | How long a command waits for a slot before it fails. |
| `root`          | `~/Library/Developer/xcslot` | Where slots live.                                    |

`--slots <count>` raises the slot count for one run, and `maxConcurrent` with it. `XCSLOT_HOME` overrides `root`, and `XCSLOT_CONFIG` names
another config file.

## Disk

A slot costs about what one DerivedData of the project costs, plus a checkout.

| Command                           | What it does                                                  |
| --------------------------------- | ------------------------------------------------------------- |
| `xcslot slots list --sizes`       | Shows what is there and how big it is                         |
| `xcslot slots remove 3 --yes`     | Deletes one slot                                              |
| `xcslot slots remove --all --yes` | Deletes this repository's slots; the next build is a cold one |

## Environment a wrapped command sees

| Variable              | Value                                                    |
| --------------------- | -------------------------------------------------------- |
| `XCSLOT_DERIVED_DATA` | The slot's DerivedData.                                  |
| `XCSLOT_SLOT_DIR`     | The slot's checkout.                                     |
| `XCSLOT_WORKTREE`     | The worktree the command was run for; `xcslot run` only. |
| `PWD`                 | The directory in the slot the command runs in.           |

Xcode hashes the whole environment into its build plan, so a variable that differs between two callers makes the
next build plan again, about 4 s on a large app. xcslot therefore leaves out variables that change per shell or agent
session: `OLDPWD`, `SHLVL`, `_`, terminal and tmux session ids, and everything starting with `CLAUDE_`, `CLAUDECODE`,
`CODEX_` or `CURSOR_`. Anything else you export reaches the build as it is.

A script started by `xcslot run` that calls `xcslot xcodebuild` again uses the slot it is already in.
