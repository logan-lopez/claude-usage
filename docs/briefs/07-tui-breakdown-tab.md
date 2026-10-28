# Brief 07: The Breakdown tab

**Size:** M

Read `CLAUDE.md`, [`README.md`](README.md), [the TUI page](../architecture/tui.md), [the cost
page](../architecture/cost.md) (grouped cost), [the sessions guide page](../guide/sessions.md)
(grouping and attribution as the CLI does them) and [`FUTURE.md`](FUTURE.md) § Further TUI tabs
first. Brief 06 ([`06-tui-tab-groundwork.md`](06-tui-tab-groundwork.md)) must have landed, and
its report says whether tool attribution got fast.

## Goal

"Where did the tokens go" is a grouping question, and the explorer can't answer it: Sessions is
flat, and Detail shows attribution for one session only. Breakdown is tab 3:

- one table of groups for a dimension (project, model, skill, agent, MCP server, plugin, tool,
  effort, entrypoint, branch, Claude Code version) over a window;
- ←→ to change the dimension, `w` to change the window;
- Enter on a group drills to its sessions through brief 06's `drill`.

It's the first tab on the brief 05 screen model, so it also proves the "three edits" rule.

## Decisions already made

Decided with Logan, 2026-10-28, from an `/ideate` run. Don't revisit them silently.

- **Breakdown replaces "Grouped session views in the TUI"** in `FUTURE.md`, which proposed a
  grouping toggle on Sessions. Sessions stays a flat list.
- **Grouped cost is exact or absent** (README decisions table). A session's cost counts toward a
  group only when all its requests are in that group and inside the window. Otherwise the
  session's requests count, its cost is left out, and the amount is marked `+`. Never split or
  repeat a session's cost.
- **Attribution dimensions carry no cost.** `attribution()` returns none, and inventing one per
  skill or tool would be the per-tool allocation the TUI page rules out.
- **Tool rows overlap.** A request that used several tools counts under each, so tool rows don't
  add up to the total. The tab says so, as the CLI does.
- **Timeline and Limits are not part of this.** They stay in `FUTURE.md`.

## Already checked

Checked 2026-10-28 against `main` at `a518d01`. Brief 06 may have changed the line numbers.

- **Two query families feed the dimensions:**
  - `groupSessions(db, by, opts)` (`query.ts:326-357`) covers `project`, `model`, `entrypoint`
    and `branch`. It returns `GroupRow`: tokens, `requests`, `sessions`, `cost_usd`,
    `sessions_split`, `sessions_unpriced` and `cost_complete`. Its keys are request columns, and
    a NULL becomes `'(unknown)'`. Its cost is measured only (`MEASURED_COST`).
  - `attribution(db, by, opts)` (`query.ts:832-871`) covers `skill`, `agent`, `plugin`, `mcp`,
    `effort`, `version` and `tool`. It returns `BreakdownRow` (tokens and `requests`; `calls` for
    tool), plus `coverage` and `note`, and it leaves NULL keys out.
  - `sessionGroupsReport` wraps `groupSessions` with the same `coverage` shape.
- **Timings on the live archive**, inside Bun:
  - `groupSessions(db, "project")`, all time: 340 ms. It runs three queries per session in the
    window (`query.ts:340-345`).
  - `attribution(db, "skill")`: 62 ms.
  - `attribution(db, "tool")`: 2615 ms before brief 06.
- **The CLI's grouped `+` means something different from the session `+`.** On a grouped row it
  means sessions were left out: split across groups, or with no cost record. `COST_MARKS`
  (`help.tsx:7-10`) describes the session marks, so Breakdown needs its own line.
- **`costLabel`** (`text.ts:83-86`) formats a session's `CostRow`, not a `GroupRow`.
- **`TuiDependencies`** (`data.ts:94-107`) is faked in `tests/tui/helpers.tsx:35-45`. A new
  dependency needs a line in both.

## Open questions

Each has the default to use if Logan doesn't answer.

- **The windows.** Default: `w` cycles 30 days, 7 days and all time, starting at 30 days. Days
  run back from now, matching Sessions' Activity.
- **The tool dimension if brief 06 didn't get it fast.** Default: if its report shows
  `attribution(db, "tool")` above 300 ms all-time, leave tool out of the dimensions, and say in
  Breakdown's help that `cusage attribution --by tool` has it.
- **`groupSessions`' speed.** Default: if `groupSessions` takes over 300 ms on the live archive
  for the 30-day window, rewrite its per-session loop as set-based SQL, deep-equal against an
  oracle that keeps the current code inside the test. Otherwise leave it alone.

## Shape

### Data (`src/tui/data.ts`)

- Add one dependency:
  `breakdown: (by: BreakdownDimension, opts: RequestFilters) => BreakdownData`.
  - It calls `sessionGroupsReport` for project, model, entrypoint and branch, and `attribution`
    for the rest.
  - It returns one shape: `{ rows, coverage, overlapping, note, priced: boolean }`.
