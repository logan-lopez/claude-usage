# Ingest and the archive

Transcripts and their cost-state records are copied into SQLite, deduplicated as they go, before
Claude Code garbage collects them. Everything else reads what this writes.

**Sources:** `src/ingest.ts`, `src/schema.ts`, `src/paths.ts`

**History:** [brief 01](../briefs/archive/01-archiver-and-session-views.md),
[brief 02](../briefs/archive/02-cli-reports-and-binaries.md)

`ingest.ts` finds and reads transcripts (`findTranscripts`, `ingestTranscripts`) and maintains the
session roll-up (`rollupSessions`). `schema.ts` holds the tables, the append-only migrations
(`SCHEMA_VERSION` is 3) and `meta`. `paths.ts` names every source location.

## How it works

**Discovery.** Transcripts are `~/.claude/projects/**/*.jsonl`. Sub-agent transcripts are nested
two levels deeper, at `<project>/<sessionId>/subagents/agent-*.jsonl`. A one-level glob misses
about 10% of the corpus and all sub-agent attribution, which is most of what the tool exists to
show.

**What a record gives.** One `usage` object per assistant turn, with `sessionId`,
`apiBlockIndex`, `effort` and the `attribution*` fields. Tool *names* go to `tool_calls`, inserted
`OR IGNORE` on `(session_id, tool_use_id)` so the streaming duplicates don't repeat them. The
`type:"cost-state"` records in the same files carry Claude Code's per-session cost and are the
only place `claude-opus-5[1m]` is distinguishable from `claude-opus-5`. They go to `sessions` and
`cost_state_models`, keeping the highest cost per session and per model, since they're cumulative.

**Dedup.** Claude Code writes intermediate streaming usage snapshots and then overwrites them, so
the raw record count is about 2.1× the real API calls, and the last record for a message is often
the smallest.

- Key: `(message_id, request_id, session_id)`. When `requestId` is absent it is stored as `''`.
- On collision, keep the max of `input + output + cache_creation + cache_read`.
- Tie-break: non-sidechain beats sidechain, then the record carrying `usage.speed`.
- Dedup is global, not per file. Resumed sessions replay history across files.

**The write.** Each record is one atomic UPSERT whose `WHERE` implements keep-max in SQL.

**`ingest_state`.** One row per transcript file: path, inode, size and the byte offset read to.

**Session roll-up.** `sessions.request_count` is recomputed only for the sessions whose request
rows a file touched, inside the same transaction that advances that file's offset. Calling
`rollupSessions` with no ids does the full sweep, which is the repair path.

## Rules worth keeping

- **`requests` is `WITHOUT ROWID` and `request_id` is `''`, never `NULL`.** On a rowid table,
  primary-key columns are nullable and `NULL` never equals `NULL`, so each requestId-less record
  would insert a fresh duplicate on every sync. An idempotency test that re-runs the same data
  would still pass, because the duplicates are indistinguishable. With no rowid, nothing may
  depend on `rowid` or `last_insert_rowid()` for this table.
- **Keep-max is one UPSERT, not read-then-decide-then-write.** Across hundreds of files, the loop
  version degrades to "keep last" under any interruption, and last is the smallest snapshot.
- **The three `ingest_state` rules:**
  - Offsets advance only to the last complete newline, so a half-written line is re-read.
  - `size < stored_size` or a changed inode forces a re-read from zero.
  - Commit per file, not per run.
- **The roll-up commits with the offset.** A run killed partway leaves earlier files committed at
  their new offsets, and no later run re-reads those bytes. A roll-up deferred to the end of the
  run would leave the counts behind permanently, with no way to notice.
- **Count, never increment.** A counter would double-count the streaming duplicates that keep-max
  collapses, and drift on any re-read.
- **`request_count` counts deduped API requests, not messages.** It was `message_count` until
  schema v2 renamed it. On the live archive it reads about 3× what a person would call the message
  count. Only `resolveSessionId` reads it, as a `> 0` filter.
- **Never ingest content.** Tool names and token counts only:
  - no message bodies, `toolUseResult`, `history.jsonl` prompts or `paste-cache/`;
  - none of the `oauthAccount`, `userID` or `machineID` keys in `~/.claude.json`.

## Decisions

Measured on the live corpus, 2026-09-09. The counts grow; the ratios are the useful part.

- 574 transcript files, about 241 MB, 60 of them sub-agent transcripts. A one-level glob finds
  514.
- About 18.7K raw assistant records reduce to about 8.8K deduped: **2.12×**.
  - A result near the raw count means dedup is off.
  - A result near half the deduped count means it's keeping the first record seen.
- Exactly 228 assistant records have no `requestId`. They are what `WITHOUT ROWID` and `''`
  protect. Verified against SQLite 3.51.0 (Bun 1.3.3): a rowid table accepted the same NULL-keyed
  row twice, and the `WITHOUT ROWID` table rejected it.
- 2,406 sidechain records, all of which also carry `agentId`.
- cost-state: 371 records across 162 of 506 sessions. The records are **cumulative**: summing
  every one gives $1652.36, which is wrong. Max per session gives $744.68, with
  `claude-opus-5[1m]` as its own row at $139.79.
- The full-table roll-up it replaced rewrote all 510 sessions against 8,913 requests on every
  sync, including the 15-minute limits run, which reads no transcripts.
