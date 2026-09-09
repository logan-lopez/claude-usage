---
type: Decision
title: sessions.request_count is rolled up only for the files a sync actually read
description: The session roll-up recomputes counts for the sessions touched by each transcript file, inside that file's own transaction, instead of rewriting every session row on every sync; the column was renamed from message_count because it counts deduped API requests, not messages.
generated: { by: agent/cli, at: 2026-09-09T23:25:30Z }
---

## Decision

`rollupSessions(db, sessionIds?)` takes an optional set of session ids. The
ingester collects the sessions whose request rows it touched while reading one
transcript file and recomputes only those, **inside the same transaction that
advances that file's read offset**. Passing no argument still does the full
sweep, which is now a repair path rather than the normal one.

The column it maintains was renamed `message_count` -> `request_count` in
schema v2, via `ALTER TABLE ... RENAME COLUMN`.

## Why

Two separate problems, one column.

**The write cost.** The roll-up ran once at the end of every `ingestTranscripts`
call as a single unqualified `UPDATE sessions SET ... (SELECT COUNT(*) ...)`.
That is a full scan of `sessions` with a correlated subquery per row — 510 rows
against 8,913 requests — and it ran on every sync including the 15-minute
limits agent, which reads no transcripts at all and therefore changed nothing.

**The transaction boundary is the subtle part.** Scoping the roll-up is only
safe if it commits atomically with the offset. Ingest is resumable per file: a
run killed partway leaves earlier files committed at their new offsets, and no
later run will ever re-read those bytes. If the roll-up were deferred to the
end of the run, a kill would advance the offsets while leaving the counts
behind, permanently — the archive would be quietly wrong with no way to notice
and no natural repair. Folding it into `commitFile` makes the count and the
offset succeed or fail together.

**The name.** `message_count` never counted messages. It counts rows in
`requests`, which are deduped assistant API requests: one user-visible reply
can span several, streaming snapshots collapse into one, and user turns are not
counted at all. On the live archive it reads roughly 3x what a human would call
the message count. In a tool whose entire purpose is to be believed about
numbers, a field name that invites the wrong reading is a defect.

## Consequences

- Counting, never incrementing. A counter would double-count the streaming
  duplicates that the keep-max upsert collapses, and drift on any re-read.
- `IngestResult.sessionsRolledUp` reports the work done, and appears in
  `sync --json`. It counts repeats: one session spanning three transcripts is
  rolled up three times.
- `SessionRow` no longer exposes the count. `requests`, counted live over the
  same rows, was already in the object; two fields with one meaning invites a
  consumer to pick the one that can lag.
- Only `resolveSessionId` reads the cached column now, as a `> 0` filter that
  skips the join.
- Sessions are added to the touched set even when the keep-max `WHERE` rejects
  the row. A rejected upsert cannot change a count, but recomputing one extra
  session costs nothing and removes a class of reasoning error.
- Verified live: the migration applied itself on the next scheduled agent run,
  510 rows carried over intact, `SUM(request_count) = COUNT(*) FROM requests`
  = 8,913 with zero disagreeing rows, and a no-op sync now reports
  `sessionsRolledUp: 0`.
- `tests/ingest.test.ts` asserts the scoped roll-up produces byte-identical
  results to the full sweep, and round-trips a v1 database through the
  migration to prove values are carried rather than recomputed.

# Related Concepts
- [Measured shape of the local Claude Code corpus, 2026-09-09](../findings/corpus-shape-2026-09-09.md): The 510 sessions and 8,913 requests that made the full-table roll-up measurable waste
