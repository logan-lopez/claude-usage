# Future

Unscheduled work. Each section has enough in it to become a brief.

## Further TUI tabs

The mockup's tab bar ([`assets/03/`](assets/03/cusage_tui_overview_120x40.html)) draws Timeline,
Cost, Attribution, Blocks, Cache, Limits and Doctor beside Overview and Sessions. Brief 03 built
only the first two and deferred the rest. An `/ideate` run (2026-10-28) cut the list to three:
Breakdown (attribution and grouping in one), Timeline, and Limits with the five-hour cycles inside
it. Cost, Doctor and Cache are under [Parked](#parked).

- **Why:** each of these already exists as a CLI view over `query.ts`. What a tab adds over its
  CLI table is drill-down: Enter on a row lists that row's sessions, then Detail.
- **Likely shape:** one screen module per tab under `src/tui/`, consuming the existing `query.ts`
  results, plus a row in `TABS` and a hook call in `App`. Each tab drills through brief 06's
  `drill(scope, label)`.
- **Kill criteria:** a tab that adds nothing over its CLI table plus the Overview panels.

Built: [brief 06](06-tui-tab-groundwork.md) (reload only what's shown, fast tool attribution,
drill-down) and [brief 07](07-tui-breakdown-tab.md), Breakdown as tab 3. Timeline and Limits are
still unscheduled.

### Timeline

Bars per day, week or month (`b` changes the bucket), split by model, project or effort (`g`).
Enter on a bucket drills to the sessions active in it.

- **Why:** Overview's Daily output is a fixed 30 days of one series. This zooms out to months,
  splits by series, and answers "what was that spike".
- **Shape:** `src/tui/timeline.tsx` over `timeline()`, which takes 98 ms all-time on the live
  archive (2026-10-28). The columns are tokens, requests and cache-read share, which is all a Cache
  tab would have added. There's **no cost column**: `cost --by day` excludes the session that
  crosses midnight, so today would read $0.00 while you spend. That's the statusline's reasoning
  in `query.ts`. Enter calls `drill({ since, until }, …)`.
- **Size:** S once brief 06 has landed.
- **Kill criteria:** brief 06's day drill on Overview's Daily output already answers it, and you
  never zoom past 30 days.

### Limits

Meters with every archived source and any disagreement, history you can zoom (72h, 7d or 30d with
←→), and the observed five-hour cycles under it. Enter on a cycle drills to the sessions active
during it.

- **Why:** this is the reason to leave the explorer open. It polls every five seconds, and the CLI
  can't zoom. Overview shows the binding limit and 72 hours, but not the archived sources table,
  the disagreements, or the scoped model's history beyond that. Blocks belongs here rather than as
  its own tab, since a cycle is a reading of the same meter.
- **Shape:** `src/tui/limits.tsx` over `currentLimits`, `limitsHistory` and `blocks()`, scoped
  to the window. Every figure keeps its source and age. A cycle's drill says plainly that local
  activity is context, not the cause: the meter also counts claude.ai and the desktop app.
- **Needs first:** `blocks()` takes 1572 ms for 30 days and 452 ms for 7 (live archive,
  2026-10-28). It runs one `requests` totals query per cycle, and it hasn't been profiled yet.
  Make it fast with identical output before it backs a tab.
- **Size:** M.
- **Kill criteria:** you'd never leave the explorer on this tab rather than Overview. If so, a
  cycles panel on Overview gets most of it for S.

## TUI mouse support and command prompt

Both deferred by brief 03.

- **Why:** mouse for scrolling and selection; a command prompt for running CLI-style queries
  without leaving the TUI.
- **Likely shape:** open. The keyboard contract in brief 03 (text inputs own input while active)
  is what a prompt has to respect.
- **Kill criteria:** the keyboard contract covers it in practice.
- **The command prompt is parked** (below). Mouse support is still open.

Source: [brief 03](archive/03-ink-tui-session-explorer.md), Summary; root README, Status.

## Parked

- **A Cost tab.** Grouped cost is mostly gaps by design: large ones by model, and by day it drops
  the session crossing midnight. Cost by session is exact, and that's Sessions. Cost is a column in
  Breakdown (brief 07) instead. Would come back if cost-state became per request.
- **A Doctor tab.** Overview's Archive panel already runs `doctor` minus the credential check, and
  `r` reruns it. Would come back if doctor grew checks too long for a panel.
- **A Cache tab.** One small table that changes slowly, with nothing to browse. Its one figure,
  cache-read share, belongs in Timeline. Would come back with a per-session cache question the CLI
  can't answer.
- **The TUI command prompt.** A Zellij pane running `cusage` beside the explorer already does it.
  A prompt would mean parsing argv and rendering CLI output inside Ink, a second surface for every
  command. Would come back if the explorer ran somewhere without a second pane.
- **Sorting Sessions by cost.** Estimates are priced in JavaScript, only for the rows on screen, so
  the sort would have to price every session, and a ranking that mixes measured and estimated
  reads as one scale. Would come back with a way to sort measured and estimated sessions apart.