- No SQL aggregation here; that stays in `query.ts`.

### The screen (`src/tui/breakdown.tsx`)

- `useBreakdownScreen({ deps, report, height, drill })` returns a `ScreenModel` titled
  `Breakdown`.
- **State**, kept in a ref and committed as one view, as Sessions does:
  - the dimension and the window;
  - per dimension, the selection by group key and the scroll.
- **`reload`** reruns the current read and keeps the selection by key. Brief 06 runs it only while
  the tab is showing, or just before it's shown.
- **Rows** are sorted by total tokens, descending, as the queries return them. The columns are:
  - group, requests, total tokens, output tokens, and share of the window's total tokens;
  - sessions and cost, for the four `groupSessions` dimensions;
  - calls, for tool.
  - Cost shows `$x.xx`, with `+` when `cost_complete` is false. It's a measured amount, never an
    estimate.
- **Above the table**: the dimension and window (`skill · last 30 days`), and the coverage line
  (`attributed 61.2% of 12.4K requests`). Below it, the tool note when `overlapping`.
- **Keys:**
  - ←→ (and `h`/`l`) change the dimension;
  - ↑↓, `j`/`k`, PageUp/PageDown and Home/End move through the groups, with pages from
    `tableBodyRows`;
  - `w` changes the window;
  - Enter drills.
- **Drilling** calls
  `drill({ since: windowSince, by: dimension, key }, "<dimension> <key> · <window>")`.
  - A `'(unknown)'` group drills with `key: null`.
  - For `branch` and `entrypoint`, the drill's `by` is the same name in `ATTRIBUTION_COLUMNS`.
- **Help** explains:
  - the keys;
  - that tokens are counted per request, and a session's cost only when the whole session sits in
    one group and inside the window;
  - the grouped `+` mark (some sessions' cost was left out because they span groups or have no
    cost record);
  - for tool, that rows overlap and their tokens are context, not per-tool consumption;
  - that Enter lists the sessions with at least one request in the group, with whole-session
    totals.

### The shell (`src/tui/screen.ts`, `src/tui/App.tsx`)

- A row in `TABS`: `{ id: "breakdown", key: "3" }`.
- One hook call in `App`, added to the record, given `drill`.
- That's the "three edits" rule. If anything else in the shell has to change, the report says what
  and why.

## Out of scope

- Timeline, Limits and every other tab.
- Cost for attribution dimensions, and any per-tool token allocation.
- Changes to Sessions beyond what `drill` already does.
- CLI output. `attribution` and `sessionGroupsReport` must return what they return now, so if
  `groupSessions` is rewritten, its output stays deep-equal.
- Brief 06's `SessionScope` and `drill` interfaces, which are pinned. If one doesn't fit, stop and
  ask.

## Acceptance

- `bun test`: all pass, with new tests on the fixture for:
  - **The tab.** `3` shows Breakdown. Its title is in the tab bar and help. A `data_version`
    change while it's off screen doesn't call its read. Showing it then reads once.
  - **The table.** Each dimension renders its rows in token order:
    - project and model have sessions and cost columns;
    - a split session's cost is excluded and its row marked `+`, against `groupSessions` for the
      same window;
    - tool shows calls and the overlap note (unless tool is dropped, per Open questions).
  - **The window.** `w` cycles the windows, and the rows match the query for each `since`.
  - **The selection.** It's kept by key across a reload and across a dimension round trip.
  - **Drilling.**
    - Enter on a skill group lists exactly the sessions `sessionPage({ scope })` returns for that
      skill and window, with whole-session totals.
    - Esc returns to Breakdown on the same row.
    - `'(unknown)'` drills with `key: null`.
  - **Chunks.** `"\x1b[B\r"` drills into the second row, not the first.
  - If `groupSessions` was rewritten: deep-equal against the oracle for every `by`, with and
    without `since`.
- `bun run typecheck`: clean.
- A timing on the live archive, read-only, from a scratchpad script, for each dimension at 30 days
  and all time. It goes in the report. No test reads live data.
- `make build`, then `python3 tools/tui-pty-smoke.py <db>`: PASS. Then `make install` and
  `cusage doctor`: `build ok`.
- Docs:
  - [the TUI page](../architecture/tui.md): the file table, and Breakdown in Screens;
  - [the explorer guide](../guide/explorer.md): screen 3, its keys, and what `+` means there;
  - the root README's feature list, if it lists the explorer's screens;
  - [`FUTURE.md`](FUTURE.md): Further TUI tabs now lists Breakdown as built.
