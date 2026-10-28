# Brief 08: The Timeline and Limits tabs

**Size:** L. Two screens and a `blocks()` speedup with a parity oracle, each about Breakdown's size.

Read `CLAUDE.md`, [`README.md`](README.md), [the TUI page](../architecture/tui.md), [the limits
page](../architecture/limits.md), [the over-time guide page](../guide/over-time.md), [the limits
guide page](../guide/limits.md), [the explorer guide page](../guide/explorer.md) and
[`FUTURE.md`](FUTURE.md) § Further TUI tabs (Timeline, Limits) first. Then read
[brief 07](07-tui-breakdown-tab.md): `src/tui/breakdown.tsx` is the pattern both new tabs follow.
Briefs 06 and 07 must have landed (`0566329` in `HEAD`'s history).

## Goal

The last two tabs from the 2026-10-28 `/ideate` run:

- **4 Timeline.** Output-token bars per day, week or month (`b`), so the explorer can zoom out
  past Overview's 30 days. A table under the chart splits the bucket under the cursor by model,
  project or effort (`g`). Enter drills to that bucket's sessions, or to one series within it.
  One line at the top compares the output on screen to classic books.
- **5 Limits.** Each meter's current reading with its source and age, every archived source, and
  any disagreements, as `cusage limits` shows them. Under that, history you can zoom (72 hours,
  7 days, 30 days with ←→) and the observed five-hour cycles in that window. Enter on a cycle
  drills to the sessions active during it. This is the tab to leave open.
- **First, `blocks()` gets fast** with identical output. It backs the Limits tab and reruns on
  every archive change while the tab is showing.

## Decisions already made

Decided with Logan, 2026-10-28. Don't revisit them silently.

- **One brief for both tabs**, Limits' speedup first.
- **Timeline's bars show the total; series show in a table.** The chart is one series of bars
  with a ▲ cursor, as in Overview's Daily output. The table under it lists the chosen bucket by
  series. No stacked or per-series coloured bars: 365 projects and the WCAG palette test rule
  them out.
- **Timeline's bars are output tokens.** Cache reads are 97.9% of total tokens over 30 days, so
  bars of total tokens would chart context size rather than work. The table still shows total
  tokens, requests and cache-read share.
- **The `blocks()` fix stays inside `blocks()`.** `requestWhere` and its other callers are left
  alone; the broader fix is in `FUTURE.md` § Index-friendly request filters.
- **A book line on Timeline** (Logan's note, 2026-10-28): one line at the top that compares the
  tokens on screen to classic books (*The Great Gatsby*, *Of Mice and Men* and so on), as Claude
  Desktop once did. Only there: not per session, and not on every screen.
- **No cost column on Timeline** (`FUTURE.md`). `cost --by day` leaves out a session that crosses
  midnight, so today would read $0.00 while you're spending. `statusline()`'s comment in
  `query.ts` has the reasoning.
- **Limits stays a tab, with the cycles inside it** (`/ideate`, 2026-10-28). A cycle is a reading
  of the same meter, so there's no separate Blocks tab.
- **Drill-down goes through brief 06's `drill(scope, label)` and `SessionScope`**, both pinned. If
  one doesn't fit, stop and ask.

## Already checked

Checked 2026-10-28 against `main` at `a23ebf7`, on the live archive (93,332 requests from
2026-07-01; 13 models, 365 projects, 5 effort values), read-only, from a scratchpad script inside
Bun.

- **Why `blocks()` is slow.** It runs one totals query per cycle (`query.ts:1238`) through
  `requestWhere` (`query.ts:852`). `requestWhere`'s `($since IS NULL OR ts_ms >= $since)` shape
  stops SQLite from using `requests_ts`: `EXPLAIN QUERY PLAN` says `SCAN requests`. One five-hour
  window took 13 ms that way and 1 ms as a plain `ts_ms >= ? AND ts_ms < ?`.
  - `blocks`: 487 ms at 7 days (33 cycles), 1557 ms at 30 days (111 cycles), 2863 ms all time.
  - On this archive the meter source is `oauth-live`. No desktop samples fall in the last 30
    days.
- **Everything else is already fast enough:**
  - `timeline()`, all time: 95–126 ms for every bucket (day, week, month) and split (none, model,
    project, effort). 90 days by day and model: 97 ms.
  - `limitsHistory`: 12 ms for 30 days hourly, 3 ms for 7 days, 8 ms for 30 days with the auto
    bucket.
  - `currentLimits`: 1 ms.
- **`timeline()` zero-fills every series in every bucket** (`query.ts:946-983`). By project at day
  buckets that's 365 rows a day, nearly all zero, so the table filters out zero rows.
- **`blocks()` filters its local totals by `opts.project` and `opts.model` too**, through
  `requestWhere`. The CLI passes only `since`/`until` (`cli.ts:421`), but the fix must keep the
  other filters' results identical.
- **The current limits are already in every frame.** `useArchive` calls `deps.overview()` on each
  archive change (`useArchive.ts:58`), so `frame.data.limits` is `currentLimits` at that read, and
  `frame.now` ticks. The Limits tab needs no read of its own for the current readings.
- **`limitsLines`** (`overview.tsx:81`) renders the current readings, scoped limits, disagreements
  and sources from `OverviewData`. `meterLines` (`overview.tsx:158`) and `spark` (`text.ts:93`)
  draw the history. `BarChart` (`components.tsx:110`) takes `values`, `width`, `height` and a
  `marker` index, and colours the last bar as the partial one.
- **Drill keys exist for every split.** `SessionScope.by` takes `"project"` and
  `ATTRIBUTION_COLUMNS`' `model` and `effort` (`query.ts:268-275`, `872-876`). A `'(unknown)'`
  series drills with `key: null`, as Breakdown does.
- **Fixture data for the Limits tab.** `freshDb()` (`tests/helpers.ts`) ingests transcripts only,
  with no limit samples. `await backfillDesktopHistory(db, \`${FIXTURES}/plan-usage-history.json\`)`
  adds 1,969 desktop samples. `blocks(db, {})` then gives 196 cycles from `desktop-history`, and 7
  of them have local requests. `fixtures/claude.json` has a `cachedUsageUtilization` for
  `snapshotOauthCache`.
- **The footer must fit 80 columns.** Brief 07 dropped `R fetch` from Breakdown's hints to fit.
  `tools/tui-pty-smoke.py` presses `3` at line 59; the new tabs get a leg each.
- **Book word counts** (web search, 2026-10-28). The sources are mixed, and editions and
  translations differ, so these are only good for an `≈`:
  - *Of Mice and Men*, about 30,000;
  - *The Great Gatsby*, about 47,000;
  - *Moby-Dick*, 206,052–209,117;
  - *War and Peace*, 544,000–587,000 by translation.

  Not checked: how many Claude tokens a word of prose comes to. See Open questions.

## Open questions

Each has the default to use if Logan doesn't answer.

- **Which tokens the book line counts.** Default: output tokens, what Claude wrote, to match the
  bars. Total tokens would compare mostly cache reads, which aren't text anyone wrote or read.
  Help says which it is.
- **Tokens per word.** Default: 1.3 tokens per word. That's a common rule of thumb for English
  under BPE tokenizers, not a figure measured for Claude's tokenizer. Keep it as one named
  constant beside the book list, and the line says `≈`.
- **Which books.** Default: the four above, smallest first. The line names the largest book the
  amount covers at least once, so the multiple stays readable (`≈ 3.2 × The Great Gatsby`).
  Below one *Of Mice and Men* it shows a fraction of that (`≈ 0.4 × Of Mice and Men`); above one
  *War and Peace* it counts multiples of that.
- **Tab order.** Default: Timeline is `4`, Limits is `5`, in the order `FUTURE.md` lists them.
- **Limits at 80×24.** Default: below the full dashboard's 36 rows, Tab switches between **Now**
  (readings, sources, disagreements) and **History** (sparklines and cycles), as Overview's
  compact mode switches panels. At 36 rows and up, both stack, and the cycles table takes the
  rows left over, at least five.
- **Where the cycle drill's caveat goes.** Default: above the cycles table and in Limits' help, as
  "local activity is context, not the cause: the meter also counts claude.ai and the desktop app".
  A drilled list carries only its label, because `drill` is pinned, so the caveat doesn't repeat
  there.

## Shape

### `blocks()` (`src/query.ts`), first

- Replace the per-cycle loop at `query.ts:1238` with one index-friendly read: either a single scan
  of the requests in `[first cycle start, last cycle end)` swept into cycles in JavaScript, or a
  plain-range query per cycle. Pick whichever is simpler at identical output, and measure both if
  it's close.
- The `project` and `model` filters must still apply. If you build SQL for them, add only the
  clauses for filters that are set; never interpolate a value.
- **Output identical, pinned:** every field of `blocks()`' return value deep-equal to the current
  implementation, which is kept inside the test as the oracle (as brief 07 did for
  `groupSessions`).
- `requestWhere`, `reportMeta` and every other caller stay as they are.

### Data (`src/tui/data.ts`)

Two dependencies, each read in one transaction, with a line for each in `tests/tui/helpers.tsx`'s
fake:

- `timeline: (bucket: "day" | "week" | "month", by: "model" | "project" | "effort" | null) =>
  TimelineData`, all time. It calls
  `query.timeline(db, { bucket, by: by ?? undefined, until: now })`, with `now` from `deps.now()`
  (without `until`, `timeline()` reads `Date.now()` itself and the fake clock can't move it), and
  returns `{ buckets: { tsMs, endMs, output, rows }[] }`. A bucket's `rows` are its non-zero
  series, by output tokens descending, and `endMs` is the next bucket's start (the last bucket's
  is the bucket boundary after `until`). The bars and the table both read from this one structure.
  No SQL here.
- `limits: (since: number, bucketMs: number) => LimitsData`: `limitsHistory(db, { since, until:
  now, bucketMs, nowMs: now })` and `blocks(db, { since, until: now })`, with `now` from
  `deps.now()`. The current readings come from `frame.data.limits`, not from here.

### Timeline (`src/tui/timeline.tsx`)

- `useTimelineScreen({ deps, report, height, width, drill })` returns a `ScreenModel` titled
  `Timeline`, with `bucket · split` as its help context. Its state is one committed view in a ref,
  as Breakdown's is.
- **The book line, at the top:** the visible buckets' range, their output tokens, and the book
  comparison, e.g. `2026-09-30 → 2026-10-28 · 1.4M output tokens ≈ 23 × The Great Gatsby`. The
  books and the tokens-per-word constant live in `src/tui/books.ts`, a pure module with a unit
  test: `bookLine(tokens): string`.
- **The chart** is `BarChart` over the visible buckets' output tokens, the newest on the right and
  partial, with the ▲ under the cursor. As many buckets as fit at two columns each. The cursor
  starts on the newest bucket; ←→ (and `h`/`l`) move it, and moving past the left edge scrolls
  the chart back in time. Below it, one line names the cursor's bucket and its output tokens.
- **The table** under the chart is the cursor's bucket: an `all` row first, then one row per
  series when split. Columns: series, output, total tokens, requests, and cache-read share,
  `cache_read / (input + cache_creation + cache_read)`. ↑↓ move through it, with pages from the
  rows left.
- **Keys:**
  - `b` cycles day, week, month, starting at day. The cursor keeps the bucket that contains its
    old start.
  - `g` cycles none, model, project, effort. The table's selection keeps its key, else falls back
    to `all`.
  - Enter drills: `drill({ since: tsMs, until: endMs }, "<bucket label>")` on `all`, and with
    `by` and `key` added on a series (`"<bucket label> · <split> <key>"`). Bucket labels are
    `2026-10-21 UTC`, `week of 2026-10-19 UTC` and `2026-10 UTC`.
- **Reads** are cached per bucket and split until the next `reload`, as Breakdown's are.
  `reload` rereads the current one and keeps the cursor's bucket start and the table's key.
- **Help:**
  - the keys;
  - that bars are output tokens and the last bucket is partial;
  - that buckets are UTC days, Monday weeks and calendar months;
  - that there's no cost here, and why, in one line;
  - how the book line is worked out: which tokens, the ratio, and that it's approximate;
  - that Enter lists the sessions with at least one request in the bucket (and series), with
    whole-session totals.

### Limits (`src/tui/limits.tsx`)

- `useLimitsScreen({ deps, report, height, width, drill })` returns a `ScreenModel` titled
  `Limits`, with the zoom as its help context.
- **Now** (from `frame.data.limits`, with ages from `frame.now`):
  - the scoped limits, with the binding one marked;
  - each meter with its source, age and reset;
  - the archived sources table, one row per source with its age, five-hour and seven-day
    figures, and glaze marked not reconciled, as `cusage limits` prints it;
  - current disagreements.

  Reuse `limitsLines` where it fits, or factor a shared helper out of `overview.tsx`; don't keep
  two copies. Every figure carries its source and age, and a stale one is marked as Overview
  marks it.
- **History:** the sparklines for seven_day, five_hour and the scoped model, as `meterLines`
  draws them, over the zoom. ←→ (and `h`/`l`) cycle 72 hours, 7 days and 30 days, starting at
  72 hours. The bucket is `chooseBucket(span, chartWidth)` from `query.ts`, except 72 hours,
  which stays hourly to match Overview. The header names the bucket, the sources and the sample
  count.
- **Cycles:** `blocks()` over the zoom, newest first, gaps shown as gap rows. Each row has its
  start (UTC), duration, peak with time to peak, reset (`confirmed` when OAuth confirmed it,
  otherwise the bracket), and local requests and output tokens. Above the table:
  - the meter source, and how many samples from other sources were set aside;
  - the caveat about local activity (Open questions).
- **Keys:** ↑↓, `j`/`k`, PageUp/PageDown, Home/End move through the cycles, and Enter drills
  `drill({ since: startMs, until: endMs }, "five-hour cycle <start UTC>")`. Enter on a gap does
  nothing.
- **Reload** rereads history and cycles for the zoom, keeping the selected cycle by `startMs`.
  The shell already calls it on each archive change while the tab shows, which is the five-second
  poll.
- **Help:**
  - the keys;
  - the history marks: peaks not means, `·` for no sample, gaps never bridged, historical peaks
    aren't current readings;
  - how a cycle is found: a drop of at least 5 points and 50% between samples of one source,
    confirmed by an OAuth reset time when one matches, with quiet resets possibly missed;
  - the local-activity caveat.

### The shell (`src/tui/screen.ts`, `src/tui/App.tsx`)

Three edits per tab: the module, a row in `TABS` (`{ id: "timeline", key: "4" }`,
`{ id: "limits", key: "5" }`), and one hook call in `App`, given `drill`. If anything else in the
shell has to change, the report says what and why.

## Out of scope

- `requestWhere` and every report other than `blocks()`. The broader index fix is in `FUTURE.md`.
- Cost on Timeline, and any change to `cost`.
- Overview's panels, including its Limits and Daily output. Moving `limitsLines` to a shared
  helper is fine if Overview renders the same.
- CLI output. `blocks`, `timeline` and `limitsHistory` return what they return now.
- `drill`, `SessionScope` and the drilled Sessions list.
- The book line anywhere but Timeline.
- Mouse support, and the tabs parked in `FUTURE.md`.

## Build order

1. `blocks()` with its oracle test, and the live timing. Commit.
2. The data dependencies and their fakes.
3. Limits: the screen, tests, the PTY leg.
4. Timeline and `books.ts`: the screen, tests, the PTY leg.
5. Docs, `make build`, the smoke test, `make install`. Then the report.

A commit per step is fine. No stop for review between steps.

## Acceptance

- `bun test`: all pass, with new tests on the fixture:
  - **`blocks()` parity.** Deep-equal against the old implementation kept in the test, on the
    fixture with desktop history backfilled. Cover no options, `since`, `since` + `until`, a
    `since` inside a cycle, `project`, `model`, and all of them together. Assert that each filter
    changes the result. A mutation that ends a cycle's local range at `endMs + 1` must fail it.
  - **The tabs.** `4` and `5` show them, with their titles in the tab bar and help. An archive
    change while one is off screen doesn't call its read, and showing it then reads once.
  - **Timeline:**
    - `b` and `g` cycle, and the bars equal `timeline()`'s output tokens for the visible
      buckets.
    - The table's rows are the cursor's bucket's non-zero series, and `all` equals the bucket's
      total.
    - Cache-read share matches the formula on one fixture bucket.
    - The cursor keeps its bucket across `r`, and across `b` round trips where the bucket still
      contains it.
    - Enter on `all` drills `{ since, until }`; on a series, adds `by` and `key`; on
      `(unknown)`, `key: null`. Each lists exactly `sessionPage({ scope })`'s sessions, and Esc
      comes back to the same bucket and row.
    - `bookLine`: each threshold picks the right book, a fraction below the smallest, and
      multiples above the largest.
  - **Limits:**
    - Now shows each meter's source and age from `frame.data.limits`, all sources, and a
      disagreement when two current sources differ by more than 2 points (an in-memory archive,
      as `tests/limits.test.ts` builds them).
    - ←→ cycles the zooms, and the cycles equal `blocks()` for each `since`.
    - Enter on a cycle with local requests drills `{ since: startMs, until: endMs }` and lists
      `sessionPage({ scope })`'s sessions; Enter on a gap does nothing.
    - The selection is kept by `startMs` across `r`.
  - **Chunks.** `"\x1b[B\r"` drills the second row on both tabs.
- `bun run typecheck`: clean.
- **Live timing**, read-only, from a scratchpad script, for the report:
  - `blocks` at 7 days, 30 days and all time, before and after;
  - the Limits read at each zoom, and the Timeline read for each bucket and split.

  Each should be under 300 ms (Breakdown's line). `blocks` at 30 days should be well under it. A
  live parity run of the new `blocks` against the old for 7 days, 30 days and all time must be
  identical as JSON.
- Footer hints for both tabs fit 80 columns.
- `make build`, then `python3 tools/tui-pty-smoke.py <db>` on a scrubbed fixture archive in the
  scratchpad: PASS for the source and `dist/cusage-tui`, with a leg for each new tab (show it,
  change bucket or zoom, drill, Esc back). Then `make install`, and `cusage doctor`: `build ok`.
- Docs:
  - [the TUI page](../architecture/tui.md): the file table (`timeline.tsx`, `limits.tsx`,
    `books.ts`), Screens' hook list and call order, Pushing, and a section for each tab;
  - [the limits page](../architecture/limits.md): `blocks`' local totals, if how they're read is
    worth a sentence;
  - [the explorer guide](../guide/explorer.md): screens 4 and 5, their keys, the book line and
    what it counts;
  - [the over-time guide](../guide/over-time.md) and [the limits guide](../guide/limits.md): one
    line each pointing at the tab;
  - the root README's explorer line;
  - [`FUTURE.md`](FUTURE.md): Further TUI tabs lists Timeline and Limits as built.
- Logan, by hand in kitty with the installed `cusage-tui`:
  - **Timeline.** `4`, then `b` to month and back. Does the shape match what you remember? Pick a
    spike, `g` to model, Enter on the top series. Are those the sessions behind it?
  - **The book line.** Does the comparison read well, and are these the books you want?
  - **Limits.** `5`, leave it open while you work for a while. Do ages tick, and does a new
    reading show up without a key? Zoom to 30 days: are the cycles plausible next to the
    sparkline?
  - **Kill criteria** (`FUTURE.md`): would you leave the explorer on Limits rather than Overview?
    Does Timeline tell you anything Daily output and its day drill didn't? Either answer goes in
    the report's follow-ups, not a revert.

Then stop. Write the report, and ask Logan before merging anything.
