# The explorer (TUI)

`cusage-tui` is a separate Ink executable that browses the archive read-only through `query.ts`,
with Overview, Sessions, Breakdown, Timeline and Limits tabs, and a drilled Sessions list and
Session Detail pushed over them.

**Sources:** `src/tui.ts`, `src/tui/`, `patches/`

**History:** [brief 03](../briefs/archive/03-ink-tui-session-explorer.md)

| File | Role |
| --- | --- |
| `src/tui.ts` | The entry: argv, theme detection, render |
| `src/tui/App.tsx` | The shell only: the screen stack, header, tabs, status, key hints, help and global keys, all derived from the screen models |
| `src/tui/screen.ts` | The screen contract: `ScreenModel`, `Frame`, `TABS` and `ScreenId` |
| `src/tui/useArchive.ts` | The archive lifecycle |
| `src/tui/data.ts` | Opening the archive, the query-backed dependencies the screens read through, and the session page cache, which never evicts and is replaced on every filter change or reload |
| `src/tui/overview.tsx`, `sessions.tsx`, `breakdown.tsx`, `timeline.tsx`, `limits.tsx`, `detail.tsx` | Each exports a hook returning its screen's `ScreenModel`, and renders that screen and owns its keys |
| `src/tui/readings.ts` | Pure line builders for limit readings and meter history (`limitsLines`, `meterLines`), shared by Overview and Limits |
| `src/tui/books.ts` | Timeline's book line: the books, `TOKENS_PER_WORD` and `bookLine(tokens)` |
| `src/tui/help.tsx` | The help overlay the shell draws over any screen |
| `src/tui/keys.ts` | Key routing (`useKeys`) and `movement()` |
| `src/tui/layout.ts` | The row budget: minimum size, chrome rows, and how a viewport's height becomes a page |
| `src/tui/text.ts` | Pure width, wrap and label helpers |
| `src/tui/theme.ts` | The palettes, contrast checks and background detection |
| `src/tui/components.tsx` | Shared pieces |

## How it works

**Opening.** The TUI opens an existing current-schema archive read-only and never creates or
migrates one. A missing or incompatible archive gets a message pointing at `cusage sync`.

- A read-only SQLite handle can't create a WAL archive's `-wal`/`-shm` files, so a copied or
  restored archive would fail on first read.
- In that case `openArchive` falls back to a read-write handle with `PRAGMA query_only=ON`, which
  still refuses every write.

**`useArchive`** owns the first read, `PRAGMA data_version` polling every five seconds, the clock,
reread (`r`), diagnostics and refresh (`R`). It reports through one error and notice channel. A
notice clears `NOTICE_MS` (ten seconds) after it appears, on the clock's tick; an error clears
only on a successful read.

- Clock ticks update relative ages without requerying aggregates.
- Diagnostics run `doctor` in credential-free `archiveOnly` mode after the first render and on
  `r`, not on every poll.

**Screens.** Each screen module exports a hook (`useOverviewScreen`, `useSessionsScreen`,
`useBreakdownScreen`, `useTimelineScreen`, `useLimitsScreen`, `useDetailScreen`) that returns a `ScreenModel` (`src/tui/screen.ts`) every render: its title and
help context, footer hints, help lines, an optional `reload`, whether its own overlay owns the
keyboard, and a `render(frame)`. `App` calls the hooks in a fixed order (Detail, Overview, the
Sessions tab, the drilled Sessions, Breakdown, Timeline, Limits) and builds a `Record<ScreenId, ScreenModel>`. From it, and from
`TABS`, it derives the tab bar, the digit keys, the footer hints, the help heading and lines, and
the reload loop.

**The stack.** What's on screen is a stack whose bottom is a tab (`ScreenId` is a `TabId`,
`"drill"` or `"detail"`). The paths are tab → Detail and tab → drill → Detail, and back the same
way.

- Esc on a pushed screen with no overlay open pops one level; the shell handles it, not the
  screen. Esc on a tab does nothing.
