---
description: "`groupSessions` reads each (session, group) pair with its lifetime counts and measured cost in one statement"
covers: []
---
# Grouped cost read

## Choice

`groupSessions` reads each (session, group) pair with its lifetime counts and measured cost in one statement; the old per-session loop is the parity oracle in `tests/query.test.ts`

## Why

Three queries per session took about 330 ms for project over 30 days on 93K requests, over Breakdown's 300 ms line; one statement takes about 230 ms, identical on the live archive. ([Cost page](../architecture/cost.md), brief 07)
