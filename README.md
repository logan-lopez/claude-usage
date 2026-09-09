# cusage — Claude subscription usage explorer

Claude Pro/Max subscription usage is visible only as a rough percentage. There
is no token-level view, no per-session attribution, and no history; the API
console dashboard does not cover subscription usage at all.

Four local data sources hold far more than percentages, and **two of them are
being garbage collected right now** — transcripts age out, and the desktop
app's usage history is capped at a rolling 30 days. `cusage` copies all of it
into an archive you own, and then answers questions against that.

The archiver is the urgent half. Reporting can be rebuilt from an archive at
any time; data that ages out is gone permanently.

```
cusage sync                    # ingest transcripts + snapshot limits (idempotent)
cusage session --last          # one chat: full token, attribution and cost breakdown
cusage sessions --by project   # where the tokens went
cusage limits                  # server truth, including the limit the tray does not show
cusage status                  # what the archive holds
```

## Install

Requires [Bun](https://bun.com) at `~/.bun/bin/bun` (pinned: **1.3.3**). No
runtime dependencies — everything the archiver needs is in Bun's standard
library, so the launchd agents have no install surface that can break.

```bash
bun install                 # dev types only
bun run src/cli.ts sync     # first sync: ~2s for a 240 MB corpus
./scripts/install-agents.sh # hourly sync + 15-minute limits snapshot
```

The archive lives at `~/.local/share/claude-usage/usage.db` — outside the repo,
because it is data, not config. Override with `$CUSAGE_DB`. Removing the agents
(`scripts/uninstall-agents.sh`) never touches it.

## Where the data comes from

| Source | What it gives | Why it is archived |
|---|---|---|
| `~/.claude/projects/**/*.jsonl` | one `usage` object per assistant turn, with `sessionId`, `apiBlockIndex`, `effort`, and the `attribution*` fields | ~70 days retained, then deleted |
| `type:"cost-state"` records, in the same files | authoritative per-session cost, and the **only** place `claude-opus-5[1m]` is distinguishable from `claude-opus-5` | same |
| `~/.claude.json` → `cachedUsageUtilization` | the full OAuth `/api/oauth/usage` response, already fetched — zero network calls | single overwritten snapshot, no history |
| `~/Library/.../Claude/plan-usage-history.json` | 15-minute longitudinal series, `{fh, sd, xu}` | rolling 30-day cap, only written while the desktop app runs |
| Glaze `usage-history.json` | 9 sparse days, `{"YYYY-MM-DD": percent}` | one-time backfill |

Sub-agent transcripts live two levels deeper, at
`<project>/<sessionId>/subagents/agent-*.jsonl`. A one-level glob misses about
10% of the corpus and *all* sub-agent attribution, which is most of what this
tool exists to show.

## Deduplication

Claude Code writes intermediate streaming usage snapshots and then overwrites
them, so the raw record count is roughly **2.1× the number of real API calls**
and the last record for a message is frequently the smallest.

- Key: `(message_id, request_id, session_id)`. When `requestId` is absent it is
  stored as `''`, never `NULL` — see below.
- On collision, keep max `input + output + cache_creation + cache_read`.
- Tie-break: non-sidechain beats sidechain, then the record carrying
  `usage.speed`.
- Dedup is **global**, not per file. Resumed sessions replay history across
  files.

The `requests` table is declared `WITHOUT ROWID`. This is load-bearing, not
cosmetic: on an ordinary rowid table, `PRIMARY KEY` columns are nullable (the
legacy SQLite behaviour), `NULL` never compares equal to `NULL`, and the
records with no `requestId` would therefore insert a fresh duplicate on
*every* sync — while an idempotency check that re-runs the same data would
still pass. Verified: a rowid table accepts the same NULL-keyed row twice.

Writes are a single atomic `UPSERT` implementing keep-max in SQL. A
read-then-decide-then-write loop across 574 files degrades to "keep last" under
any interruption, and "last" is the wrong answer.

## What this tool will not do

- **No automatic network calls, ever.** `cachedUsageUtilization` is already on
  disk. `cusage pricing --refresh` will be the only command that touches the
  network, and only when run by hand.
- **Never ingest content.** No `message.content` bodies, no `toolUseResult`, no
  `history.jsonl` prompts, no `paste-cache/`, no `.credentials.json`, and none
  of the `oauthAccount` / `userID` / `machineID` keys in `~/.claude.json`. Tool
  *names* and token *counts* only.
- **Never present a derived number as fact.** Server truth and local
  attribution are reported as two separate things.

## Known limits — read these before trusting a number

- **Local data covers Claude Code only.** In 39% of sampled intervals where the
  meter read ≥15%, there was zero Claude Code activity in the trailing five
  hours. That is claude.ai and Desktop chat usage, and it is not on disk.
  Correlation between the five-hour meter and local output tokens is r=0.69;
  for the seven-day meter it is r=0.04 — **not derivable**.
- **`cost-state` covers 162 of 506 sessions.** The rest need estimated pricing
  (phase 3). Sessions are marked `measured` or `estimated`, never blended.
- **Grouped cost is exact or absent.** cost-state is recorded per *session*, and
  one session's requests can land in several projects. Summing that session
  into each group it touched turned $90 of real spend into $226 on the test
  fixture. Straddling sessions are counted, their cost excluded, and the column
  marked `+`.
- **`server_tool_use` counters read 0** even when WebSearch/WebFetch ran. Those
  are client-side tools, not server tools. Measured across the whole corpus:
  `web_search_requests` and `web_fetch_requests` are both zero.
- **`ephemeral_5m + ephemeral_1h` does not reconcile with
  `cache_creation_input_tokens`.** Corpus-wide gap: ~1K tokens out of 42M. Do
  not assume they balance.
- **Post-compaction `cache_read_input_tokens` drops discontinuously.** Do not
  infer context size from it monotonically.
- **Glaze's metric is inferred, not documented.** Its flat day→percent map
  carries no label. It tracks `five_hour`: on every overlapping day it lands
  within one point of that day's `fh` maximum (56/56, 24/23, 19/18, 13/12) and
  nowhere near `seven_day`. Stored as `five_hour` with `source='glaze'` so it
  can always be filtered out.

## The limit the tray does not show

`cachedUsageUtilization.limits[]` carries three entries. The tray shows
`weekly_all`. The one with `is_active: true` is frequently `weekly_scoped` —
scoped to a single model, and higher:

```
   kind           scope  pct  severity  resets
▸  weekly_scoped  Fable  53%  normal    2026-09-13 05:59
   weekly_all     all    37%  normal    2026-09-13 06:00
   session        all    31%  normal    2026-09-08 18:00
```

`cusage limits` reports the binding constraint rather than the headline number.

## Testing

```bash
bun test          # 49 tests, no network, no live data
bun run fixture   # regenerate fixtures/ from the live corpus
bunx tsc --noEmit
```

Every numeric assertion runs against `fixtures/`, a **frozen, scrubbed** copy of
24 real transcripts — never against live data, which is appended to
continuously and garbage collected. A baseline that drifts trains everyone to
ignore a failing test.

The fixture is safe to commit: scrubbing is an allowlist, every id, path,
branch and slug is remapped, all message content is dropped, and
`tests/fixture.test.ts` re-checks for leaks on every run rather than once at
generation time. `MANIFEST.json` pins the bytes; `BASELINE.json` holds the
expected numbers, computed by a **second, independent** dedup implementation in
`tools/make-fixture.ts` so the tests are not just the ingester agreeing with
itself.

## Status

| Phase | | |
|---|---|---|
| 1 | archiver — schema, ingest, limits, `sync`, both launchd agents | done |
| 2 | `session`, `sessions`, `limits`, `status` | done |
| 3 | `pricing.ts`, `cusage cost` | not started |
| 4 | `blocks`, `attribution`, `daily`/`weekly`/`monthly`, `export` | not started |
| 5 | Ink TUI | not started |

Phase 3–4 commands exist in the dispatch table and exit 2 with "not
implemented" rather than printing a zero.
