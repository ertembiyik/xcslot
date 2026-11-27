#!/bin/sh
# Claude Code PreToolUse hook for the Bash tool: refuses a command that starts xcodebuild without xcslot and hands
# the agent the same command with xcslot in front, which then goes through the user's permission rules as usual.
# Not a silent rewrite: a changed input without a decision gets no verdict from auto mode, and allowing it would
# approve whatever else the command chains.

[ "${XCSLOT_HOOK:-1}" = 0 ] && exit 0
# Already inside a slot: the outer xcslot run owns the build.
[ -n "$XCSLOT_DERIVED_DATA" ] && exit 0
command -v xcslot > /dev/null 2>&1 || exit 0

input=$(cat)
command=$(printf '%s' "$input" | /usr/bin/plutil -extract tool_input.command raw -o - - 2> /dev/null) || exit 0
case $command in
  *xcslot*) exit 0 ;;
  *xcodebuild*) ;;
  *) exit 0 ;;
esac
cwd=$(printf '%s' "$input" | /usr/bin/plutil -extract cwd raw -o - - 2> /dev/null) || cwd=.
git -C "$cwd" rev-parse --is-inside-work-tree > /dev/null 2>&1 || exit 0

# xcodebuild where a command starts: at a line start or after ; & | ( $( , behind optional VAR=value words or xcrun.
rewritten=$(printf '%s\n' "$command" | sed -E \
  's/(^|[;&|(])([[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*)(xcrun[[:space:]]+)?xcodebuild([[:space:]]|$)/\1\2xcslot xcodebuild\5/g')
[ "$rewritten" = "$command" ] && exit 0

# Standalone commands that explicitly request the generic iOS Simulator can use the
# automatic builder. Keep pipelines, compound commands and other destinations on the
# native passthrough, whose stdout and defaults those callers may depend on.
case "$command" in
  *[\;\&\|\<\>\$\`]*|*'
'*) ;;
  "xcodebuild "*|"xcrun xcodebuild "*)
    case "$command" in
      *"-destination 'generic/platform=iOS Simulator'"*|*'-destination "generic/platform=iOS Simulator"'*)
        rewritten=$(printf '%s\n' "$rewritten" | sed 's/^xcslot xcodebuild /xcslot build /')
        ;;
    esac
    ;;
esac

reason="Run this build through xcslot, which builds this worktree in a warm slot: $rewritten
Run it unchanged otherwise. Set XCSLOT_HOOK=0 to turn this off."
# Fails open: if the reply cannot be built, the command runs as it was.
reply=$(printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":""}}' |
  /usr/bin/plutil -replace hookSpecificOutput.permissionDecisionReason -string "$reason" -o - -) || exit 0
echo "xcslot hook: sent the agent to: $rewritten" >&2
printf '%s\n' "$reply"
