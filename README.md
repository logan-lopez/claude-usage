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
cusage limits --history        # the meters over time, from ~2,000 archived samples
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
| `GET /api/oauth/usage` | the same response, current, including `weekly_scoped` | the only place `weekly_scoped` exists at all; nothing caches it |
| `~/.claude.json` → `cachedUsageUtilization` | that response as Claude Code last cached it | single overwritten snapshot, refreshed on no schedule you can rely on |
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

## Network

This started as *"no automatic network calls, ever"*, on the theory that
`cachedUsageUtilization` was as good as the endpoint. It is not. On a full day
of heavy use Claude Code refreshed that key **once**, and `cusage limits`
spent 27 hours reporting `Fable 53%` while the real figure was 74%. The rule
was protecting a number that was wrong.

So the rule is now specific rather than absolute:

- **One endpoint, `GET https://api.anthropic.com/api/oauth/usage`.** No other
  host is contacted by anything in this repo. It is a read; nothing is sent but
  the bearer token.
- **A 3-minute floor between attempts**, successful or not, persisted in the
  archive so it holds across processes — a launchd agent and a statusline poll
  are not the same process and must share one clock. `$CUSAGE_MIN_REFRESH_MS`
  can raise that floor; nothing can lower it, including `--refresh`.
- **`limits` and `sync` refresh when the archived copy is over 15 minutes old.**
  `--refresh` forces a check now, `--no-refresh` or `$CUSAGE_REFRESH=off` keeps
  a run entirely local.
- **Every failure is soft.** No token, a 401, a timeout, no network: you get the
  archived view and one line on stderr. Never a stack trace, never an empty
  screen.
- **The token is used and dropped.** Read from the login keychain
  (`Claude Code-credentials`), falling back to `~/.claude/.credentials.json`;
  never written to the archive, never logged, and scrubbed out of any error
  string before it is printed.
- **The test suite is offline.** The one test that exercises a real request
  points at `127.0.0.1:1`.

## What this tool will not do

- **Never ingest content.** No `message.content` bodies, no `toolUseResult`, no
  `history.jsonl` prompts, no `paste-cache/`, and none of the `oauthAccount` /
  `userID` / `machineID` keys in `~/.claude.json`. Tool *names* and token
  *counts* only. Credentials are read to sign one request and never stored.
- **Never present a derived number as fact.** Server truth and local
  attribution are reported as two separate things.
- **Never present a stale number as current.** Every figure on `cusage limits`
  carries the source it came from and how old it is, and a binding constraint
  older than 15 minutes is labelled rather than bolded.

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

`limits[]` carries three entries. The tray shows `weekly_all`. The one with
`is_active: true` is frequently `weekly_scoped` — scoped to a single model, and
much higher:

```
Server-reported limits  oauth-live · just now
     kind           scope  pct  severity  resets
  ▸  weekly_scoped  Fable  74%  normal    2026-09-13 05:59
     weekly_all     all    54%  normal    2026-09-13 05:59
     session        all     2%  normal    2026-09-10 01:29

  binding constraint: weekly_scoped (Fable) at 74% · just now

  meter      pct  source      age       resets
  five_hour   2%  oauth-live  just now  2026-09-10 01:29
  seven_day  54%  oauth-live  just now  2026-09-13 05:59

  archived sources
    source           age          five_hour  seven_day
    oauth-live       just now            2%        54%
    glaze            just now           15%          -  daily, inferred — not reconciled
    desktop-history  7m ago              2%        54%
    oauth-cache      28h 40m ago        31%        37%
```

That bottom row is why this view looks the way it does. Reading the cache alone
gave `37%` and `Fable 53%`; the app on screen said 54% and 74%. Both numbers
were archived correctly and the query picked the wrong one, so now every meter
takes the freshest source that carries it, keeps its provenance, and two
*current* sources that disagree are reported side by side rather than one
quietly winning. Nothing is averaged and nothing is interpolated.

`cusage limits --history` plots the same meters over time:

```
Limit history  2026-09-06 22:18 → 2026-09-09 22:18  ·  73 × 1h  ·  210 samples

  seven_day (weekly)     ▂▂▂▂▂▂▂▂▂▂▂▂·····▂▃▃▃▃▃▃▃▃▃▃▃▃▃········▃▄▄▄▄▄▄▄▄▄▄·▄▄▄▄▄▄···▅▅·▅▅▅▅▅▅▅▅▅▅  now  54%  peak 54%
  five_hour (session)    ▂▂▂▂▂▂▂▁▂▂▂▂·····▁▂▂▁▁▁▂▂▃▃▃▅▅▂········▂▂▂▂▄▂▂▃▅▆▁·▁▁▁▁▁▁···▁▁·▁▂▂▁▂▂▂▂▁▁  now   2%  peak 65%
  weekly_scoped (Fable)  ···········································▅···························▆▆  now  74%  peak 74%

  daily peaks (UTC)
    day         five_hour  seven_day  Fable  samples
    2026-09-08        65%        49%    53%       64
    2026-09-09        15%        54%    74%       66
```

Buckets hold the **peak** rather than the mean — a limit you touched at 98% and
backed off from is a fact about your week that an average hides. Gaps are
rendered `·` and never bridged: those are the hours Claude.app was not running,
and a sparkline that closes them invents a quiet period. The sparse
`weekly_scoped` row is honest too — that series only exists for periods where
`cusage` fetched it, because nothing on disk records it.

## Testing

```bash
bun test          # 81 tests, no remote network, no live data
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
| 2 | `session`, `sessions`, `limits`, `limits --history`, `status` | done |
| 3 | `pricing.ts`, `cusage cost` | not started |
| 4 | `blocks`, `attribution`, `daily`/`weekly`/`monthly`, `export` | not started |
| 5 | Ink TUI | not started |

Phase 3–4 commands exist in the dispatch table and exit 2 with "not
implemented" rather than printing a zero.
