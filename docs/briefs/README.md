# Briefs

Each brief is a self-contained handoff for a fresh session. New ones go here, numbered in order,
and move to `archive/` when they're done. Ideas that aren't scheduled yet are in
[`FUTURE.md`](FUTURE.md).

## Where things stand

*Updated 2026-10-28.*

- Phases 1–5A are built: the archiver and both launchd agents, the full CLI report surface, and
  the Ink TUI (Overview, Sessions, Session Detail).
- Since 5A: the TUI split into modules with the keypress-latency fix (#4), a light or dark palette
  picked from the terminal background, and fallback-priced cost-state totals no longer counted as
  measured.
- The installed binaries in `~/.local/bin` are current at `177065c` (`cusage doctor`: build ok).
- Brief 04 is done, awaiting review and a commit. Project knowledge now lives in
  `docs/architecture/`, `docs/guide/`, a short root README and `AGENTS.md`, and OKF is gone.
- Waiting on Logan: whether to regenerate the pricing calibration fixture, which predates
  `MEASURED_COST` (brief 04's report).
- Brief 05, the TUI cleanup pass, is done, awaiting review.
- Next: brief 06, groundwork for new tabs (reload only what's shown, fast tool attribution,
  drill-down from Overview's Daily output), then brief 07, the Breakdown tab. Timeline and Limits
  are in `FUTURE.md`.

## Open

In the order they should be done. A status tag follows the link when it isn't "not started". Briefs
that belong to a plan go under its heading.

4. [`04-move-knowledge-onto-layout.md`](04-move-knowledge-onto-layout.md) (done, awaiting review):
   architecture pages, the guide, a short root README and `AGENTS.md` replace the OKF bundle and
   the long `CLAUDE.md`.
5. [`05-tui-cleanup-pass.md`](05-tui-cleanup-pass.md) (done, awaiting review): the TUI's screen model (`TABS`, a reload
   per screen), one layout rule for page sizes, help per screen, `tests/tui/` split by screen,
   and thirteen visible quirks fixed.
6. [`06-tui-tab-groundwork.md`](06-tui-tab-groundwork.md) (in progress): the shell reloads only the screen
   that's showing, `attribution --by tool` gets fast, and drill-down from Overview's Daily output.
7. [`07-tui-breakdown-tab.md`](07-tui-breakdown-tab.md): tab 3, tokens and exact-or-absent cost by
   any dimension over a window, with Enter drilling to the group's sessions.

## Done

Archived in [`archive/`](archive/). They record what was asked for and why, not how the code works
now. For that, read `CLAUDE.md` and the code.

1. [`01-archiver-and-session-views.md`](archive/01-archiver-and-session-views.md): phases 1–2,
   the SQLite archiver, `sync`, both launchd agents, and the session, limits and status views.
2. [`02-cli-reports-and-binaries.md`](archive/02-cli-reports-and-binaries.md): phases 3–4,
   pricing and cost, attribution, timeline, export, blocks, cache, doctor, statusline, and the
   compiled binaries as the install path.
3. [`03-ink-tui-session-explorer.md`](archive/03-ink-tui-session-explorer.md): phase 5A, the Ink
   TUI with Overview, Sessions and Session Detail. Its mockup is in
   [`assets/03/`](assets/03/cusage_tui_overview_120x40.html).

## Decisions already made

Don't relitigate these. If one turns out to be wrong in practice, stop and say so.

| Decision | Choice | Why |
| --- | --- | --- |
| TUI packaging | `src/tui.ts` is its own bin; `react`, `ink` and `@inkjs/ui` stay out of the CLI's import graph | Launchd runs the CLI hourly and the statusline polls it; neither may pay React's startup. `tests/cli.test.ts` enforces it. (`CLAUDE.md`) |
| Layering | `query.ts` → data, `format.ts` → strings, `cli.ts` → argv | `--json`/`--csv` never load `format.ts`; `format.ts` never takes a `Database`, so every view is unit-testable. (`CLAUDE.md`, brief 02) |
| Request key | `requests` is `WITHOUT ROWID`; `request_id` is `''`, never `NULL` | 228 records have no `requestId`; nullable PK columns would re-insert them every sync. (`CLAUDE.md`) |
| Ingest writes | One atomic keep-max UPSERT; offsets to the last complete newline, re-read on shrink or inode change, commit per file | Read-then-write degrades to "keep last", and last is the smallest streaming snapshot. (`CLAUDE.md`) |
| Dependencies and install | Dependencies allowed; install is compiled CLI and TUI binaries in `~/.local/bin` | `bun build --compile` starts in ~39 ms against ~98 ms and needs no `node_modules` under launchd. (`CLAUDE.md`, brief 02 §7) |
| `string-width` | Pinned to the exact version Ink resolves, and patched | Unpatched, ~90% of each keypress is one Unicode regex; Bun keys patches by exact version. `tests/tui/string-width.test.ts` catches a bump. (`CLAUDE.md`) |
| Network | `GET api.anthropic.com/api/oauth/usage` only, from `src/oauth.ts`, behind a 3-minute floor on attempts that config can raise but not lower | "No network ever" kept a 27-hour-stale 53% on screen while the real figure was 74%. (`CLAUDE.md`) |
| Pricing refresh | `cusage pricing --refresh` cancelled; `tools/refresh-pricing.ts` is run by hand | Keeps one host for shipped code, stated flatly. (brief 02) |
| Stale numbers | Every limit carries its source and age; meters reconciled per meter by freshness; disagreements reported, never averaged | The first `renderLimits` printed a bold 53% with no age. (`CLAUDE.md`) |
| Grouped cost | Exact or absent: straddling sessions counted, their cost excluded, column marked `+` | cost-state is per session; summing it into every group turned $90 into $226 on the fixture. (README, Known limits) |
| Fixtures | Frozen, allowlist-scrubbed, committed; `BASELINE.json` from a second dedup in `tools/make-fixture.ts` | Expected numbers read from `src/ingest.ts` would only prove it agrees with itself. (`CLAUDE.md`) |
| TUI screens | Each screen's hook returns a `ScreenModel`; `TABS` drives the tab bar and digit keys; the shell reloads the screen that's showing and marks the rest stale, reloading a stale one before it's shown; Detail and drilled Sessions are pushed, not tabs | Adding a tab was six edits in `App.tsx`. A new tab can't forget to reload. Reloading every screen ran hidden tabs' queries on every change, up to 2.6 s of synchronous SQLite. (Logan, 2026-10-18, brief 05; reload changed 2026-10-28, brief 06) |
| TUI grouping | A Breakdown tab with drill-down, not a grouping toggle on Sessions; Sessions stays flat | Regrouping while keeping selection and filters was the hard part of the toggle, and drilling answers the same question. (Logan, 2026-10-28, brief 07) |
| Content | Never ingested: tool names and token counts only; credentials read once, never stored | Privacy. (`CLAUDE.md`, README) |

## Not built

What's deliberately absent, so nobody flags it as missing. Point at `FUTURE.md` where it applies.

- Content ingest: message bodies, tool inputs or results, prompts, identity keys.
- A second network host, from shipped code or from a dependency.
- `cusage pricing --refresh`.
- claude.ai and Desktop chat usage: it isn't on disk. The seven-day meter can't be derived from
  local data (r=0.04 against local tokens).
- TUI tabs beyond Overview, Sessions and Breakdown (Timeline and Limits), and mouse support: see
  [`FUTURE.md`](FUTURE.md).
- A Cost, Doctor or Cache tab, a TUI command prompt, and sorting Sessions by cost: parked in
  [`FUTURE.md`](FUTURE.md#parked), each with why.

## Future direction new work must not block

Each item is cheap to keep possible now and expensive to retrofit later.

- **Folding the TUI into one binary.** Only behind a lazy `await import('./tui.ts')` in one command
  arm, and then `tests/cli.test.ts` must become a check evaluated at startup, because
  `bun build --compile` bundles a dynamic import into the same file and static reachability stops
  being the right question. (`CLAUDE.md`, brief 02)
