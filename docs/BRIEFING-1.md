# Claude subscription usage explorer — `cusage`

## Context

Claude Pro/Max subscription usage is only visible as a rough percentage. There
is no token-level view, no per-session attribution, and no history. The API
console dashboard does not cover subscription usage at all.

Meanwhile, four local data sources hold far more than percentages — and **two of
them are being garbage collected right now**. A cleanup ran on 2026-09-09 at
14:08; the oldest surviving transcript file is 11 days old, and
`plan-usage-history.json` is capped at a rolling 30 days. The account's
`claudeCodeFirstTokenDate` is 2025-02-28, so ~18 months of history exists
nowhere on disk.

Goal: a CLI over an owned SQLite archive that answers all four questions — where
usage went, what it would cost on the API, how it is trending, and whether a
limit is close — with **per-session/per-chat token attribution as the headline
feature**. An [Ink](https://github.com/vadimdemedes/ink) TUI comes later against
the same database, so the data layer is built to be shared from day one.

**The archiver is the urgent part.** Reporting can be rebuilt at any time from
an archive. Data that ages out is gone permanently. Build in the order given
under _Ordering_.

## What we found (established, not assumed)

**Source 1 —
`~/.claude/projects/**/\*.jsonl`** (563 files, 327 MB, ~70 days retained). One `usage`
object per assistant turn:

```json
{"input_tokens":…,"output_tokens":…,
 "cache_creation_input_tokens":…,"cache_read_input_tokens":…,
 "cache_creation":{"ephemeral_5m_input_tokens":…,"ephemeral_1h_input_tokens":…},
 "output_tokens_details":{"thinking_tokens":…},
 "server_tool_use":{"web_search_requests":…,"web_fetch_requests":…},
 "service_tier":"standard","speed":"standard","inference_geo":"…","iterations":[…]}
```

Envelope carries `sessionId`, `requestId`, `message.id`, `parentUuid`, `uuid`,
`timestamp`, `cwd`, `gitBranch`, `isSidechain`, `sessionKind`, `apiBlockIndex`,
`effort`, `entrypoint`, `version`, `slug`, and the attribution set
`attributionAgent` / `attributionSkill` / `attributionPlugin` /
`attributionMcpServer` / `attributionMcpTool`.

**Source 2 — `type:"cost-state"` records** (359 records, 157 of 505 sessions).
Cumulative per-session `totalCostUSD`, `totalAPIDuration`,
`totalAPIDurationWithoutRetries`, `totalToolDuration`,
`totalLinesAdded/Removed`, `totalDuration`, `startTime`, and
`modelUsage{model:{inputTokens,outputTokens,thinkingTokens,cacheReadInputTokens, cacheCreationInputTokens,webSearchRequests,costUSD}}`.
Totals $715.00. **Only place `claude-opus-5[1m]` is distinguishable.**

**Source 3 — `~/.claude.json` → `cachedUsageUtilization`.** The full OAuth
`/api/oauth/usage` response, cached, readable with zero network calls. Single
overwritten snapshot — no history. Contains `five_hour` / `seven_day` (each with
`utilization` 0–100, `resets_at` ISO8601,
`limit_dollars`/`used_dollars`/`remaining_dollars`, `locked_reason`), an open
set of codename buckets, `extra_usage`, a `spend` block in minor units, and:

```json
"limits":[{"kind":"session|weekly_all|weekly_scoped","group":…,"percent":…,
           "severity":…,"resets_at":…,"is_active":…,
           "scope":{"model":{"display_name":"Fable"},"surface":null}}]
```

`weekly_scoped` is the binding constraint (53%, `is_active:true`) while the tray
shows 37%. Nothing currently installed surfaces it.

**Source 4 — `~/Library/Application Support/Claude/plan-usage-history.json`.**
1,967 samples at 15-minute cadence, 2026-08-10 → now,
`{t, org, u:{fh, sd, xu}}`. The only existing longitudinal series. Rolling
30-day cap; only written while the desktop app runs.

**Source 4b — Glaze `usage-history.json`**, at
`~/Library/Application Support/app.glaze.macos.pp8z5ilo/`. 9 sparse days.
Backfill once, same as Source 4.

### Deduplication is mandatory

18,193 assistant records → 8,518 distinct `message.id` (2.13×). Claude Code
writes intermediate streaming usage snapshots then overwrites, so first-seen
undercounts (ccusage issue #888 measured 5× on output). Correct policy:

- Key `(message_id, request_id, session_id)`. When `requestId` is absent (228
  records), store the empty string, **not NULL** — see _Schema_ for why this is
  load-bearing.
- On collision keep max `input + output + cache_creation + cache_read`.
- Tie-break: non-sidechain beats sidechain, then the record carrying
  `usage.speed`.
- Dedupe **globally**, not per-file — resumed sessions replay history across
  files.

### What local data cannot do

In 39% of samples where the meter read ≥15%, there was zero Claude Code activity
in the trailing 5 hours — that is claude.ai and Desktop chat usage, absent from
disk. Five-hour correlation with local output tokens is r=0.69 (≈1.3M output
tokens ≈ 100%); seven-day correlation is r=0.04, i.e. **not derivable**.

The tool reports server truth and local attribution as two distinct things and
never presents a derived percentage as fact.

## Approach

**Runtime: Bun + TypeScript, `bun:sqlite`.** Bun lives at the stable path
`~/.bun/bin/bun` (node is behind an ephemeral fnm multishell path, unsuitable
for launchd). `bun:sqlite` is built in. Pin the current `bun --version` in
`README.md` once the project is scaffolded.

**Dependencies: none until the CLI is functional.** Not a purity rule — a
scoping rule. Everything phases 1–4 need is in Bun's standard library, and
staying at zero through the archiver means the launchd agent has no install
surface that can break. Once the CLI works, adding a dependency is a normal
decision. The TUI phase adds `ink` and `react` and that is expected.

**Location.** Standalone repo, sources under `src/`. The database lives at
`~/.local/share/claude-usage/usage.db` — outside the repo, since it is data, not
config. Add it to `.gitignore`. (If this is later folded into the dotfiles clone
at `.config/claude-usage/` following the `.config/keymap/` precedent, only the
source paths move; the database path does not.)

### Files

| Path                                  | Role                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `src/schema.ts`                       | table DDL + migrations                                                    |
| `src/ingest.ts`                       | transcript walker, dedup, incremental offsets                             |
| `src/limits.ts`                       | snapshot `cachedUsageUtilization`; one-time backfill of Sources 4 and 4b  |
| `src/pricing.ts`                      | reads `pricing-snapshot.json`; refresh is explicit and manual             |
| `src/query.ts`                        | all read queries — pure data in, plain objects out. The TUI imports this. |
| `src/format.ts`                       | pure rendering — rows in, strings out. No I/O, no argument parsing.       |
| `src/cli.ts`                          | argument parsing + dispatch only                                          |
| `src/tui.ts`                          | Ink entrypoint. Stub in phase 1; the only file allowed to import React.   |
| `pricing-snapshot.json`               | committed LiteLLM subset (Claude models only)                             |
| `com.logan.claude-usage.plist`        | launchd agent, full sync, hourly                                          |
| `com.logan.claude-usage-limits.plist` | launchd agent, limits only, every 15 minutes                              |
| `README.md`, `CLAUDE.md`              | how it works / how to work on it                                          |

**The layering matters and CC should not collapse it.** `query.ts` returns data.
`format.ts` turns data into strings. `cli.ts` parses arguments and calls both.
Consequences: `--json` is `JSON.stringify` on a `query.ts` result and never
touches `format.ts`; `format.ts` is unit-testable without spawning a process;
and the TUI consumes `query.ts` directly rather than being a rewrite of
`cli.ts`.

**`src/tui.ts` is a separate bin target.** The archiver runs hourly under
launchd and the statusline may poll `--json` frequently. Neither may ever load
React. If a single binary is preferred later, the TUI command must be a lazy
`await import('./tui.js')`, and that constraint belongs in `CLAUDE.md` because
it is exactly the kind of thing a refactor quietly removes.

### Schema

**`requests`** — one row per deduped assistant turn. PK
`(message_id, request_id, session_id)`, declared **`WITHOUT ROWID`**.

> This is not cosmetic. On an ordinary SQLite rowid table, PRIMARY KEY columns
> are nullable (the legacy NOT NULL bug), and NULLs never compare equal — so the
> 228 records with no `requestId` would insert a fresh duplicate on every sync,
> and an idempotency check that re-runs the same data would still pass.
> `WITHOUT ROWID` enforces the key, and storing `''` for an absent `request_id`
> makes the documented fallback key exact rather than approximate.

Columns: `ts`, `model`, `effort`, `entrypoint`, `session_kind`, `is_sidechain`,
`cwd`, `project`, `git_branch`, `api_block_index`, `cc_version`, `slug`,
`service_tier`, `speed`, `stop_reason`, the five attribution columns, and
`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_creation_tokens`,
`cache_read_tokens`, `ephemeral_5m`, `ephemeral_1h`, `web_search_requests`,
`web_fetch_requests`.

Writes are a single atomic UPSERT implementing the keep-max rule in SQL — not
read-then-decide-then-write:

```sql
INSERT INTO requests (...) VALUES (...)
ON CONFLICT (message_id, request_id, session_id) DO UPDATE SET ...
WHERE excluded.input_tokens + excluded.output_tokens
    + excluded.cache_creation_tokens + excluded.cache_read_tokens
    > requests.input_tokens + requests.output_tokens
    + requests.cache_creation_tokens + requests.cache_read_tokens;
```

Across 563 files, a read-modify-write loop degrades to "keep last" under any
interruption.

**`sessions`** — `session_id` PK, `slug`, `project`, `git_branch`, `first_ts`,
`last_ts`, `entrypoint`, `message_count`, and the `cost-state` roll-up columns.

**`cost_state_models`** — `(session_id, model)` from `cost-state.modelUsage`.
**This is where `claude-opus-5[1m]` lives**; join on it before pricing.

**`tool_calls`** — `(message_id, session_id, ts, tool_name, mcp_server)` from
`tool_use` content blocks. Server attribution is free from the
`mcp__<server>__<tool>` prefix.

**`limit_samples`** — `ts`, `source`, `five_hour_pct`, `five_hour_resets_at`,
`seven_day_pct`, `seven_day_resets_at`, `extra_usage_*`, `spend_*`, plus a child
`limit_scoped` table for the `limits[]` array (`kind`, `group`, `percent`,
`severity`, `resets_at`, `scope_model`, `is_active`).

**`ingest_state`** — `(path, inode, size, mtime, offset)` so re-runs read only
appended bytes. Three rules, all of which the naive version gets wrong:

- **Store offsets only up to the last complete newline.** Transcripts are
  appended live, so a size snapshot can land mid-write and leave a partial JSON
  object. Discard the trailing partial rather than persisting an offset inside
  it.
- **Detect rewrites and rotation.** If `size < stored_size` or
  `inode != stored_inode`, the stored offset is meaningless — force a full
  re-read of that file.
- **Commit per file, not per run.** The first ingest is 327 MB cold under
  launchd; a killed run must resume rather than restart.

### CLI surface

```
cusage sync                       # ingest transcripts + snapshot limits (idempotent)
cusage sync --limits-only         # snapshot cachedUsageUtilization only; cheap, frequent
cusage session [<id>|--last]      # THE headline view: one chat, full token + cost breakdown
cusage sessions --since 7d [--by project|model|entrypoint]
cusage daily | weekly | monthly [--by model]
cusage blocks [--since 30d]       # real 5h blocks via apiBlockIndex
cusage attribution --by skill|agent|mcp|plugin|tool|effort|entrypoint
cusage limits [--history]         # current limits[] incl. weekly_scoped + archived series
cusage cost [--since 30d]         # cost-state where present, LiteLLM-priced elsewhere
cusage pricing --refresh          # explicit, manual, network. Never runs automatically.
cusage export --json | --csv
```

Every command takes `--json` for the TUI and for the statusline.

**Two launchd agents, not one.** `sync` does two things with very different
costs: walking 327 MB of transcripts, and reading one key out of
`~/.claude.json`. Hourly is right for the first and far too coarse for the
second — a 5-hour window sampled hourly is worse resolution than the Source 4
series being backfilled from. So: full `sync` hourly, `sync --limits-only` every
15 minutes.

### Ordering

1. **Archiver first** — `schema.ts` + `ingest.ts` + `limits.ts` + `cusage sync`,
   both launchd agents installed. This stops data loss and ships before any
   reporting exists. Backfill `plan-usage-history.json` (30 days) and Glaze
   `usage-history.json` (9 sparse days) once.
2. `query.ts` + `format.ts` + `cusage session` and `cusage sessions` — the
   attribution this tool exists for.
3. `pricing.ts` + `cusage cost` — `cost-state` is authoritative where it exists
   (157/505 sessions); LiteLLM-price the rest, and flag every row as `measured`
   vs `estimated`.
4. `cusage limits`, `blocks`, `attribution`, `daily/weekly/monthly`.
5. TUI. Ink 7.1.1, which requires React 19.2+ (and Node 22+, moot under Bun).
   Verify prop and hook names against the Ink 7.1.1 docset from the dash-docs
   MCP server rather than from memory — Ink 7 changed input handling, notably
   `key.backspace` where older code used `key.delete`.

### Decisions taken

- **Do not fork ccusage.** It is JSONL-only, prices subscription usage in
  meaningless dollars, infers block boundaries instead of reading
  `apiBlockIndex`, and ignores `limits[]`, `extra_usage`, `cost-state`, and
  every attribution field. The greenfield is the join it does not do:
  server-authoritative window state × local per-request attribution, persisted
  over time.
- **No automatic network calls, ever.** `cachedUsageUtilization` gives the full
  API response for free, and `pricing-snapshot.json` is committed.
  `cusage pricing --refresh` is the only command that touches the network, and
  only when run by hand. If live polling is added later, the CLI's own cache
  guard is 5 minutes — poll no faster than every 3 minutes, and reuse the
  `anthropic-beta: oauth-2025-04-20` header.
- **Never ingest content.** Exclude `message.content` bodies,
  `toolUseResult.stdout`, `history.jsonl` prompts, `paste-cache/`,
  `.credentials.json`, and the `oauthAccount` / `userID` / `machineID` /
  `referral_code_details` keys in `~/.claude.json`. Tool _names_ and token
  _counts_ only.

### Known limits to state in the README, not paper over

- Local data covers Claude Code only; ~39% of plan consumption is invisible.
- `cost-state` covers 157 of 505 sessions; older sessions get estimated pricing.
- `server_tool_use` counters read 0 even when WebSearch/WebFetch ran — those are
  client-side tools, not server tools.
- `ephemeral_5m + ephemeral_1h` misses `cache_creation_input_tokens` by ~4.3K
  tokens across the corpus; do not assume they reconcile exactly.
- Post-compaction (`system` / `compact_boundary`) `cache_read_input_tokens`
  drops discontinuously — do not infer context size from it monotonically.

## Verification

**Freeze a fixture first.** Copy `~/.claude/projects` once to a fixture
directory, record its checksum, and commit the checksum. Every numeric assertion
below runs against that frozen copy — never against live data, which is appended
to continuously and garbage collected. A baseline that drifts trains everyone to
ignore a failing test.

1. `bun run src/cli.ts sync` against the fixture, then re-run — row count must
   not change. Confirm this specifically for the 228 records with no
   `requestId`, which are the ones the PK design exists to protect.
2. Deduped totals against the fixture baseline: 8,518 requests, ~9.91M output,
   ~40.4M cache creation, ~1.071B cache read, ~4.03M thinking. A result near
   18,193 requests or ~34M output means dedup is off.
3. Truncate a fixture file mid-line, sync, then restore the full file and sync
   again — the partial record must be absent after the first run and correct
   after the second.
4. `cusage cost --since 90d` against the `cost-state` ground truth: $715.00
   across 157 sessions, with `claude-opus-5[1m]` at $110.29 as its own row.
5. `cusage limits` must reproduce `cachedUsageUtilization` exactly, including
   the `weekly_scoped` / Fable / 53% / `is_active:true` row.
6. `cusage limits --history` must show 1,967 backfilled samples at 15-minute
   cadence starting 2026-08-10.
7. `cusage session --last` against a single known transcript, cross-checked by
   hand with `jq` on that one file.
8. Delete a transcript file from the fixture, re-run `sync`, confirm archived
   rows survive — that is the whole point of the archiver.
9. `launchctl kickstart` both agents and confirm each writes without a terminal
   attached.
10. `cusage sessions --json | head -c 0` must not load React. Check with
    `bun --inspect` or simply confirm `ink` never appears in the CLI
    entrypoint's import graph.
