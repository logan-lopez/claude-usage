---
description: "`query.ts` → data, `format.ts` → strings, `cli.ts` → argv"
covers: []
---
# Layering

## Choice

`query.ts` → data, `format.ts` → strings, `cli.ts` → argv

## Why

`--json`/`--csv` never load `format.ts`; `format.ts` never takes a `Database`, so every view is unit-testable. (`CLAUDE.md`, brief 02)
