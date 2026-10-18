# The explorer (TUI)

`cusage-tui` is a separate Ink executable that browses the archive read-only through `query.ts`,
with Overview, Sessions and Session Detail screens.

**Sources:** `src/tui.ts`, `src/tui/`, `patches/`

**History:** [brief 03](../briefs/archive/03-ink-tui-session-explorer.md)

| File | Role |
| --- | --- |
| `src/tui.ts` | The entry: argv, theme detection, render |
| `src/tui/App.tsx` | The shell only: header, tabs, status, key hints, help and global keys, all derived from the screen models |
| `src/tui/screen.ts` | The screen contract: `ScreenModel`, `Frame` and `TABS` |
| `src/tui/useArchive.ts` | The archive lifecycle |
| `src/tui/data.ts` | Opening the archive, the query-backed dependencies the screens read through, and the session page cache, which never evicts and is replaced on every filter change or reload |
| `src/tui/overview.tsx`, `sessions.tsx`, `detail.tsx` | Each exports a hook returning its screen's `ScreenModel`, and renders that screen and owns its keys |
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
`useDetailScreen`) that returns a `ScreenModel` (`src/tui/screen.ts`) every render: its title and
help context, footer hints, help lines, an optional `reload`, whether its own overlay owns the
keyboard, and a `render(frame)`. `App` calls the three hooks in a fixed order and builds a
`Record<ScreenId, ScreenModel>`. From it, and from `TABS`, it derives the tab bar, the digit keys,
the footer hints, the help heading and lines, and the reload loop.

- Detail is pushed, not a tab. `useDetailScreen` returns `open(id)` beside its model; the shell
  pushes Detail when it succeeds, and Esc returns to the tab it came from.
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
- `useOverviewScreen` holds Overview's navigation: the focused panel, each panel's scroll, and
  the recent-session selection by id rather than by index.

After every archive change the shell calls each model's `reload`, shown or not, so a screen can't
miss one. Rereads keep the selection by id where possible.

**Sessions.** Search, project, model and activity filters choose session identities. Displayed
amounts stay whole-session totals, and costs are computed only for the session ids on screen,
with the CLI's rate and provenance logic.

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

- **Adding a tab is three edits.** A screen module whose hook returns a `ScreenModel`, a row in
  `TABS` (its id and digit key), and one hook call in `App` added to the record. Everything else
  (the tab bar, the digit key, hints, help, reload) follows from those. If the screen has its own
  input or select, it reports it through `overlay` and `closeOverlay` instead of the shell
  learning about it.
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
