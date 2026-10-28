# Brief 06: Groundwork for new TUI tabs

**Size:** M. Three pieces (reload what's shown, a fast tool-attribution query, drill-down), each
small, in the shell, `query.ts` and Sessions.

Read `CLAUDE.md`, [`README.md`](README.md), [the TUI page](../architecture/tui.md), [the CLI
page](../architecture/cli.md) (for `query.ts`), [the explorer guide page](../guide/explorer.md),
and brief 05's report ([`05-tui-cleanup-pass.md`](05-tui-cleanup-pass.md) § Report, Follow-ups)
first. Brief 05 must have landed: `a518d01` in the current branch's history.

## Goal

New tabs are coming next (Breakdown in brief 07; Timeline and Limits in
[`FUTURE.md`](FUTURE.md#further-tui-tabs)), and they sit on aggregate queries over the whole
archive. Two things in the shell stop them now, and one thing makes them worth having:

- **Every `reload` runs after every archive change, shown or not.** `bun:sqlite` is synchronous,
  so a slow query hidden on another tab freezes the screen you're on. The worst current one,
  `attribution(db, "tool")`, takes 2.6 s on the live archive.
- **There's no way to go from an aggregate to its sessions.** Detail is the only pushed screen,
  and Sessions can't be filtered to "sessions active on this day" or "sessions that used this
  skill". Without that, a tab is just its CLI table with arrow keys, which is FUTURE.md's kill
  criterion for tabs.

This brief delivers three things:

- The shell reloads only the screen that's showing and marks the rest stale.
- `attribution(db, "tool")` gets fast with identical output.
- A drill-down stack with a second Sessions instance, and one real place to use it: Overview's
  Daily output panel. Enter on a day opens that UTC day's sessions.

## Decisions already made

Decided with Logan, 2026-10-28, from an `/ideate` run. Don't revisit them silently.

- **Reload what's shown, mark the rest stale.** After an archive change, the shell calls `reload`
  only on the screen that's showing and marks every other screen stale. Showing a stale screen
  reloads it first. The shell still owns the loop, so a new tab still can't forget to register.
  This replaces "the shell calls every `reload`" in the README's decisions table (row "TUI
  screens"), which this brief rewords.
- **Ideas 1 and 2 of the ideate run are one brief.** LAYOUT's rule is that two S or M pieces
  share one.
- **The Breakdown tab (brief 07) replaces the grouping toggle on Sessions** that FUTURE.md
  proposed. Sessions stays a flat list. This brief adds no grouping.
- **These rules from the TUI page stay as they are:**
  - keys go through `useKeys` in a layout effect;
  - handlers read the last committed state from refs, never their render's props;
  - the shell clears `keys.current` when it changes screen;
  - inputs and overlays own the keyboard, and Ctrl+C always quits;
  - Detail is pushed, not a tab;
  - amounts are whole-session totals.

## Already checked

Checked 2026-10-28 against `main` at `a518d01`.

- **Baseline.** `bun test` gives 157 pass and 0 fail across 19 files; `bun run typecheck` is
  clean.
- **Timings on the live archive** (93.0K requests, 102.7K tool calls, 1,990 sessions), timed
  inside Bun with `performance.now()`. Bun's SQLite is 3.54.0.

  | Query | Time |
  | --- | --- |
  | `attribution(db, "tool")`, all time | 2615 ms |
  | its tokens pass alone, `DISTINCT` over the join with only `total_tokens` | 220 ms |
  | its calls pass alone, the correlated `EXISTS` (`query.ts:850-853`) | 919 ms |
  | `attribution(db, "skill")` | 62 ms |
  | `groupSessions(db, "project")`, all time | 340 ms |
  | `blocks()`, 30d | 1572 ms |
  | `blocks()`, 7d | 452 ms |
  | `timeline(db, { bucket: "day" })`, all time | 98 ms |

  The CLI's wall times agree: `cusage attribution --by tool --since all --json` took 2.61 s and
  `--since 30d` 1.66 s.
- **A narrower dedup gives the same tool totals.** On the live archive, with the sqlite3 CLI
  3.50.6, both of these returned the same `(key, COUNT(*), SUM(total_tokens))` rows (same md5):
  - `SELECT DISTINCT tool_name, session_id, message_id FROM tool_calls`, joined to `requests` on
    `(session_id, message_id)`;
  - the current `DISTINCT` over the join, on the request's full primary key.

  That's expected, since `requests`' key is `(message_id, request_id, session_id)` and every
  token column depends on it. It's still only checked for `total_tokens` and without filters, so
  the parity test below is what counts.
- **`sessionPage`'s time filter is on `s.last_ts_ms`** (`query.ts:265-266`). `since` alone means
  "last active after since", which is right for Activity. A `[since, until)` range would find
  sessions that *ended* in it, not ones active in it. Drill-down needs the second.
- **`sessionPage`'s project filter is a case-insensitive substring of the session's own project**
  (`s.project`). `groupSessions` and `attribution` key on each *request's* column. A drill on
  project `foo` with today's filter would also match `foobar`, and would miss a session whose
  `s.project` differs from some of its requests' projects. Drill-down needs exact matches on
  the request column.
- **`sessionPage` is used only by the TUI** (`src/tui/data.ts:69,117`). The CLI's `sessions` uses
  `listSessions`, so changing `sessionPage`'s options doesn't touch CLI output.
- **The first read runs every `reload`** (`useArchive.ts`: `reread()` ends in
  `latest.current.onReload()`), and so does the hourly tick in the poll. That's how Sessions gets
  its first page today. With stale-marking, Sessions gets its first page when it's first shown.
- **The shell's screen state** is `screen` and `origin` (`App.tsx:65-66`). `open` pushes Detail
  and Detail's `back` returns to `origin` (`App.tsx:84-89`). Digit keys switch tabs from anywhere,
  Detail included.
- **Overview's Daily output panel has no selection.** It draws a `BarChart` of
  `data.daily[].output_tokens` over 30 UTC days (`overview.tsx:322-335`), and `PANEL_KEYS` gives
  it no keys (`overview.tsx:50-56`).
- **The fixture has 443 tool calls** (`fixtures/BASELINE.json`). `tests/reports.test.ts:26-33`
  checks that tool attribution's calls add up to the `tool_calls` count.

## Open questions

Each has the default to use if Logan doesn't answer.

- **The first drill-down caller.** Default: Overview's Daily output panel. ←→ choose a day there
  (a marker under its bar, and the panel's caption names the day and its output tokens), and
  Enter drills to that day. The alternative is a test-only harness, which would leave nothing to
  press until brief 07.
- **The drilled Sessions' title.** Default: `Sessions · <label>`, where the caller passes the
  label, e.g. `Sessions · 2026-10-21 UTC`.
- **Whether `f` can edit the filters on a drilled Sessions.** Default: yes. Search, project,
  model, activity and sort apply on top of the drill scope, which can't be removed except with
  Esc.

## Shape

### Reload what's shown (`src/tui/App.tsx`)

- Keep the models as a `Record<ScreenId, ScreenModel>` ref, not an array, plus a `stale` set of
  `ScreenId`s in a ref.
- When the archive changes, call `reload` on the screen that's showing, and add every other screen
  id to `stale`.
- Showing a screen (`show`, a pop, a digit key) first calls its `reload` if it's in `stale`, and
  removes it from `stale`.
- The first read and the hourly tick go through the same path, so on startup only Overview loads.
- **Pinned:** a screen's `reload` runs only while the screen is showing, or just before it's shown.
  Brief 07's tab relies on this to keep its query off other screens.

### Tool attribution (`src/query.ts`)

- Rewrite `attribution(db, "tool", opts)` so it returns the same object, deep-equal, for every
  filter combination: no filters, `since`, `until`, `project`, `model`, and `limit`.
  - Dedup `(tool_name, session_id, message_id)` from `tool_calls` first, then join `requests` and
    apply `requestWhere`.
  - Count calls against a `DISTINCT` set of the filtered requests' `(session_id, message_id)`,
    not a correlated `EXISTS` per call.
  - Compute `attributed` from the same filtered set if you can.
- Keep the comment's reasoning: a request is counted once per tool it used, and calls are counted
  separately.
- Target: under 300 ms all-time on the live archive, timed as in Already checked. If it won't get
  there, report the best time and stop on this piece; brief 07 has a fallback.
- **Leave `blocks()` alone.** Its 1.5 s matters only to a future Limits tab (`FUTURE.md`).

### Drill-down: the query (`src/query.ts`)

Add a scope to `sessionPage`. **Pinned** (brief 07 builds on it):

```ts
/** Sessions with at least one request matching every field set here; totals stay whole-session. */
export interface SessionScope {
  /** A request at or after this time, and before `until`. */
  since?: number | null;
  until?: number | null;
  /** A request whose `by` value is exactly `key`; `key: null` means the column is NULL. */
  by?: AttributionDimension | "project";
  key?: string | null;
}
export interface SessionPageOptions extends RequestFilters {
  search?: string; sort?: SessionSort; offset?: number; pageSize?: number;
  scope?: SessionScope;
}
```

- One `EXISTS (SELECT 1 FROM requests r WHERE r.session_id = s.session_id AND …)` holds the time
  range and the key, so the *same* request satisfies both. That matches what a group row in
  `attribution(by, { since, until })` counted.
- For `by: "tool"`, the request must have a `tool_calls` row with `tool_name = key`.
- Take column names from `ATTRIBUTION_COLUMNS` plus `project`. They're never interpolated from
  input.
- The existing filters (`since`/`until` on `last_ts_ms`, project and model substrings, search)
  still apply alongside `scope`, unchanged.

### Drill-down: the shell and Sessions (`src/tui/App.tsx`, `src/tui/sessions.tsx`, `src/tui/screen.ts`)

- **A stack.** Replace `screen` and `origin` with a stack whose bottom is a tab:
  `ScreenId = TabId | "drill" | "detail"`.
  - Esc on a pushed screen with no overlay open pops one level.
  - A digit key clears the stack to that tab.
  - The paths are tab → Detail, tab → drill → Detail, and back the same way.
  - Detail opened from a drilled list returns to that list with its selection.
- **Two Sessions instances.** `App` calls `useSessionsScreen` twice, in a fixed order: the tab,
  and a drilled instance. The drilled one starts empty and gets its scope from
  `drill(scope, label)`. Opening a drill never changes the Sessions tab's filters or selection.
- **Pinned:** the shell passes `drill: (scope: SessionScope, label: string) => void` to a tab
  hook that needs it, the way it passes `open` today. Calling it loads the drilled list and
  pushes it. If the read fails, it reports through `report` and pushes nothing, as `open` does.
- **The tab bar** shows the tabs, then each pushed screen's title (`▸ Sessions · 2026-10-21 UTC
  › Detail`).
- **Help** for the drilled instance says what the scope means: sessions with at least one
  matching request, shown with whole-session totals.
- **Chunks.** `drill` and pops go through `show`, so `keys.current` is cleared and the rest of
  the chunk is dropped. Handlers read the day cursor from a ref, as Overview's nav does now.

### The first caller (`src/tui/overview.tsx`)

- **The day cursor.** Daily output gets one, kept in Overview's nav by UTC day start, not by
  index, so a reread at midnight doesn't move it. It starts on today.
- **Keys.** ←→ (and `h`/`l`) move it, and Enter calls
  `drill({ since: day, until: day + DAY }, "<YYYY-MM-DD> UTC")`.
- **Hints.** `PANEL_KEYS` for Daily output becomes `←→ day · Enter sessions · `.
- **Compact mode.** It works the same at 80×24, where the panel is shown alone.

## Out of scope

- New tabs. Breakdown is brief 07; Timeline and Limits stay in `FUTURE.md`.
- `blocks()`, `groupSessions` and every other query's speed.
- Grouping on Sessions.
- Detail's chunked-key follow-up and Sessions' editor-chunk follow-up from brief 05, unless the
  stack change makes one of them trivial. If it does, add a line in the report.
- The CLI. `sessionPage` is TUI-only, and `attribution`'s output must not change.

## Build order

1. Reload what's shown, with its tests. Commit.
2. Tool attribution, with the parity test. Commit.
3. `SessionScope` in `sessionPage`, with fixture tests. Commit.
4. The stack, the drilled Sessions and the Daily output caller, with TUI tests. Commit.
5. Docs: the TUI page (Screens, Browsing state, the reload rule, and "Adding a tab is three
   edits", now naming `drill`), the explorer guide (Overview's Daily output keys, drilled Sessions,
   Esc), the README's decisions row, and the keys table in the guide. Then `make install`. Commit.

## Acceptance

- `bun test`: all pass, with new tests for:
  - **Reload.** After a `data_version` change on Overview, Sessions' and Detail's reloads haven't
    run. Switching to Sessions runs its reload once. A second switch with no change runs none.
    Startup loads Overview only, and Sessions still shows its first page when first shown.
  - **Tool parity.** `attribution(db, "tool", opts)` deep-equals an oracle that keeps the current
    SQL inside the test, on the fixture, for each filter combination in Shape.
  - **`SessionScope`.**
    - A day range finds a session active that day that ended later, which `since`/`until` alone
      miss.
    - `by: "project"` is exact: `foo` doesn't match `foobar`.
    - `by: "skill"` with a range needs one request with both.
    - `by: "tool"` matches through `tool_calls`.
    - `key: null` matches NULL.
    - Totals stay whole-session.
  - **The stack.** Daily output: → then Enter drills to the right day. Esc pops back to Overview,
    with the panel and day cursor kept. Enter in the drilled list opens Detail, and Esc twice gets
    back to Overview. `2` from a drilled list shows the Sessions tab with its own filters intact.
    A drill whose read fails pushes nothing and reports.
  - **Chunks.** `"\x1b[C\r"` in one chunk on Daily output drills to the day after the old cursor,
    not the old one.
- `bun run typecheck`: clean.
- A timing of `attribution(db, "tool")` on the live archive, read-only, from a script in the
  session's scratchpad, recorded in the report before and after. No test reads live data.
- `rg -n "origin" src/tui/App.tsx`: nothing.
- `make build`, then `python3 tools/tui-pty-smoke.py <db>` against a scrubbed fixture archive:
  PASS.
- `make install`, then `cusage doctor`: `build ok` at the final commit.
- Logan, by hand in kitty with the installed `cusage-tui`:
  - On Overview, Tab to Daily output, ←→ over the days, then Enter. Is the drilled list the
    sessions you remember from that day?
  - Esc back. The cursor is where you left it.
  - With an agent sync landing while you're on Overview (or `cusage sync` in another pane), does
    Sessions show the new data when you press `2`?

Then stop. Write the report, and ask Logan before merging anything.
