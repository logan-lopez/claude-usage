#!/usr/bin/env bash
# Render and install the two launchd agents.
#
#   scripts/install-agents.sh [repo-root]
#
# Defaults to the repo this script lives in. Re-run it any time the repo moves;
# it overwrites and reloads.
set -euo pipefail

REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/claude-usage"
UID_NUM="$(id -u)"

if [[ ! -f "$REPO/src/cli.ts" ]]; then
  echo "error: $REPO does not look like the claude-usage repo (no src/cli.ts)" >&2
  exit 1
fi
if [[ ! -x "$HOME/.bun/bin/bun" ]]; then
  echo "error: no bun at $HOME/.bun/bin/bun" >&2
  exit 1
fi
if [[ "$REPO" == *"/conductor/workspaces/"* ]]; then
  echo "WARNING: $REPO is a Conductor worktree, which is deleted when the" >&2
  echo "         workspace is archived. The agents will start failing then." >&2
  echo "         Re-run this script from the canonical checkout after merging." >&2
fi

mkdir -p "$AGENTS" "$LOGS"

for label in com.logan.claude-usage com.logan.claude-usage-limits; do
  plist="$AGENTS/$label.plist"
  sed -e "s|{{REPO}}|$REPO|g" -e "s|{{HOME}}|$HOME|g" \
    "$REPO/launchd/$label.plist.template" > "$plist"
  plutil -lint "$plist" >/dev/null

  # bootout first so a re-run picks up the new plist rather than keeping the
  # loaded copy. Failure is expected on a first install.
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$plist"
  launchctl enable "gui/$UID_NUM/$label"
  echo "installed $label"
done

echo
echo "kickstarting both agents…"
launchctl kickstart -k "gui/$UID_NUM/com.logan.claude-usage"
launchctl kickstart -k "gui/$UID_NUM/com.logan.claude-usage-limits"
echo "logs: $LOGS"