- A digit key clears the stack to that tab, from anywhere.
- The tab bar shows the tabs, then each pushed screen's title (`▸ Sessions · 2026-10-21 UTC ›
  Session Detail`). When that row is wider than the terminal, every tab but the stack's bottom one
  shrinks to its digit, so a drilled title still fits beside five tabs at 80 columns.
- Every change goes through the shell's `show`, which clears `keys.current` and reloads the new top
  if it's stale.

**Pushing.** The shell passes `open(id)` and `drill(scope, label)` to the tab hooks that need
them. Each asks a hook to load first and pushes only if the read worked; a failed read reports
through `report` and pushes nothing.

- `useDetailScreen` returns `open(id)` beside its model.
- `App` calls `useSessionsScreen` twice. The second, `drilled` instance starts empty and returns
  `drill(scope, label)`, which lists the sessions in a `SessionScope` (`query.ts`) with no filters.
  Its title is `Sessions · <label>`. Search, filters and sort apply on top of the scope, and
  clearing them keeps it. Opening a drill never changes the Sessions tab's filters or selection.
- Overview's Daily output drills into the chosen UTC day, Breakdown into a group over its window,
  Timeline into a bucket or one series in it, and Limits into a five-hour cycle's
  `[startMs, endMs)`.
- Sessions owns its editors (search, filters, project, model, activity, sort). It renders the
  editor in place of the table while `overlay` is true; the shell only calls `closeOverlay` on
  Esc.
- Help is the shell's own overlay: `<title>[ · context] help`, the screen's `help` lines, then the
  shell's (tabs, `r`, `R`, `?`, `q`, Ctrl+C) and the theme note.

**Browsing state.** State that must survive opening Detail lives in the screen hooks, which the
shell calls every render whichever screen is showing:

- `useSessions` holds 100-row pages, the filters, and the selection, kept by session id. It
  commits one view object, tracked in a ref so repeated keys compose.
- `useDetail` holds Detail's state, including the session id apart from the session, so one
  that disappears from the archive is found again if a later reread brings it back.
- `useOverviewScreen` holds Overview's navigation: the focused panel, each panel's scroll, the
  recent-session selection by id rather than by index, and Daily output's day cursor by UTC day
  start, so a reread at midnight doesn't move it. A day that scrolls out of the 30 clamps to the
  nearest end.

After an archive change (the first read, a poll that sees a new `data_version`, the hourly tick,
`r`) the shell calls `reload` on the screen that's showing and marks every other screen stale.
Showing a stale screen reloads it first, unless the caller has just loaded it (`open`). So a
screen's `reload` runs only while it's showing or just before it's shown: `bun:sqlite` is
synchronous, and a slow query on a hidden screen would freeze the one you're on. The shell still
owns the loop, so a screen can't miss a change. On startup only Overview loads; Sessions reads its
first page when it's first shown. Rereads keep the selection by id where possible.

**Sessions.** Search, project, model and activity filters choose session identities. Displayed
amounts stay whole-session totals, and costs are computed only for the session ids on screen,
with the CLI's rate and provenance logic.

- The activity filter is on each session's last activity, and project is a substring of the
  session's own project.
- A drill's `SessionScope` is different: a session is in it when one request matches both the
  `[since, until)` range and the exact key, on the request's own column (through `tool_calls` for
  a tool). That's what a group row of `attribution(by, { since, until })` counted.

**Breakdown.** One table of groups for a dimension over a window, through one dependency,
`breakdown(by, { since })` (`readBreakdown` in `data.ts`). Project, model, entrypoint and branch
come from `sessionGroupsReport`, with sessions and exact-or-absent measured cost; the other seven
from `attribution`, with no cost, and calls for tool. Both run in one read transaction.

- The windows are 30 days, 7 days and all time, back from now, as Sessions' activity filter counts
  them. The view keeps the `since` it read with, so a drill scopes the same requests.
- Share is of the window's total tokens: the grouped rows' sum, since they partition the window,
  or `corpusTotals` for an attribution dimension, whose rows leave out unattributed requests and,
  for tool, overlap.
- Each dimension keeps its selection, by group key, and its scroll. Reads are cached by dimension
  and window until the next `reload`, so ←→ back to a dimension doesn't requery.
- Enter drills with `{ since, by, key }`; `by` is the dimension's own name, and a grouped
  `'(unknown)'` row drills with `key: null`.
- Every dimension reads in under 300 ms at 30 days or all time on 93K requests (2026-10-28).
  Project, the slowest, takes about 250–285 ms.

**Timeline.** Output-token bars for every bucket back to the first request, through one
dependency, `timeline(bucket, by)` (`readTimeline` in `data.ts`), which groups `timeline()`'s rows
into `{ tsMs, endMs, output, total, rows }` per bucket. `timeline()` zero-fills every series in
every bucket (365 a day by project), so `rows` keeps only series with requests, by output tokens.

- The bars are output tokens, not total: cache reads are about 98% of total tokens, so total bars
  would chart context size. The table under the chart is the cursor's bucket, `all` and then its
  series, with total tokens, requests and cache-read share.
- As many buckets show as fit at two columns each, at most four columns a bar. The view keeps the
  cursor as a time inside its bucket and the window's right edge as a bucket start (null follows
  the newest), so a reread, a new bucket or `b` to a coarser bucket and back finds the same one.
- `BarChart` takes `partial={false}` once the window is scrolled back from the newest bucket.
- Reads are cached by bucket and split until the next `reload`. No cost column: `cost --by day`
  drops a session that crosses midnight (`statusline()`'s comment in `query.ts`).
- The book line (`books.ts`) counts the visible buckets' output tokens at 1.3 tokens a word, a
  rule of thumb rather than a measured figure, and names the largest book they cover once.
- Every read is under 300 ms all time on 93K requests (114–171 ms, 2026-10-28).

**Limits.** The current readings come from the frame (`frame.data.limits`, Overview's own read),
so they update on every archive change and their ages tick with `frame.now`. The tab's one
dependency, `limits(since, bucketMs)` (`readLimits`), reads `limitsHistory` and `blocks()` for
the zoom in one transaction.

- The zooms are 72 hours (hourly, as Overview's Meters), 7 days and 30 days, whose bucket is
  `chooseBucket(span, chartWidth)`. A read is cached by zoom and bucket until the next `reload`; a
  resize alone doesn't reread.
- At 36 rows and up, Now, History and the cycles stack, and the cycles take the rows left over, at
  least five. Below that Tab switches between Now (which ↑↓ scrolls) and History with the cycles.
- Cycles are listed newest first, the selection kept by `startMs`. Enter on a gap does nothing.
- Every zoom reads in under 130 ms on the live archive (2026-10-28), now that `blocks()` reads
  each cycle's totals as a plain range ([Limits](limits.md#how-it-works)).

**Limits on Overview.** Scoped history filters the exact selected model before hourly peak
aggregation: the binding `weekly_scoped` model first, otherwise the latest archived one.
Five-hour/seven-day sources and scoped sources are reported separately. Missing buckets stay null,
zero UTC days stay zero, and current readings are kept apart from historical peaks.

**Refresh (`R`).** Only uppercase `R` fetches limits.

- It opens a short-lived writable connection without migrating.
- It goes through `refreshFromApi`'s persisted floor and respects `CUSAGE_REFRESH=off`.
- A local in-flight guard stops repeats from queueing.
- Unmount cancels keychain and network work, suppresses late state updates and restores the
  terminal.
- A failure keeps the archived limits and says why in the status line.

**Layout.** The full dashboard starts at 110×36. From 80×24 up to that, compact mode shows one
selectable panel at a time. Below 80×24 there's a resize notice.

- A page is the rows its viewport shows. Every `movement()` page size comes from the viewport that
  key scrolls (`visibleRows`, or `tableBodyRows` for a session table), so each Overview panel
  pages by its own size, and Sessions fetches exactly its table's body rows.

**Theme.** Before Ink starts, the TUI asks the terminal for its background (OSC 11) and picks the
light or dark palette.

- A DA1 query acts as a sentinel, so the reply never leaks into Ink as keypresses.
- `--theme` beats `CUSAGE_THEME` (`auto|light|dark`); `light` or `dark` overrides the detection,
  and dark is the default when the terminal doesn't answer.
- `--no-color` or `NO_COLOR` skips the detection entirely and renders monochrome.
- Body text stays in the terminal's own foreground.
- The palette reaches components through context. Monochrome is a palette too (`MONO`, every
  tone undefined), so no component takes a `mono` prop.

## Rules worth keeping

- **Limits' current readings come from the frame, never a read of its own.** Overview's read
  already runs `currentLimits` on every archive change, and a second read could show a different
  figure from the header's.
- **Adding a tab is three edits.** A screen module whose hook returns a `ScreenModel`, a row in
  `TABS` (its id and digit key), and one hook call in `App` added to the record. Everything else
  (the tab bar, the digit key, hints, help, reload) follows from those. A tab that lists sessions
  for one of its rows takes `drill` from the shell, as Overview does, and calls
  `drill(scope, label)` on Enter. If the screen has its own input or select, it reports it through
  `overlay` and `closeOverlay` instead of the shell learning about it.
- **A screen's `reload` runs only while it's showing, or just before it's shown.** A tab with a
  slow aggregate query relies on it to keep that query off every other screen.
- **React and Ink stay inside `src/tui.ts` and `src/tui/`.** See the
  [architecture overview](README.md#two-binaries).
- **Screens get keys through the shell's single `useInput`, via `useKeys`, which registers in a
  layout effect.** Ink's `useInput` subscribes in a passive effect, so a freshly mounted screen
  would drop a key that arrives before that effect runs.
- **Printable keys that queue behind a slow frame arrive as one string (`"jjj"`).** `movement()`
  counts them rather than ignoring the chunk.
- **Keys in one chunk reach the handler with no render between them.** Ink splits `"\x1b[B\r"`
  into ↓ and Enter in one synchronous loop, so a handler reads the last committed state from a
  ref, never its render's props. When the shell changes screen or opens help it clears
  `keys.current`, so the rest of that chunk is dropped rather than sent to the screen that's
  gone.
- **Inputs and overlays own the keyboard.** `q` typed into search is text. Ctrl+C always quits.
- **`string-width` is pinned to the exact version Ink resolves, and patched.**
  `patches/string-width@8.2.2.patch` memoizes per-cluster widths.
  - Bun keys `patchedDependencies` by exact version, so a bump silently drops the patch.
  - `tests/tui/string-width.test.ts` asserts the key, the pinned version, the single resolved
    copy and the patch marker. Re-create the patch on a new version with `bun patch` rather than
    deleting the test.
- **Don't hard-code body text colour.** That's what made the dark palette unreadable on light
  backgrounds. `tests/theme.test.ts` holds every palette tone to WCAG AA (4.5:1) on
  representative backgrounds, and keeps tones within a theme distinguishable.
- **No transcript content and no per-tool token allocation** appear in Detail.

## Decisions

- **The string-width patch.**
  - Most of each keypress went to string-width's `/^\p{RGI_Emoji}$/v`, which JavaScriptCore
    evaluates very slowly. Ink measures every text node on every frame, and nearly every
    dashboard line has non-ASCII glyphs (rules, sparklines, `·`, `▸`).
  - The patch gives identical results: every code point up to U+2FFFF was checked under all
    three option sets.
  - Overview navigation at 120×40 on a 631-session archive went from about 106 ms to about 12 ms
    per key in the test renderer.
- **Versions at 5A:** Ink 7.1.1, React 19.2.0, @inkjs/ui 2.0.0.
  - Bun 1.3.3 compilation needs explicit production JSX settings.
  - Ink's optional devtools import must resolve during bundling. Compiled builds disable DEV and
    never open a devtools connection.
