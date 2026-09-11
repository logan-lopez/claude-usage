# `cusage` phases 3-4 - the rest of the CLI surface

Successor to `BRIEFING-1.md`, which covered phases 1–2 and is done. That
document is a dated record; where this one contradicts it, this one wins, and
the contradictions are called out explicitly rather than quietly corrected.

Everything numeric below was measured against the live archive on 2026-09-09
(8,913 requests, 511 sessions, 2,013 limit samples, 579 transcripts). The ratios
are the useful part; the absolute numbers grow.

---

## What changed before this plan starts

**The zero-dependency rule is gone.** Its justification was that a launchd agent
must not fail because `node_modules` is missing or half-installed.
`bun build --compile` answers that better than abstinence: measured, the current
CLI compiles to a 60 MB self-contained binary in 250 ms and starts in **39 ms
against 98 ms** for `bun run src/cli.ts`. `bun:sqlite` works inside the binary;
`status` and `limits` were run from it against the real archive and produced
identical output.

Adding a dependency is now an ordinary decision. Two things survive:
`react`/`ink` stay out of the CLI's import graph (startup cost, not dep count —
and `tests/cli.test.ts` still enforces it), and no second network host.

**The binary becomes the install path** (decided, this briefing). See
[§7](#7-packaging-and-the-install-path).

**`cusage pricing --refresh` is cancelled** (decided, this briefing). Refreshing
the price table becomes `bun run tools/refresh-pricing.ts`, a dev script run by
hand. `api.anthropic.com` stays the only host any shipped code contacts, and
that stays a fact you can state flatly. See [§4](#4-cost-and-pricing).

---

## Three corrections to BRIEFING-1

### 1. `api_block_index` is not a five-hour window id

BRIEFING-1 specified `cusage blocks` as "real 5h blocks via `apiBlockIndex`," on
the assumption that the field identifies the server's rate-limit window. It does
not. It is a **per-session counter**:

| block | distinct sessions | rows  | first      | last       |
| ----- | ----------------- | ----- | ---------- | ---------- |
| 0     | 346               | 4,596 | 2026-09-02 | 2026-09-09 |
| 1     | 40                | 956   | 2026-09-02 | 2026-09-09 |
| 2     | 32                | 324   | 2026-09-02 | 2026-09-09 |

Block 0 appears in 346 different sessions spread across the whole week; two
sessions starting seven minutes apart both report block 0. It is also only 67%
populated (5,932 of 8,913). Grouping by it produces something, and that
something is not a five-hour window.

### 2. `five_hour_resets_at` cannot be used as a window key naively

It is the obvious replacement, and it has two problems. Only **11 of 2,013**
limit samples carry it at all — the 1,993 desktop-history samples have no reset
time, so there is no history. And the value **drifts within a single window**:
the server returns `now + remaining`, freshly computed per sample, so one window
appears as both `01:29` and `01:30` when rounded to the minute. Ten samples of
the same window spanned two "different" minutes. Clustering must be
tolerance-based (samples within ~2 minutes are the same window), never equality
or truncation.

### 3. Gap inference does not work on this corpus

The ccusage approach — a new block starts on the first request after a ≥5h gap —
finds **31 gaps ≥5h across 8,884 requests in 70 days**. Usage here is close to
continuous, so gap inference yields ~32 blocks where there should be hundreds.

**Consequence:** `cusage blocks` is redesigned in [§5](#5-blocks-redesigned).
The window boundary is server truth from the limit series, and local requests
are laid alongside it — never used to define it.

---

## 1. Argument parsing: adopt `commander`

The surface goes from 6 commands to ~14, most with per-command flags. The
current hand-rolled parser has one global `VALUE_FLAGS` set, a hand-maintained
`USAGE` string that will drift the moment it doubles in size, and no per-command
validation — `cusage limits --bogus x` silently drops `x` into positionals
today.

Three candidates were installed and benchmarked as compiled binaries with an
equivalent 6-subcommand CLI. All three have **zero transitive dependencies** and
all three compile cleanly:

|               | version | size  | startup | unknown flag         | exit  |
| ------------- | ------- | ----- | ------- | -------------------- | ----- |
| (raw argv)    | —       | —     | 20.2 ms | —                    | —     |
| citty         | 0.2.2   | 52 K  | 22.6 ms | **silently ignored** | **0** |
| @stricli/core | 1.3.0   | 336 K | 23.6 ms | rejected             | 252   |
| commander     | 15.0.0  | 232 K | 25.6 ms | rejected             | 1     |

Startup is not a differentiator — 2–5 ms over raw argv, against the ~39 ms the
real CLI already spends opening SQLite.

**citty is disqualified.** It accepts an unknown flag and exits 0. That is
precisely the bug class this repo already fixed by hand (`cusage --json status`
printing help and exiting 0), and the comment explaining it is still in
`cli.ts`. Adopting a library that reintroduces it would be a regression bought
with a dependency.

**Take `commander`.** Rejects unknown flags, per-command options, generated help
that cannot drift, universally known — which matters when the executor is an
agent that will get an obscure API subtly wrong.

`@stricli/core` is the runner-up and its advantage is real:
`loader: () => import("./impl")` makes lazy command loading the mandatory idiom,
which is structurally the layering `CLAUDE.md` currently protects with a comment
and one test. It loses on obscurity and on being 6× the size for twelve flags.
If types at the argv boundary turn out to matter more than expected, it is the
one to revisit.

**Migration rules:**

- Do this **first**, before adding any command. Migrating 6 commands is half the
  work of migrating 14.
- Preserve the exit-code contract: `0` success, `1` "no matching session"-class
  empty results, `2` usage error. Commander exits 1 on an unknown option — use
  `.exitOverride()` and map it to 2.
- Preserve `--json` bypassing `format.ts` entirely, and `--json` implying
  `--no-color`.
- Keep `parseArgs` exported until the tests that assert its behaviour are
  ported; the two regression tests in `tests/cli.test.ts` describe real bugs and
  their assertions must survive in some form.
- Global options (`--db`, `--json`, `--no-color`, `--refresh`, `--no-refresh`)
  must work **before or after** the subcommand. That is what the original bug
  was about.

---

## 2. Shared vocabulary — design once, not eight times

Every command below draws from one set. Put it in `src/args.ts` as commander
option factories so a flag means the same thing everywhere.

| flag                      | meaning          | notes                                                       |
| ------------------------- | ---------------- | ----------------------------------------------------------- |
| `--since <dur\|iso\|all>` | window start     | `parseSince` already handles `7d`, `2w`, ISO, `all`         |
| `--until <dur\|iso>`      | window end       | **new** — needed for `daily --since 30d --until 7d`         |
| `--by <dim>`              | grouping         | per-command enum; invalid value must name the valid set     |
| `--limit <n>`             | row cap          | reject non-integers loudly; currently `Number("x")` → `NaN` |
| `--project <p>`           | filter           | substring, case-insensitive                                 |
| `--model <m>`             | filter           | **new**                                                     |
| `--json`                  | machine output   | `JSON.stringify` of a `query.ts` result                     |
| `--csv`                   | machine output   | **new** — see below                                         |
| `--db <path>`             | archive override |                                                             |
| `--no-color`              | plain            |                                                             |

**`--csv` gets its own module, `src/serialize.ts`.** Not `format.ts` (which owns
ANSI, padding, and human framing) and not `cli.ts`. It is pure — rows in, string
out — and the existing rule generalises cleanly: _machine output never touches
the formatter._ Add a test asserting `--csv` output contains no ANSI, mirroring
the one that exists for `--json`.

**Every grouped view must print its coverage.** See [§3](#3-attribution); this
is the single most important cross-cutting rule in this briefing.

---

## 3. Attribution

`cusage attribution --by <dim>` — pure query over columns that already exist. No
new data source, no pricing. **Build this first after the parser**; it is the
cheapest large win in the plan.

Measured fill rates, which are the whole design problem:

| dimension  | column                   | non-null     | of 8,913 | distinct |
| ---------- | ------------------------ | ------------ | -------- | -------- |
| agent      | `attribution_agent`      | 1,012        | 11.4%    | 5        |
| skill      | `attribution_skill`      | 397          | 4.5%     | 14       |
| plugin     | `attribution_plugin`     | 142          | 1.6%     | —        |
| mcp        | `attribution_mcp_server` | 215          | 2.4%     | 16       |
| tool       | `tool_calls.tool_name`   | 11.6 K calls | —        | 72       |
| effort     | `effort`                 | 8,658        | 97.1%    | 4        |
| entrypoint | `entrypoint`             | 8,894        | 99.8%    | 4        |
| branch     | `git_branch`             | 8,913        | 100%     | —        |
| version    | `cc_version`             | 8,913        | 100%     | 29       |
| model      | `model`                  | 8,913        | 100%     | 9        |

**The rule this forces:** a view that groups 8,913 requests by skill and shows
397 of them is not "skills are 4% of usage" — it is "we can attribute 4% of
usage to a skill." Every attribution table prints a coverage line:

```
attributed: 397 of 8,913 requests (4.5%) · 8,516 unattributed
```

Without it the view is a derived number presented as fact, which the repo
already forbids for cost and limits. It applies here identically.

**`is_sidechain` ⟺ `attribution_agent IS NOT NULL`, exactly** — 7,901 rows with
neither, 1,012 with both, zero exceptions. Sub-agent turns and agent-attributed
turns are the same 1,012 rows. Do not build two code paths for them.

Sub-agent attribution does **not** get its own command. `attribution --by agent`
gives the flat cut, and `cusage session` gains a sub-agent breakdown (parent
session → agents it spawned → their tokens), which is a different shape and is
what the README means by the headline feature.

---

## 4. Cost and pricing

The largest piece, and the one with the most ways to be quietly wrong.

### `pricing-snapshot.json`

Committed, dated, with a `source` and `fetched_at`. Refreshed by
`bun run tools/refresh-pricing.ts` — a **dev script, never a CLI command, never
scheduled**. Rates as of 2026-06-24 (per 1M tokens):

| model                                                                    | input  | output |
| ------------------------------------------------------------------------ | ------ | ------ |
| `claude-fable-5-1`, `claude-fable-5`                                     | $10.00 | $50.00 |
| `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6` | $5.00  | $25.00 |
| `claude-sonnet-5`                                                        | $2.00  | $10.00 |
| `claude-sonnet-4-6`                                                      | $3.00  | $15.00 |
| `claude-haiku-4-5`                                                       | $1.00  | $5.00  |

Cache: creation ≈ 1.25× input, read ≈ 0.1× input — **except Fable 5.1, where
cache reads are $0.25/MTok**, i.e. 0.025×, not 0.1×. Hard-coding a single 0.1
multiplier overcharges Fable 5.1 cache reads by 4×, and Fable 5.1 is the largest
single line in the measured corpus ($434.72 of $748.23). Rates go in the
snapshot per model, not as multipliers in code.

`speed: "fast"` is priced $10/$50 on Opus 5. **Zero requests in the corpus use
it** — every row is `speed: "standard"`. Key the price lookup on
`(model, speed)` anyway; the column exists and the day it changes should not be
a silent 2× error.

### The `[1m]` problem — state it, do not solve it

`claude-opus-5[1m]` appears **33 times in `cost_state_models` and zero times in
`requests`**. Those 33 sessions' 1,440 requests all report plain
`claude-opus-5`. There is no field anywhere in a transcript that marks a request
as having run on the 1M-context tier.

- **$143.34 of $748.23 measured spend (19%)** sits in that bucket.
- The skill's pricing table documents no `[1m]` premium at all, so the rate is
  additionally unknown.

What is buildable: for the **165 sessions that have cost-state**, the session's
model list tells you it was `[1m]`, so those requests can be back-labelled. For
the **346 sessions without cost-state**, `[1m]` is undetectable and unpriceable.
Estimated rows for those sessions must be labelled as not distinguishing the
tier. Do not interpolate, do not assume a multiplier, do not average.

### `cusage cost`

```
cusage cost [--since 30d] [--by model|project|session|day] [--measured|--estimated]
```

- Every row is `measured` (from cost-state) or `estimated` (priced from tokens).
  **Never blended into one number.** 165 of 511 sessions are measured.
- Grouped cost keeps the existing exact-or-absent rule: a session straddling
  several projects is counted, its cost excluded, and the column marked `+`.
  That rule already exists in `query.ts` — reuse it, do not re-derive it.
- cost-state records are **cumulative**; keep max per session. Summing all 371
  gives $1,652 against a true $748.

### Acceptance test for the estimator

Do not calibrate per model — there are only **8 single-model measured sessions**
in the whole corpus (2 Fable 5.1 sessions at $9.00, 1 Opus 5 at $1.35, 5 Haiku
at $0.01). That is not a sample.

Instead, run the estimator over the 165 measured sessions **in aggregate** and
compare the estimate against `total_cost_usd` per session. Report the error
distribution — median, p90, worst — as a committed number in the README, and
assert a bound in the test suite. Sessions containing `[1m]` will be the tail;
that is expected and should be visible, not smoothed.

---

## 5. Blocks, redesigned

Given [the three corrections](#three-corrections-to-briefing-1), `cusage blocks`
becomes a **five-hour meter cycle view**, driven by `limit_samples`:

```
cusage blocks [--since 7d]
```

- A cycle boundary is a sharp **drop in `five_hour_pct`** in the archived
  series. That is server truth observed over time, not an inference about
  tokens. 1,993 desktop-history samples at 15-minute cadence make it detectable.
- Where an oauth sample carries `five_hour_resets_at`, use it to _confirm_ a
  boundary, clustering with a ~2-minute tolerance. Never as the sole key.
- Per cycle: peak %, time to peak, reset time, and — laid **alongside**, clearly
  separated — local request count and tokens in the same interval.
- The correlation caveat is not optional here. r=0.69 for five_hour against
  local output tokens; 39% of intervals reading ≥15% had zero local activity.
  The local column is context, not explanation.
- Gaps stay gaps. The existing `·` convention in `renderLimitsHistory` applies:
  those are hours the desktop app was not running.

Separately, expose `api_block_index` where it is honest — as a per-session count
in `cusage session` ("3 API blocks"), which is what it actually measures.

---

## 6. Time series

`daily` / `weekly` / `monthly` are one query with three bucket sizes. Implement
`cusage timeline --bucket day|week|month`, register `daily`/`weekly`/`monthly`
as commander aliases that pre-set `--bucket`, and write the query once.

```
cusage timeline --bucket day [--since 30d] [--by model|project|effort] [--csv]
```

- Bucket in **UTC**, and say so in the header. `limitsHistory` already buckets
  by UTC day; two different day boundaries in one tool is a bug waiting to be
  filed.
- Reuse `chooseBucket` from `query.ts` for the auto case rather than adding a
  second bucketing implementation.
- Empty buckets are rendered, not skipped — a day with no usage is data.

---

## 7. Packaging and the install path

```
make build       # bun build src/cli.ts --compile --outfile dist/cusage
make install     # cp dist/cusage ~/.local/bin/cusage
```

- The two launchd templates change from `bun run {{REPO}}/src/cli.ts` to
  `{{HOME}}/.local/bin/cusage`. This removes the Conductor-worktree hazard that
  `scripts/install-agents.sh` currently only _warns_ about — a binary at a fixed
  path does not stop existing when a workspace is archived.
- `src/tui.ts` compiles to its own binary. It stays a separate bin target; that
  is unchanged and non-negotiable.
- **The rebuild step is the new failure mode.** A stale binary is worse than a
  missing one because it works. Stamp the build: inject `Bun.env` or a generated
  `src/version.ts` carrying the git SHA and build time at compile, and have
  `cusage doctor` compare it against the repo HEAD.

---

## 8. Operational commands

Neither of these is in BRIEFING-1. Both address failure modes the tool already
has.

### `cusage doctor`

The archiver's real failure mode is silence: a launchd agent that has been
erroring for three weeks looks exactly like one that is working. Checks:

- both agents loaded (`launchctl print gui/$UID/<label>`), last exit status
- age of the newest row in `requests` and in `limit_samples`, against the
  agents' intervals — "last sync 4h ago, hourly agent" is a failure
- binary build SHA vs repo HEAD ([§7](#7-packaging-and-the-install-path))
- `PRAGMA integrity_check`, archive size, `ingest_state` rows whose file no
  longer exists
- credential reachable — **presence only**. Never print, log, or length-check
  the token; `redact()` applies here too
- transcript dir present and non-empty

Exit 0 all-clear, 1 warnings, 2 something is broken. That makes it usable from a
cron or a shell prompt.

### `cusage statusline`

One line, no ANSI unless a TTY, designed to be polled several times a minute:

```
Fable 74% · 5h 4% · $12.40 today
```

The repo's performance constraints are written as if this exists; nothing
implements it. It must respect the 3-minute refresh floor (it already will — the
floor is persisted in `meta` and shared across processes) and must degrade to
the archived number with an age marker rather than blocking on the network.

---

## 9. Export

```
cusage export --format json|ndjson|csv [--table requests|sessions|tools|limits] [--since 30d]
```

Straight dump through `src/serialize.ts`. NDJSON for the large tables so it
streams rather than building an 8,913-element array in memory — that is fine
today and stops being fine at 100 K rows.

---

## 10. Optional: `cusage cache`

Lower priority, but it answers a question nothing else in the tool does and the
data is exceptionally good for it. Corpus-wide: **1.12 B cache-read tokens
against 42.3 M cache-creation** — a 26× reuse ratio, and the single largest
lever on what a subscription actually burns.

```
cusage cache [--since 30d] [--by model|project]
```

Read/creation ratio, the `ephemeral_5m` vs `ephemeral_1h` split, and the
reconciliation gap stated rather than hidden — `ephemeral_5m + ephemeral_1h`
misses `cache_creation_input_tokens` by ~1 K tokens out of 42 M corpus-wide.
Print the gap; do not silently normalise it away.

---

## Build order

Each step ends with a green suite and a usable CLI.

1. **`commander` migration.** No new commands. Behaviour-preserving, and the two
   argv regression tests must still pass in ported form.
2. **`src/args.ts` + `src/serialize.ts`.** Shared flags, `--csv`, the
   no-ANSI-in-machine-output test.
3. **`attribution`.** Pure query. Establishes the coverage-line convention that
   every later view inherits.
4. **`timeline` + `daily`/`weekly`/`monthly` aliases.** UTC, reuses
   `chooseBucket`.
5. **`export`.** Falls out of step 2 almost free.
6. **`make build` + binary install + launchd templates + `doctor`.** Do this
   before `cost` — `doctor` is what tells you the archive stopped growing while
   you were busy writing the pricing model.
7. **`pricing.ts` + `pricing-snapshot.json` + `tools/refresh-pricing.ts` +
   `cost`.** With the aggregate-error acceptance test.
8. **`blocks`,** redesigned per [§5](#5-blocks-redesigned).
9. **`statusline`.**
10. **`cache`,** if it still seems worth it by then.

The TUI is deliberately out of scope. It wants its own briefing written against
a `query.ts` that has stopped moving, and `query.ts` moves in every step above.

---

## Invariants the executor must not quietly remove

All of these already exist and all of them are the kind of thing a reasonable
refactor deletes.

- `query.ts` → data, `format.ts` → strings, `cli.ts` → argv. `--json` and
  `--csv` never touch `format.ts`; `format.ts` never takes a `Database`.
- `react`/`ink` unreachable from `cli.ts`. `tests/cli.test.ts` walks the import
  graph. If the TUI is ever folded into one binary, that test must become an
  _evaluated-at-startup_ check, because `bun build --compile` bundles a dynamic
  import into the same file — static reachability stops being the right
  question.
- `requests` is `WITHOUT ROWID`; `request_id` is `''`, never `NULL`.
- Ingest is one atomic keep-max UPSERT. `ingest_state`: last complete newline,
  re-read on shrink or inode change, commit per file.
- One network host, one endpoint, 3-minute floor keyed on attempts, persisted in
  `meta`, `Math.max(180_000, env)`. `--refresh` does not bypass it. `oauth.ts`
  is the only file that may call `fetch`.
- Never present a stale number as current; never present a derived number as
  fact. Every figure carries its source and its age.
- Never ingest content. Tool names and token counts only.
- Fixtures are frozen and scrubbed by allowlist; `BASELINE.json` is computed by
  a second, independent dedup implementation in `tools/make-fixture.ts`. Keep
  them separate.
- The suite is offline. `CUSAGE_REFRESH=off` in spawned CLIs; the one real
  request points at `127.0.0.1:1`.
