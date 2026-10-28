# Pricing and cost

Cost has two bases that are never added together:

- **Measured**, from Claude Code's per-session cost-state.
- **Estimated**, from an explicit price table applied to token counts.

Grouped views report measured cost exactly or not at all.

**Sources:** `src/pricing.ts`, `src/pricing-snapshot.json`, `tools/refresh-pricing.ts`, `tools/make-pricing-calibration.ts`, `src/query.ts`

**History:** [brief 02](../briefs/archive/02-cli-reports-and-binaries.md)

- `pricing.ts` normalizes model names (`normalizeModel`) and prices one request
  (`estimateRequest`) from `pricing-snapshot.json`.
- `query.ts` holds:
  - `MEASURED_COST`, the SQL expression every reader of measured cost uses;
  - `exactSessionCost`, the shared exact-or-absent decision;
  - `sessionCosts`, `cost`, `groupSessions` and `estimatorAudit`.

## How it works

**Measured cost** is the cumulative cost-state total per session, keeping the max because the
records are cumulative. `MEASURED_COST` returns `NULL` for a session flagged
`has_unknown_model_cost`: Claude Code charged a model it had no rate for at another model's rate,
so that total is a guess. Such sessions fall through to the estimator, which declines unknown
models, and `renderSession` labels them unpriced.

**Estimated cost** applies explicit per-model, per-speed rates for input, output, cache creation
and cache read.

- Dated aliases normalize to the base model.
- Missing speed means standard.
- Cache creation uses the 5-minute rate, not an inferred 1-hour premium.
- Thinking tokens are already in output.
- Unknown models and speeds, and known `[1m]` tiers, are unpriced, never guessed.
- Without cost-state the tier can't be detected, so estimated rows count the requests whose tier
  is unknown.

**Grouped cost** (`groupSessions`, `cost --by …`) goes through `exactSessionCost`. A session
contributes measured dollars to a group only if:

- all of its requests are in that one group, and
- no time, project or model filter removed any of them.

Split or partly selected sessions still contribute requests. Their cost is excluded and counted in
`sessions_split` (a whole session with no measured cost counts in `sessions_unpriced`),
`cost_complete` is false, and the renderer marks the column `+`.

`groupSessions` reads every (session, group) pair in the selection in one statement, with the
session's lifetime request and group counts, how many of its requests the filters kept, and its
`MEASURED_COST`. Three queries per session took about 330 ms on 93K requests; this takes about
230. `tests/query.test.ts` keeps the old loop as a parity oracle.

**The price table.** `pricing-snapshot.json` was transcribed from the approved phase 3–4 briefing, with
rates dated 2026-06-24. Its `fetched_at` is `null`, because transcription isn't a fetch.
`tools/refresh-pricing.ts` downloads the pricing documentation to
`.context/pricing-source.html` and changes the snapshot only from reviewed structured rates
(`--rates <file>`). There's no shipped `pricing` command.

## Rules worth keeping

- **Measured and estimated never blend** into one total. `--measured` and `--estimated` select a
  basis; they don't turn measured sessions into estimates.
- **Every reader of "measured" goes through `MEASURED_COST`.** A view that reads
  `total_cost_usd` directly prints a fallback-priced guess as spend.
- **Grouped cost is exact or absent.** Never sum a session's total into each group it touched,
  and never apportion it by token share.
  - Output tokens cost about 5× input and cache reads about 0.1×, so a token split isn't a cost
    proxy.
  - `cost --by session --since all` is the exact session cut.
- **This is API-equivalent cost, not subscription billing.**
- **`statusline` carries no dollar figure.** `cost --by day` excludes any session straddling UTC
  midnight, which is nearly always the one in progress, so a cost there would read $0.00 for most
  of the day.
- **No rates are fitted to the observed error.** The calibration is an audit, not a training set.

## Decisions

- **Why exact or absent.** cost-state is per session, and one session's requests can land in
  several groups: one chat dispatching sub-agents across three worktrees is one session and three
  projects. Summing each session's total into every group it touched turned $90.38 of real spend
  into $226 on the test fixture, and every inflated row looked plausible.
  - Dropping the column was rejected as less informative than an exact partial with a stated
    exclusion.
  - Consequence: `cost --by model` and `sessions --by model` show large exclusions, because
    almost every session touches more than one model. That's correct, not a bug.
- **The frozen estimator audit.** `fixtures/pricing-calibration.json` holds 166 anonymous
  measured sessions captured from the live archive on 2026-09-10 UTC. It keeps only model and
  speed token aggregates, tier model names and cumulative dollar truth.
  `bun run tools/make-pricing-calibration.ts` regenerates it; ordinary tests never read live data.
  It was captured before `MEASURED_COST` existed, when "measured" meant any non-null
  `total_cost_usd`. So it may include fallback-priced totals that the generator would now leave
  out. Regenerating it changes every figure below and the test's exact assertions.

  | Audit measure | Frozen result |
  | --- | ---: |
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
  | of those, sessions with no ingested requests | 64 |

  - **Errors are scored over the 61 fully priced sessions only.**
    - A session whose every request is `[1m]` or an unknown model estimates to $0 and scores
      exactly 1.0. That's an absence graded as a wrong answer, not a 100% error.
    - Pooling the two buckets put 37 sessions at 1.0 and pinned p90 to 100%, a bound no
      estimator improvement could move.
    - The declined bucket is reported beside the distribution, in dollars.
  - The offline suite fixes these totals and asserts median under 19%, p90 under 28% and worst
    under 80%.
  - Within scored sessions the estimate runs about 15% low in aggregate. That's not yet
    explained. The first suspect is pricing `ephemeral_1h` cache creation at the 5-minute rate.