- Logan, by hand in kitty with the installed `cusage-tui`:
  - Tab 3, skill, then project, at 30 days and all time. Do the top groups match what you'd
    expect?
  - Is ←→ between dimensions quick enough (no pause you notice)?
  - Enter on a project. Are those its sessions?
  - Does the `+` on a project's cost read clearly next to help's explanation?

Then stop. Write the report, and ask Logan before merging anything.

## Report

Built 2026-10-28 on `main`: `0566329` (code, tests and docs), then this report.

### Built

- **`groupSessions` without the per-session loop** (`src/query.ts`). The totals query is
  unchanged, since it fixes the row order the CLI prints. The memberships query and the three
  queries per session became one statement: each (session, group) pair in the selection with the
  session's lifetime request and group counts, how many of its requests the filters kept, and its
  `MEASURED_COST` through a subquery, so the rule still holds. `exactSessionCost` still makes the
  decision.
- **The dependency** (`src/tui/data.ts`). `BREAKDOWN_DIMENSIONS` in ←→ order, `readBreakdown`
  and `breakdown(by, { since })`, run in one read transaction. Grouped dimensions go through
  `sessionGroupsReport`, the rest through `attribution`. It returns
  `{ rows, coverage, tokens, overlapping, note, priced }`.
- **The screen** (`src/tui/breakdown.tsx`). `useBreakdownScreen({ deps, report, height, drill })`,
  titled `Breakdown`, with the dimension as its help context (`Breakdown · skill help`).
  - State is one committed view in a ref: dimension, window, the `since` it read with, the data,
    and each dimension's place (selection by key, plus scroll).
  - Reads are cached by dimension and window until the next `reload`, so ←→ back to a
    dimension doesn't requery.
  - Above the table, `skill · last 30 days · 5 groups`, and the coverage line with the window's
    token total. Below it, one note row: the tool overlap note, the meaning of `+` for the grouped
    dimensions, or "no cost by skill" for the rest.
  - The name column is as wide as the longest key, so the numbers sit beside the names at 120
    columns.
  - `lll`, `hhh` and `ww` that arrive as one chunk count each key.
- **The shell**: a row in `TABS` and one hook call in `App`, given `drill`, plus its import.
  Nothing else changed in the shell, so the three-edit rule held.
- **`tools/tui-pty-smoke.py`** now shows tab 3, switches to all time, drills, and comes back, for
  both the source and the compiled binary.

### Deviations

- **`breakdown` takes `{ since }`, not `RequestFilters`.** The share column needs the window's
  total tokens, and `attribution` doesn't return them, because its rows leave out unattributed
  requests and tool rows overlap. `corpusTotals` gives them, but it filters on `since` alone.
  Taking the full filter type would have let a caller pass `project` and get a wrong share.
  Breakdown has only the window, so the narrower type is honest.
- **`BreakdownData` has a `tokens` field** beside the brief's five, for that share. For the
  grouped dimensions it's the rows' sum, since they partition the window (the existing
  partition test pins that). That saves a scan, about 30 ms.
- **Reads are cached per dimension and window until `reload`.** The brief didn't ask for it.
  It costs one `Map`, and it makes ←→ round trips instant where project would otherwise reread
  in about 250 ms.
- **The PTY smoke switches to all time before drilling.** Against a fixture archive and the real
  clock, the fixture is older than 30 days, so the 30-day window is correctly empty.
- **The footer leaves out `R fetch`** so the hints fit 80 columns: `↑↓ group · ←→ dimension ·
  w window · Enter sessions · r reread · ? help · q quit`. `R` still works, and help lists it.

### Defaults taken

- **Windows:** `w` cycles 30 days, 7 days and all time, starting at 30 days, counted back from
  now.
- **Tool:** kept. Brief 06 measured `attribution(db, "tool")` at about 200 ms all time, and this
  session measured 218–229 ms, under the 300 ms line.
- **`groupSessions`:** rewritten. It took 312–341 ms for project at 30 days, over the line.

### Acceptance

- `bun test`: 174 pass, 0 fail across 20 files (165 before). New tests:
  - `tests/query.test.ts`: `groupSessions` deep-equal, and equal as JSON, against the old loop
    kept in the test. It covers every `by` with no filter, `since`, `until`, a `since` inside a
    session, `project`, `model` and all of them together, and the flagged-cost archive. Each
    filter is asserted to change the rows, and a partly selected session is asserted to show up
    as split. A mutation that drops the partial-selection check fails it.
  - `tests/tui/breakdown.test.tsx`:
    - **The tab.** `3` shows it, in the tab bar and help. A change while it's off screen doesn't
      read it, and showing it reads once.
    - **The table.** All 11 dimensions match `readBreakdown`'s keys in token order. Sessions and
      Cost columns appear exactly for the grouped dimensions, Calls and the overlap note exactly
      for tool. A split project shows `$x.xx+` equal to `groupSessions`' `cost_usd` for the same
      window, and a whole one shows no `+`.
    - **The window.** `w` cycles the three windows, with the clock moved so they differ, and the
      rows match the query for each `since`. A chunked `ww` counts twice.
    - **The selection.** It's kept by key across `r` after the order changes, and across a
      model round trip, which doesn't reread.
    - **Drilling.** Enter on a skill passes `{ since, by: "skill", key }`, lists
      `sessionPage({ scope })`'s total, and shows whole-session totals. Esc returns to the same
      row. `(unknown)` on entrypoint drills with `key: null`.
    - **Chunks.** `"\x1b[B\r"` at 80×24 drills into the second row.
    - Mutations that drill `(unknown)` with its literal key, or keep the selection by index, each
      fail their test.
  - `tests/tui/shell.test.tsx`: the help test now expects three tabs and covers Breakdown's help.
