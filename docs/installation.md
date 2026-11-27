# Installation

xcslot helps only when the agent puts `xcslot` in front of its builds. This page sets that up, and it is written so
an agent can follow it too: paste this into yours, in the repository you build.

```text
Set up xcslot for this repository following https://raw.githubusercontent.com/ertembiyik/xcslot/main/docs/installation.md
```

## Steps

1. **Install xcslot** if `xcslot --version` fails:

   ```sh
   brew install ertembiyik/tap/xcslot
   ```

2. **Connect the agent** that builds in this repository: do the section below that matches it.

3. **Declare generated folders** if the build needs files that git ignores, such as an Expo project's `ios/` and
   `node_modules`. [Configuration](configuration.md#expo-and-react-native) has the recipe. A Tuist project needs
   nothing: xcslot runs `tuist install` and `tuist generate` in the slot itself.

4. **Check the setup:**

   ```sh
   xcslot doctor
   ```

## Claude Code and the Claude app

The plugin adds the skill and a hook that catches an `xcodebuild` the agent starts without `xcslot`: it stops that
command and hands the agent the same one with `xcslot` in front, which the agent runs instead. In Claude Code:

```text
/plugin install xcslot --marketplace ertembiyik/xcslot
```

That needs Claude Code 2.1.275 or later; on an older one, run `claude plugin marketplace add ertembiyik/xcslot`
and `claude plugin install xcslot@xcslot`.

The hook acts only inside a git repository and only when `xcslot` is installed. The command the agent runs
instead goes through your permission rules and auto mode like any other; the hook approves nothing. Set
`XCSLOT_HOOK=0` in the environment to turn it off.

## Codex, Cursor and other agents

Install the skill for every agent the skills CLI knows:

```sh
npx skills add ertembiyik/xcslot -g
```

Then tell the agent in the repository's `AGENTS.md`, which Codex and Cursor read:

```md
## Building

Build through xcslot: `xcslot xcodebuild …` instead of `xcodebuild …`, and `xcslot run -- swift test` instead
of `swift test`.
```

Without the skills CLI, xcslot writes the skill into an agent's skills folder itself:

```sh
xcslot skill install --dir ~/.claude/skills
```

Apps that drive these agents, such as T3 Code and Conductor, pick up the same skill and `AGENTS.md`.

## Apps that create a worktree per task

A slot is warm for the commit it built last. To have a fresh worktree's first build ready before the agent asks,
start one in the app's setup script, the script it runs after creating a worktree (in Conductor, the setup
script):

```sh
xcslot xcodebuild -scheme App -destination 'generic/platform=iOS Simulator' build > /dev/null 2>&1 &
```

There is nothing to clean up when the app archives a worktree: slots belong to the repository, not to a
worktree, and xcslot removes idle extra slots once a day.

## Xcode's coding assistant

Xcode 27.3 beta gives its built-in Claude agent a hook that refuses the first Bash command in a session that runs
`xcodebuild`, `xcslot xcodebuild` included, and suggests Xcode's own `BuildProject` tool instead. With the
`AGENTS.md` lines above, the agent runs the command again and it goes through. `BuildProject` builds in the
worktree's own DerivedData, so it starts cold in every new worktree. To use Apple's headless build action in a warm slot, see [Headless Xcode builds](reference.md#headless-xcode-builds).

## CI

xcslot pays off where builds of one repository run at different paths on the same Mac, and adds nothing where they
do not.

- **Not needed on a fresh machine per job**, such as GitHub-hosted macOS runners or Xcode Cloud: there is no warm
  slot to reuse.
- **Not needed when every job checks out at the same path**, such as a self-hosted GitHub Actions runner, which
  uses the same `_work/<repo>/<repo>` folder each time: Xcode's own DerivedData stays warm there.
- **Useful on a persistent Mac that runs several jobs at once or gives each job a new folder**, such as GitLab's
  `builds/<runner>/<concurrent-id>/` or several Buildkite agents on one machine. Concurrent jobs then share a few
  warm slots and wait in line for one instead of each building cold. Prefix the build step as you would locally;
  [Configuration](configuration.md) sets how many slots there are and how many builds run at once.
