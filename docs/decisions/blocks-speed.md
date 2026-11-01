---
description: "Fixed inside `blocks()` only, deep-equal to the old code"
decided: 2026-10-28
by: "Logan"
covers: []
---
# `blocks()` speed

## Choice

Fixed inside `blocks()` only, deep-equal to the old code; `requestWhere` untouched

## Why

Its `$x IS NULL OR` shape defeats `requests_ts`, one full scan per cycle: 1557 ms at 30 days. Fixing every caller is in `FUTURE.md`. (Logan, 2026-10-28, brief 08)
