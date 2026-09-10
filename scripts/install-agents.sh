#!/usr/bin/env bash
# Render and install the two launchd agents.
#
#   scripts/install-agents.sh [repo-root]
#
# Defaults to the repo this script lives in. The installed agents do not depend on it;
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
if [[ ! -x "$HOME/.local/bin/cusage" ]]; then
  echo "error: run make install first (no ~/.local/bin/cusage binary)" >&2
  exit 1
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
