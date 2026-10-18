# Brief 05: TUI cleanup pass

**Size:** L. Five separate pieces of work (the screen model, the layout math, per-screen help, the
test split, and the quirk fixes), each mechanical but each touching most of `src/tui/`.

Read `CLAUDE.md`, [`README.md`](README.md), [the TUI page](../architecture/tui.md), [the explorer
guide page](../guide/explorer.md) and [`FUTURE.md`](FUTURE.md) § Further TUI tabs first. There are
no prerequisites. Brief 04 has landed (`1fd58b6`).

## Goal

Clean up the explorer an earlier agent wrote before new tabs go on it. This is one pass, with no
new screens and no new data.

Three things are wrong now:

- **Adding a tab means editing six places in `App.tsx`.** These are the `Screen` union, the
  hand-built tab bar string, the `1`/`2` keys, `HINTS`, the help-title ternary and the
  `onReload` callback that names `sessions.reload()` and `detail.reload()`. Sessions' overlays
  also live in the shell's `Overlay` union.
- **The layout math is scattered and inconsistent.** Page sizes are `height - 5` in four places
  and `height - 2` in another. None of them matches the viewport it scrolls.
- **There's a set of small visible quirks.** They're listed under [Quirks to fix](#quirks-to-fix).
  Logan wants all of them fixed, plus any others found on the way.

After this, a new tab is one screen module, one row in `TABS` and one hook call in `App`.

## Decisions already made

Decided with Logan, 2026-10-18. Don't revisit them silently.

- **Scope: groundwork, plus help and tests.** That covers the screen model, `mono` moved into
  context, one place for the layout math, help text per screen, and `tests/tui.test.tsx` split
  by screen. No new tabs.
- **Behavior changes are allowed.** Fix the quirks listed here and any others found ("An earlier
  agent wrote this, I want a pass to clean that up"). Each fix gets a line in the report.
- **Reload is a field on the screen model.** Each screen's hook may return `reload`, and the
  shell calls every one of them after an archive change. A new tab can't forget to register.
- **Detail is a pushed screen, not a tab.** It opens with Enter and Esc returns to where you came
  from. This is unchanged from brief 03.
- **These rules from the TUI page are unchanged:**
  - keys go through `useKeys` in a layout effect;
  - `movement()` counts chunked keys;
  - inputs and overlays own the keyboard, and Ctrl+C always quits;
  - body text is never hard-coded;
  - React and Ink stay inside `src/tui.ts` and `src/tui/`.

## Already checked

Checked 2026-10-18, against `main` at `1fd58b6`.

- **Baseline.** `bun test` gives 139 pass and 0 fail. `bun run typecheck` is clean. Installed
  versions are Ink 7.1.1, React 19.2.0, @inkjs/ui 2.0.0 and Bun 1.3.3.
- **`App`'s props are a public interface.** `src/tui.ts` and `tests/tui.test.tsx` pass `deps`,
  `mono`, `theme`, `themeNote`, `dimensions` and `onQuit` (`tests/tui.test.tsx:103-145`).
- **What the tests import.** `tests/tui.test.tsx` imports `readOverview`,
  `archiveDependencies`, `openArchive`, `dataVersion`, `SessionBrowser` and `activitySince` from
  `src/tui/data.ts`, and `costLabel` and `fit` from `src/tui/text.ts`. `tests/theme.test.ts`
  imports `PaletteContext` and `Row` from `components.tsx`.
- **`num(999_999)` returns `"1000.0K"`.** Run with `bun -e` against a copy of `text.ts:49-55`.
- **The TUI and the CLI draw different sparkline glyphs for the same reading.**
  - The TUI's `spark` floors: `text.ts:81`, `Math.floor((n / 100) * 7)`.
  - The CLI's `sparkline` rounds: `format.ts:359`, `Math.round((v / 100) * 7)`.
  - So 50% is `▄` in the explorer and `▅` in `cusage limits --history`. The glyph strings are
    identical.
- **`format.ts`'s `sparkline` can't be imported into the TUI.** It wraps `·` in an ANSI dim when
  `setColour` is on, which is the default, and `clean()` would turn the ESC into a space.
- **`src/time.ts` can be imported into the TUI.** `fmtDuration`, `fmtAge` and `fmtWhen` are pure,
  with no colour and no `Database`.
- **The string-width test is referenced by its file path.** `tests/tui.test.tsx` is named in
  `AGENTS.md:76`, in the `string-width` row of this README's decisions table, and at
  `docs/architecture/tui.md:92`.
- **No test asserts the text of any quirk below.** The refresh test only checks that the frame
  contains `guarded` and `offline` (`tests/tui.test.tsx:390-425`).

## Open questions

Each has the default to use if Logan doesn't answer.

- **When does a status-line notice clear?** Default: ten seconds after it appears, on the
  existing one-second clock. Errors still clear only on a successful read.
- **Is `CHROME_ROWS`'s spare row needed?** Default: keep it. Remove it only if the PTY smoke
  passes without it at 80×24 and 120×40. If you remove it, say so in the report.

## Shape

### Screen model (`src/tui/screen.ts`, new): **pinned**

The tab briefs in `FUTURE.md` build on this shape. Changing it needs Logan.

```ts
/** What the shell needs from one screen. Its hook rebuilds it each render. */
export interface ScreenModel {
  /** The tab bar label and the help heading. */
  title: string;
  /** Appended to the help heading, e.g. Overview's focused panel. */
  context?: string;
  /** Footer key hints while no overlay is open. */
  hints: string;
  /** This screen's lines for `?`: its keys, and what its marks mean. */
  help: string[];
  /** Called after every archive change, keeping browsing state. */
  reload?: () => void;
  /** True while this screen's own input or select owns the keyboard. */
  overlay: boolean;
  closeOverlay?: () => void;
  render: (frame: Frame) => React.ReactNode;
}
export type Frame = {
  width: number;
  height: number;
  now: number;
  data: OverviewData;
  diagnostics: Diagnostics | null;
};
/** Digit keys follow this order. Detail isn't a tab. */
export const TABS = [
  { id: "overview", key: "1" },
  { id: "sessions", key: "2" },
] as const;
```

- **Hooks.** Each screen module exports a hook that returns a `ScreenModel`:
  `useOverviewScreen`, `useSessionsScreen` and `useDetailScreen`. Each takes what it needs, such
  as `deps`, `report`, the layout, and `open(id)` or `back()`.
- **What the shell does with them.** `App` calls each hook explicitly, in a fixed order, and
  builds a `Record<ScreenId, ScreenModel>`. From that record it derives:
  - the tab bar;
  - the digit keys;
  - the footer hints;
  - the help heading and help lines;
  - the reload loop, which calls every `reload`.
- **What leaves `App`.** `HINTS`, the help-title ternary and the `Overlay` union go. So do the
  imports of `SessionOverlay` and `panels`.
- **Sessions owns its overlays.** These are search, filters, project, model, activity and sort.
  `useSessionsScreen` holds that state and renders the overlay in place of the table. The shell
  only reads `overlay` and calls `closeOverlay` on Esc.
- **Help stays the shell's overlay.** It shows `<title>[ · context] help`, then the screen's
  `help` lines, then the shell's own lines (tabs, `r`, `R`, `?`, `q`, Ctrl+C), then the theme
  note.
- **Browsing state still lives in hooks the shell calls.** That's why Detail can return to the
  same selection. Overview's `nav` moves from `App`'s `useState` into `useOverviewScreen`.

### Style context (`components.tsx`, `theme.ts`)

- **Move monochrome into the context.** Add `MONO: Palette`, with every tone `undefined`, to
  `theme.ts`. Keep it outside `palettes`, so `tests/theme.test.ts`'s contrast loop doesn't see
  it.
- **`App` picks the value.** It provides `mono ? MONO : palettes[themeName]`.
- **Delete the `mono` prop from every component and screen.** That's `Row`, `Section`,
  `Viewport`, `BarChart`, `SessionTable`, the screens and `Help`.
- **Keep everything else.** `App`'s own `mono` prop, the @inkjs/ui `themes.mono`, and `bold` on
  selected rows all stay. `tests/theme.test.ts` keeps rendering `Row` inside `PaletteContext`.

### Layout (`src/tui/layout.ts`, new)

- **What moves here.** `MIN_COLUMNS`, `MIN_ROWS` and `CHROME_ROWS` move out of `App.tsx`. Add a
  `visibleRows(viewportHeight)` helper, because `Viewport`'s last row is its position indicator.
- **The rule: a page is the rows its viewport shows.** Every `movement()` page size comes from
  the viewport that key scrolls:
  - each Overview panel, using its own size (so the full dashboard has five different page
    sizes);
  - Sessions' table body;
  - Detail's viewport;
  - Help.
- **Sessions fetches exactly the table's body rows.** `useSessions` takes that number rather than
  `App`'s `pageHeight`.
- **Overview's numbers stay in `overview.tsx`.** `FULL`, `FULL_MIN_WIDTH` and `FULL_MIN_HEIGHT`
  belong to that screen.

### Quirks to fix

Each one is a visible change. Give each a line in the report, with any others you find.

1. **The page sizes don't match their viewports** (`App.tsx:81`, `overview.tsx:212`,
   `detail.tsx:128`, `help.tsx:54`). PageDown in a 9-row Overview panel jumps straight to the
   end, Detail pages one row short, and Help pages one row short. The Layout rule above fixes
   all of them.
2. **The Sessions table has a blank last row.** It shows `height - 4` body rows but fetches
   `height - 5` (`sessions.tsx:204` against `App.tsx:81`).
3. **`num` rolls over to `1000.0K`** (`text.ts:49-55`). Round first, then pick the unit, so
   999,999 reads `1.0M`.
4. **The sparkline doesn't match the CLI** (`text.ts:81`). Round, as `format.ts:359` does. Add a
   test that both give the same glyphs for 0, 7, 50, 93 and 100. A copy of the mapping in the
   test is fine. Don't import `format.ts` into `src/tui/`.
5. **A small nonzero day looks like a zero day in Daily output** (`components.tsx:129`). Any
   nonzero value gets at least the bottom block. Zero days keep the `─` baseline.
6. **Notices never clear.** "Limits refreshed." and "Archive reread…" replace the default status
   line for the rest of the session. Clear them per the open question's default.
7. **The guarded-refresh notice prints an ISO timestamp** (`useArchive.ts:79`). Say
   `Refresh guarded; retry in 2m` instead. Keep the word "guarded", which the test looks for.
8. **The Help footer says "Enter apply"** (`App.tsx:245`). Help has nothing to apply. Show
   `↑↓ scroll · Esc close · Ctrl+C quit` in Help, and keep the current hint for Sessions'
   overlays.
9. **The header shows zero tokens and zero sessions while the first read is in flight**
   (`App.tsx:286`). Show `Reading archive…` until data arrives.
10. **Detail shows zero totals for a session that's gone** (`detail.tsx:139-146`). It prints
    `0 requests · 0 tokens`. Drop the totals row and keep "Session no longer available".
11. **Detail's Summary prints raw values.** Durations show as milliseconds (`total_duration_ms:
    5123456`) and timestamps as raw ISO. Use `fmtDuration` and `fmtWhen` from `src/time.ts`.
    Labels can become plain words: "Duration", "API time", "Tool time", "First", "Last" and so
    on.
12. **The Activity and Sort selects have no heading row**, unlike Search and Filters. Give them
    one.
13. **Overview's hint says "Enter open" on every panel**, but Enter only works on Recent sessions.
    The hint follows the focused panel.

### Small tidies, with no visible change

- **Name Detail's sections.** `detailLines` switches on `section === 0`, `1` and `3` next to an
  `ATTRIBUTION` found by `indexOf`. Use a named lookup instead.
- **Give `useDetail` methods.** It hands `setState` to `DetailScreen`. Replace that with methods
  in the style of `useSessions`, such as `section(delta)`, `dimension(delta)` and `scroll(to)`.
- **One constant for the archive-unreadable message.** "Archive unreadable; last successful data
  retained (outdated)…" is duplicated at `useArchive.ts:48` and `sessions.tsx:131`.
- **Move `activities`, `Activity` and `activitySince` into `sessions.tsx`.** `DAY` can move too.
  These are Sessions UI, not archive lifecycle. Update the test import.
- **Fix `data.ts:1`.** It says "bounded page cache", but `SessionBrowser`'s pages and costs never
  evict. Reword it, and the TUI page's "session page cache" if needed. A new browser on every
  filter or reload is what bounds it in practice, at hundreds to low thousands of sessions.
- **Remove the out-of-order reference.** `App`'s `useArchive(deps, () => { sessions.reload() … })`
  reads `sessions` and `detail` before they're declared. The reload loop removes it.

### Help per screen

- **Rewrite in the guide's voice.** Replace `help.tsx`'s single `HELP` list with each model's
  `help` lines plus the shell's shared lines. Write them in the plain language of
  [`guide/explorer.md`](../guide/explorer.md), not the current jargon ("measured cumulative
  session cost-state").
- **Keep every fact the current list states**, under the screen it belongs to:
  - the marks `~`, `+` and `unavailable`;
  - whole-session totals;
  - meters are hourly peaks, and gaps aren't bridged;
  - Daily output is UTC, and today is partial;
  - tools count calls, not tokens;
  - what `r` and `R` do.

### Test split (`tests/tui/`)

Split the 672-line `tests/tui.test.tsx` by area:

| File | What it holds |
| --- | --- |
| `helpers.tsx` | `dependencies()`, `mount()`, `until`, `settle` and `NOW` |
| `data.test.ts` | `openArchive`, the WAL fallback, `readOverview`, `SessionBrowser` and diagnostics |
| `shell.test.tsx` | tabs, keys, quit, undersize, refresh, polling, chunked keys and the screen model |
| `overview.test.tsx` | Overview, plus its compact and full layout |
| `sessions.test.tsx` | Sessions, its overlays and paging |
| `detail.test.tsx` | Detail |
| `string-width.test.ts` | the string-width patch test |

- **Move tests, don't rewrite them.** A test's body changes only where this brief changes
  behavior.
- **Update the three references** to `tests/tui.test.tsx` listed under Already checked, so they
  point at `tests/tui/string-width.test.ts`.
- **New tests:**
  - the tab bar and digit keys come from `TABS`;
  - every model's `reload` runs after a `data_version` change;
  - PageDown in a small Overview panel moves by that panel's visible rows;
  - the Sessions table at 80×24 has no blank body row;
  - `num` at 999,999;
  - sparkline parity with the CLI;
  - notice expiry;
  - Help's footer;
  - the header while loading.

### Docs

- **Update [`tui.md`](../architecture/tui.md) in the same commit as the code:**
  - the file table (add `screen.ts` and `layout.ts`);
  - Browsing state, rewritten around the screen model;
  - a new rule, "Adding a tab", saying what goes in `TABS`, the hook and `App`;
  - the string-width test path.
- **Update [`guide/explorer.md`](../guide/explorer.md) once**, for what Logan now sees:
  - help per screen;
  - notices that clear;
  - Summary in readable units.

  The keys table doesn't change.

## Out of scope

- New tabs, grouped sessions, mouse support and the command prompt. `FUTURE.md` keeps them.
- Code outside the TUI: `src/query.ts`, `src/format.ts`, `src/time.ts`, `src/limits.ts`, the CLI
  and ingest. Only importing from `src/time.ts` is allowed.
- The theme detection in `src/tui.ts` and `theme.ts`, apart from adding `MONO`.
- `patches/` and the `string-width` pin.
- The keyboard contract and the key bindings themselves.

## Build order

Commit after each step. Every step leaves `bun test` and `bun run typecheck` green.

1. **Split the tests**, with no code change. All 139 must still pass.
2. **Move `mono` into the context.**
3. **The layout module**, plus quirks 1 and 2.
4. **The screen model.** Move Sessions' overlays and Overview's nav into their hooks, and turn on
   the reload loop. Then stop and check that `App.tsx` names no screen beyond its three hook
   calls and the `TABS` lookup.
5. **Help per screen**, plus quirk 8.
6. **The rest of the quirks and the tidies.**
7. **Docs, then `make install`.**

If the session runs long, stop after step 4 and report. Steps 5–7 can go in a second session on
the same branch.

## Acceptance

Run each of these and check what it shows:

- `bun test` passes. There are more tests than 139, and `tests/tui.test.tsx` no longer exists.
- `bun run typecheck` is clean.
- `rg -n "mono" src/tui` finds nothing outside `App.tsx`, `theme.ts` and the palette pick.
- `rg -n "SessionOverlay|sessions\.reload|detail\.reload|HINTS|height - 5" src/tui` finds
  nothing.
- `rg -n "tui\.test\.tsx" AGENTS.md docs --glob '!docs/briefs/archive/**' --glob '!docs/briefs/0*-*'`
  finds nothing. The briefs themselves are excluded, because they record history.
- `make build` succeeds, then `python3 tools/tui-pty-smoke.py <db>` passes.
  - Use a scrubbed archive built from `fixtures/`, as the script's docstring says. Never use the
    live archive.
  - The smoke runs in a pseudo-terminal and opens no window.
- `make install` succeeds, then `cusage doctor`'s build line names the new commit.

Only Logan can check these, in kitty with the installed `cusage-tui`, on a light and a dark
background:

- PageDown and PageUp in each Overview panel at 120×40, and in compact mode at 80×24.
- The Sessions table fills to the bottom row.
- `?` on each screen shows that screen's help, and reads plainly.
- Notices clear by themselves.
- Detail's Summary reads in hours and minutes.
- Search, filters and sort still behave as they did. Esc cancels, and `q` typed into search is
  text.

Then stop. Report every quirk fixed, including any found beyond this list, with its commit. Ask
Logan before merging anything.
