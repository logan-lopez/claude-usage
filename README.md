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
cusage attribution --by skill   # attributed requests and missing coverage
cusage daily --since 30d        # UTC timeline, including empty days
cusage cost --by session        # measured and estimated costs stay separate
cusage blocks --since 7d        # observed meter cycles, local tokens alongside
cusage cache --by model         # cache ratios and the reconciliation gap
cusage statusline               # archived one-line view; refresh in background
cusage doctor                  # archive, launchd, credentials and build health
cusage export --format ndjson   # streaming archive export
```

## Install

Development builds require [Bun](https://bun.com) (**1.3.3 tested**).
Commander 15 is the CLI's runtime dependency. Installed executables embed Bun
and their dependencies; neither the checkout nor `node_modules` is needed to run.

```bash
bun install --frozen-lockfile
make build                  # dist/cusage and separate dist/cusage-tui
make install                # rebuild; atomic replacement in ~/.local/bin
cusage sync                 # first sync: ~2s for a 240 MB corpus
./scripts/install-agents.sh # hourly sync + 15-minute limits snapshot
```

Launch agents execute `~/.local/bin/cusage` with `$HOME` as their working
directory. Archiving a Conductor worktree no longer removes their executable
or working directory. `make install` does not reload launch agents; rerun the
installer once to migrate existing plists. The TUI binary remains a separate
phase-5 stub, not part of the CLI import graph.

Every build embeds its Git SHA, build time, source checkout and dirty flag.
`cusage doctor --repo /path/to/checkout` compares against that checkout's HEAD;
`CUSAGE_REPO` overrides the embedded path. A missing checkout, different SHA,
or dirty build is a warning, not a silently trusted build. Rebuild after edits.
`BIN_DIR` can override the installation directory for packaging tests.

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
  host is contacted by shipped code. The manually invoked developer pricing
  refresh tool downloads pricing documentation; it is not shipped or scheduled. It is a read; nothing is sent but
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
- **`cost-state` covered 166 of 513 sessions in the calibration capture.**
  Other sessions use explicit token rates and are labelled estimated, never
  blended with measured spend. This is API-equivalent cost, not subscription billing.
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

## CLI reporting contracts

Run `cusage --help` or `cusage <command> --help` for generated option help.
Unknown options and invalid grouping values fail with exit 2. Exit 0 means
success; `session` with no match exits 1. Doctor uses 0 clear, 1 warnings,
2 broken. `--db`, `--json`, `--csv`, `--no-color`, `--refresh` and
`--no-refresh` work before or after the command. JSON and CSV never load the
human formatter. CSV quotes commas, quotes and newlines; report metadata,
including coverage, repeats on each data row.

Request reports accept `--since <duration|ISO|all>`, `--until <duration|ISO>`,
`--project <substring>`, `--model <substring>`, and positive-integer `--limit`.
Project/model matching is case-insensitive and literal (`%` is not a wildcard).
Windows are start-inclusive/end-exclusive. Session lists and session exports
select whole sessions by their last activity, so their totals remain lifetime
totals; grouped session reports filter individual requests. Limit history
retains its existing inclusive endpoint convention.

Every grouped report includes request coverage. `sessions --by ... --json`
now returns `{ rows, coverage, ...metadata }`, not the old bare array.
Row limits never change coverage or cost report totals. Tool attribution counts
calls separately and uses each matching request once per tool; a request can
appear under several tools, so those token columns must not be summed as
per-tool consumption. Session details also show spawned agent identities and
the count of distinct per-session API block indexes.

### Timeline and export

`timeline --bucket day|week|month|auto` shares one query with `daily`, `weekly`,
and `monthly` (fixed day/week/month presets). Calendar boundaries are UTC,
weeks begin Monday, and empty buckets are emitted for each selected group.
Auto uses the existing `chooseBucket` ladder. The default window is 30 days.

`export --table requests|sessions|tools|limits --format json|ndjson|csv`
iterates SQLite rows and respects stdout backpressure. All three formats
stream; NDJSON is the default. `--json` and `--csv` are shortcuts; conflicting
format choices fail. Limit samples cannot be filtered by local project/model.

### Cost: exact measurements, explicitly incomplete estimates

`cost [--since 30d] [--by model|project|session|day] [--measured|--estimated]`
never combines measured and estimated dollars into one total. The mode flags
select the measurement basis; they do not force measured sessions to become
estimates. Measured cost is cumulative keep-max per session. A session spanning
several groups **or partly excluded by a time/project/model filter** contributes
requests but no measured dollars; `+` and exclusion counts explain the gap.
The same `exactSessionCost` rule is used by `sessions --by` and `cost`.
Consequently `cost --by model` can have substantial measured exclusions for
multi-model sessions; `cost --by session --since all` is the exact session cut.

`src/pricing-snapshot.json` contains explicit per-model/per-speed input,
output, cache-creation and cache-read rates from the approved briefing (dated
2026-06-24). Its initial `fetched_at` is **null**, because transcription from
the briefing is not an independent fetch. Fable 5.1 cache reads are $0.25/MTok;
Opus 5 fast has its own rate. Dated aliases normalize to the base model.
Unknown models/speeds and known `[1m]` tiers are unpriced, never guessed.
Missing speed assumes standard; cache creation uses the briefing's 5m rate,
not an inferred 1h premium. Thinking tokens are already included in output.

Cost-state model lists back-label known `[1m]` requests for the estimator audit.
Without cost-state, the tier cannot be detected: estimated rows explicitly
count requests whose tier is unknown. Estimates are rate-based API equivalents,
not a measurement of subscription consumption.

```bash
bun run tools/refresh-pricing.ts
# Review .context/pricing-source.html and prepare explicit rates, then:
bun run tools/refresh-pricing.ts --rates /path/to/curated-snapshot.json
```

The developer tool fetches documentation and requires reviewed structured
rates before changing the snapshot. It never scrapes monetary values into a
production price table blindly. There is no shipped `pricing` command.

#### Frozen aggregate estimator acceptance

Captured from the read-only live archive on 2026-09-10 UTC (2026-09-09 local),
`fixtures/pricing-calibration.json` holds **166 anonymous measured sessions**:
only model/speed token aggregates, tier model names, and cumulative dollar
truth. No IDs, paths, timestamps per session, or content. Regenerate explicitly
with `bun run tools/make-pricing-calibration.ts`; ordinary tests never read live data.

| Audit measure | Frozen result |
|---|---:|
| Measured sessions | 166 |
| Measured total | $752.04845015 |
| Known-rate estimated subtotal | $500.15662315 |
| **Scored sessions** (every request priced, positive measured cost) | **61** |
| Their measured total | $487.72388835 |
| Their estimated total | $413.49632860 |
| Median absolute relative error | 18.21% |
| p90 absolute relative error | 26.58% |
| Worst absolute relative error | 78.36% |
| **Declined sessions** (nothing to price, or a request refused a rate) | **105** |
| Their measured total | $264.32456180 |
| — of those, sessions with no ingested requests | 64 |

Errors compare each session's known-rate subtotal with cumulative measured
cost, and are computed over **scored sessions only**. That split is the point.
A session whose every request is `[1m]` or an unknown model estimates to $0 and
scores a relative error of exactly 1.0 — which is not a 100% estimation error,
it is an absence graded as a wrong answer. Pooling the two buckets put 37
sessions at exactly 1.0 and pinned p90 to 100.00%, a figure no improvement to
the estimator could ever have moved. The declined bucket is reported beside the
distribution, in dollars, so the hole stays visible.

These are still **not accuracy claims for a complete estimator**: $264.32 of
measured spend has no comparable estimate at all. Within the sessions that can
be scored, the estimate runs about **15% low in aggregate** ($413.50 against
$487.72), which is a real signal and not yet explained — `ephemeral_1h` cache
creation being priced at the 5-minute multiplier is the first suspect. The
offline suite fixes the dollar totals and asserts median <19%, p90 <28%,
worst <80%, without fitting any rates.

### Observed meter cycles

`blocks --since 7d` uses one source's five-hour meter series: desktop history
when available, otherwise live OAuth, otherwise cached OAuth. A boundary is a
drop of at least **5 percentage points and 50%** between adjacent samples.
This conservative threshold can miss low-utilization resets; it does not invent
windows from request gaps or `api_block_index`.

OAuth reset timestamps confirm observed boundaries only. They are clustered
within two minutes of a fixed cluster anchor, not equality or minute truncation.
Unconfirmed resets remain observation brackets. Gaps over 30 minutes stay `·`;
local activity during gaps is not assigned to a cycle. First/last cycles are
partial, and time-to-peak starts at the first observation. Local request/token
columns are context alongside the server meter, not a causal explanation.

### Operations

`statusline` returns one archived line immediately, with per-meter source/age
and UTC-today token and request counts. It carries **no dollar figure by
design**: `cost --by day` correctly excludes any session straddling midnight,
which is nearly always the session in progress, so a cost here would read
$0.00 for most of the day. Tokens need no attribution or price table and are
exact. Cost lives in `cusage cost`, where the exclusions are on screen. A
short-lived background CLI refreshes stale limits; it never delays the line for
keychain/network. The SQLite attempt claim
is atomic across processes, and the same three-minute floor applies. Use
`--no-refresh` or `CUSAGE_REFRESH=off` to disable the worker.

`doctor` checks both launch agents and their exit status, newest request/limit
row ages, read-only integrity, file size, disappeared ingest sources, build
stamp, credential presence, and transcript directory availability. Stale rows
beyond twice the job interval are broken checks; inactivity can also cause an
old request row, and the diagnostic says so. Deleted source files are warnings:
the archive intentionally survives them. Credentials are never shown.

`cache --by model|project` shows cache read/creation ratio, 5m/1h creation counts,
and `creation - (5m + 1h)` as a signed reconciliation gap. Nothing is normalized.

## Testing

```bash
bun test          # offline: frozen fixtures and synthetic edge cases
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
| 3 | pricing snapshot, `cost`, frozen aggregate calibration | done |
| 4 | attribution, timeline/aliases, export, cycles, cache, doctor, statusline, binaries | done |
| 5 | Ink TUI | not started |

The TUI remains out of scope. `pricing --refresh` was cancelled; pricing refresh is developer-only.
