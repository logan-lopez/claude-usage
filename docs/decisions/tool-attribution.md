---
description: "Grouped in JavaScript over two flat scans (requests summed per message, then `tool_calls`), not in SQL"
covers: ["docs/architecture/cli.md"]
---
# Tool attribution

## Choice

Grouped in JavaScript over two flat scans (requests summed per message, then `tool_calls`), not in SQL; the old SQL is the parity oracle in `tests/reports.test.ts`

## Why

2.6 s in SQL's `DISTINCT` and correlated `EXISTS`, about 490 ms in its best `GROUP BY` shape, about 200 ms this way on 93K requests. ([CLI page](../architecture/cli.md), brief 06)
