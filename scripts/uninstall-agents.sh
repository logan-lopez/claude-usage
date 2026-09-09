#!/usr/bin/env bash
# Remove both launchd agents. Leaves the archive at
# ~/.local/share/claude-usage/usage.db untouched -- that is the whole point of
# the archive and is never deleted by tooling here.
set -euo pipefail
UID_NUM="$(id -u)"
for label in com.logan.claude-usage com.logan.claude-usage-limits; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
  echo "removed $label"
done
echo "archive left in place at ${CUSAGE_DB:-$HOME/.local/share/claude-usage/usage.db}"
