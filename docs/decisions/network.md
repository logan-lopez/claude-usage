---
description: "`GET api.anthropic.com/api/oauth/usage` only, from `src/oauth.ts`, behind a 3-minute floor on attempts that config can raise but not lower"
covers: ["docs/architecture/network.md"]
---
# Network

## Choice

`GET api.anthropic.com/api/oauth/usage` only, from `src/oauth.ts`, behind a 3-minute floor on attempts that config can raise but not lower

## Why

"No network ever" kept a 27-hour-stale 53% on screen while the real figure was 74%. (`CLAUDE.md`)
