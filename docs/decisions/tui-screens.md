---
description: "Each screen's hook returns a `ScreenModel`"
decided: 2026-10-18
by: "Logan"
covers: ["docs/architecture/tui.md"]
---
# TUI screens

## Choice

Each screen's hook returns a `ScreenModel`; `TABS` drives the tab bar and digit keys; the shell reloads the screen that's showing and marks the rest stale, reloading a stale one before it's shown; Detail and drilled Sessions are pushed, not tabs

## Why

Adding a tab was six edits in `App.tsx`. A new tab can't forget to reload. Reloading every screen ran hidden tabs' queries on every change, up to 2.6 s of synchronous SQLite. (Logan, 2026-10-18, brief 05; reload changed 2026-10-28, brief 06)
