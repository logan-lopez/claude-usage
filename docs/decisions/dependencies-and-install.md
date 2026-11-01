---
description: "Dependencies allowed"
covers: ["docs/architecture/build-and-install.md"]
---
# Dependencies and install

## Choice

Dependencies allowed; install is compiled CLI and TUI binaries in `~/.local/bin`

## Why

`bun build --compile` starts in ~39 ms against ~98 ms and needs no `node_modules` under launchd. (`CLAUDE.md`, brief 02 §7)