- `bun run typecheck`: clean.
- **Live timing**, read-only, from a scratchpad script, through the real `breakdown` dependency
  on 93,179 requests. Three runs each, in ms:

  | | 30 days | 7 days | all time |
  | --- | --- | --- | --- |
  | project | 252/248/250 | 184/190/189 | 271/285/618 |
  | model | 236/243/241 | 175/175/176 | 257/253/253 |
  | entrypoint | 220/218/216 | 141/145/149 | 244/243/240 |
  | branch | 212/214/214 | 145/143/141 | 251/255/264 |
  | skill | 87/85/86 | 71/74/73 | 86/86/88 |
  | agent | 52/52/53 | 42/43/42 | 56/56/56 |
  | mcp | 46/47/46 | 38/37/37 | 48/48/47 |
  | plugin | 44/43/44 | 35/34/34 | 46/45/46 |
  | tool | 229/225/236 | 150/147/149 | 263/241/251 |
  | effort | 90/90/93 | 65/64/63 | 99/99/97 |
  | version | 91/93/93 | 64/64/62 | 99/100/102 |

  The 618 is a single outlier; the other two runs were 271 and 285. Before the rewrite,
  `sessionGroupsReport` alone took 312–355 ms for project.
- **Live parity**, read-only: the new `sessionGroupsReport` against the previous `query.ts`, for
  each of the four groupings with no filter, 30 days, 7 days, `model`, and `since` + `until` +
  `project`. All 20 are identical as JSON.
- `make build`, then `python3 tools/tui-pty-smoke.py` on a fixture archive built in the
  scratchpad: PASS for `bun src/tui.ts` and for `dist/cusage-tui`, with the new Breakdown leg.
- `make install`, then `cusage doctor`: `build ok` at `0566329`. This report's commit is
  docs-only.
- Docs: listed below.

### Size

Sized M, this session M (15 active min, 15 wall, 0 compactions), before the report.

### Spot checks for Logan

In kitty with the installed `cusage-tui`:

- Press `3`, then go through skill and project, at 30 days and all time (`w`). Do the top groups
  match what you'd expect?
- Is ←→ between dimensions quick enough? A first visit to project or model reads in about
  250 ms; a revisit is cached.
- Press Enter on a project. Are those its sessions?
- The `+` on project's cost: on the live archive none of the top ten projects or models at 30
  days or all time is complete, and two of the top ten read `$0.00+`. That is exact-or-absent
  doing its job (worktrees and sub-agents put one session in several projects), but it means `+`
  tells you little row by row. Does the note under the table plus `?` make that read clearly, or
  does the column need rethinking? Rethinking it would mean revisiting the decision, not tweaking
  the label.

### Docs updated

- [The TUI page](../architecture/tui.md): the intro, the file table, Screens (the hook list and
  call order), Pushing (Breakdown as a caller), and a new Breakdown section.
- [The cost page](../architecture/cost.md): how `groupSessions` reads memberships now, and its
  parity oracle.
- [The explorer guide](../guide/explorer.md): the intro, screen 3, a group's sessions, what `+`
  means there, the tab bar and digit keys, the keys table (`3`, ←→, `w`, Enter). Its `Covers:`
  line now names the cost page too.
- The root README's explorer line.
- [`FUTURE.md`](FUTURE.md): Further TUI tabs lists 06 and 07 as built. "Grouped session views in
  the TUI" is removed, as that section asked once 07 landed.

### Follow-ups

- The live `+` density above. If `+` on nearly every row turns out to carry no signal, an
  "excluded sessions" count beside the cost (as `cost --by` prints) would say how much is
  missing without breaking exact-or-absent.
- At 80 columns a drilled list's title runs past the tab bar (`▸ Sessions · tool Agent · last…`),
  and its second filter row and footer were already cut off before this brief (brief 06's
  follow-up). Breakdown's labels are longer than a day's, so it shows more often.
- `corpusTotals` filters on `since` only. If Breakdown ever takes project or model filters, the
  share's denominator needs a filtered total from `query.ts`.
