---
description: "`src/tui.ts` is its own bin"
covers: []
---
# TUI packaging

## Choice

`src/tui.ts` is its own bin; `react`, `ink` and `@inkjs/ui` stay out of the CLI's import graph

## Why

Launchd runs the CLI hourly and the statusline polls it; neither may pay React's startup. `tests/cli.test.ts` enforces it. (`CLAUDE.md`)
