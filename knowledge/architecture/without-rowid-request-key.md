---
type: Decision
title: requests is WITHOUT ROWID with request_id stored as empty string
description: The requests table is declared WITHOUT ROWID and stores '' rather than NULL for absent request ids, because a rowid table's nullable primary key would silently re-insert every requestId-less record on each sync.
generated: { by: agent/cli, at: 2026-09-09T17:39:54Z }
---

## Decision

`requests` uses `PRIMARY KEY (message_id, request_id, session_id)` declared
`WITHOUT ROWID`, and the ingester writes `''` — never `NULL` — when a transcript
record has no `requestId`.

## Why

228 assistant records corpus-wide have no `requestId`. On an ordinary SQLite
rowid table, `PRIMARY KEY` columns remain nullable (the legacy behaviour), and
`NULL` never compares equal to `NULL`. Each of those records would therefore
insert a fresh duplicate on **every** sync, without bound.

The failure is worse than it sounds: an idempotency test that re-runs the same
data would still pass, because the duplicate rows are indistinguishable from
each other. The bug only shows up as slow, silent inflation of the archive.

Verified directly against SQLite 3.51.0 (Bun 1.3.3): a rowid table accepted the
same NULL-keyed row twice; the `WITHOUT ROWID` table rejects it.

## Consequences

- `''` makes the documented fallback key exact rather than approximate.
- `WITHOUT ROWID` means no rowid, so nothing may start depending on `rowid` or
  `last_insert_rowid()` for this table.
- Generated columns still work (`total_tokens` is `VIRTUAL`), confirmed on the
  same SQLite version.
- `tests/ingest.test.ts` asserts the no-requestId row count is stable across
  three full re-reads with `ingest_state` wiped.

# Related Concepts
- [Measured shape of the local Claude Code corpus, 2026-09-09](../findings/corpus-shape-2026-09-09.md): The 228 requestId-less records this key design protects are counted here
