---
description: "Pinned to the exact version Ink resolves, and patched"
covers: ["docs/architecture/tui.md"]
---
# `string-width`

## Choice

Pinned to the exact version Ink resolves, and patched

## Why

Unpatched, ~90% of each keypress is one Unicode regex; Bun keys patches by exact version. `tests/tui/string-width.test.ts` catches a bump. (`CLAUDE.md`)
