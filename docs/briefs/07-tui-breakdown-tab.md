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
