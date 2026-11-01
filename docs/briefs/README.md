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
- The installed binaries in `~/.local/bin` are current at `2e52f1f` (`cusage doctor`: build ok).
- Brief 04 is done, awaiting review and a commit. Project knowledge now lives in
  `docs/architecture/`, `docs/guide/`, a short root README and `AGENTS.md`, and OKF is gone.
- Waiting on Logan: whether to regenerate the pricing calibration fixture, which predates
  `MEASURED_COST` (brief 04's report).
- Brief 05, the TUI cleanup pass, is done, awaiting review.
- Brief 06, groundwork for new tabs (reload only what's shown, fast tool attribution, drill-down
  from Overview's Daily output), is done, awaiting review.
- Brief 07, the Breakdown tab (tab 3, any dimension over a window, drilling to its sessions), is
  done, awaiting review. Its report asks whether `+` on nearly every live project and model row
  reads clearly.
- Brief 08, the Timeline and Limits tabs (tabs 4 and 5) and a `blocks()` 19× faster at 30 days,
  is done, awaiting review. Its report asks Logan for the kill criteria on both tabs.
- Next: nothing scheduled. Every tab in `FUTURE.md` § Further TUI tabs is built; Index-friendly
  request filters is the next candidate there.

## Open

In the order they should be done. A status tag follows the link when it isn't "not started". Briefs
that belong to a plan go under its heading.

4. [`04-move-knowledge-onto-layout.md`](04-move-knowledge-onto-layout.md) (done, awaiting review):
   architecture pages, the guide, a short root README and `AGENTS.md` replace the OKF bundle and
   the long `CLAUDE.md`.
5. [`05-tui-cleanup-pass.md`](05-tui-cleanup-pass.md) (done, awaiting review): the TUI's screen model (`TABS`, a reload
   per screen), one layout rule for page sizes, help per screen, `tests/tui/` split by screen,
   and thirteen visible quirks fixed.
6. [`06-tui-tab-groundwork.md`](06-tui-tab-groundwork.md) (done, awaiting review): the shell reloads only the screen
   that's showing, `attribution --by tool` gets fast, and drill-down from Overview's Daily output.
7. [`07-tui-breakdown-tab.md`](07-tui-breakdown-tab.md) (done, awaiting review): tab 3, tokens and exact-or-absent cost by
   any dimension over a window, with Enter drilling to the group's sessions.
8. [`08-tui-timeline-and-limits-tabs.md`](08-tui-timeline-and-limits-tabs.md) (done, awaiting review): `blocks()` fast with
   identical output, then tab 4 Timeline (output bars per day, week or month, split by series, a
   book line) and tab 5 Limits (sources, zoomable history, five-hour cycles), each drilling.

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

Don't relitigate these. They're in [docs/decisions/](../decisions/README.md),
one file each, and `docket decisions` lists them. If one turns out to be wrong in practice, stop
and say so.

## Not built

What's deliberately absent, so nobody flags it as missing. Point at `FUTURE.md` where it applies.

- Content ingest: message bodies, tool inputs or results, prompts, identity keys.
- A second network host, from shipped code or from a dependency.
- `cusage pricing --refresh`.
- claude.ai and Desktop chat usage: it isn't on disk. The seven-day meter can't be derived from
  local data (r=0.04 against local tokens).
- TUI mouse support: see [`FUTURE.md`](FUTURE.md).
- A Cost, Doctor or Cache tab, a TUI command prompt, and sorting Sessions by cost: parked in
  [`FUTURE.md`](FUTURE.md#parked), each with why.

## Future direction new work must not block

Each item is cheap to keep possible now and expensive to retrofit later.

- **Folding the TUI into one binary.** Only behind a lazy `await import('./tui.ts')` in one command
  arm, and then `tests/cli.test.ts` must become a check evaluated at startup, because
  `bun build --compile` bundles a dynamic import into the same file and static reachability stops
  being the right question. (`CLAUDE.md`, brief 02)
