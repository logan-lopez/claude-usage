# Future

Unscheduled work. Each section has enough in it to become a brief.

## Further TUI tabs

The mockup's tab bar ([`assets/03/`](assets/03/cusage_tui_overview_120x40.html)) draws Timeline,
Cost, Attribution, Blocks, Cache, Limits and Doctor beside Overview and Sessions. Brief 03 built
only the first two and deferred the rest.

- **Why:** each of these already exists as a CLI view over `query.ts`, so the TUI is the only
  place they can't be browsed.
- **Likely shape:** one screen module per tab under `src/tui/`, consuming the existing `query.ts`
  results, not a rewrite of `cli.ts`. Cost keeps measured and estimated separate; Limits carries
  source and age on every figure.
- **Kill criteria:** a tab that adds nothing over its CLI table plus the Overview panels.

Source: [brief 03](archive/03-ink-tui-session-explorer.md), Summary; root README, Status.

## Grouped session views in the TUI

Sessions grouped by project, model or skill, as `cusage sessions --by` does on the CLI. Deferred by
brief 03.

- **Why:** "where did the tokens go" is a grouping question, and the Sessions screen is flat.
- **Likely shape:** a grouping toggle on the Sessions screen that keeps selection and filters
  across regrouping.
- **Must keep:** grouped cost is exact or absent. Straddling sessions are counted, their cost
  excluded and marked, never summed into each group.
- **Kill criteria:** filters on the flat list answer the same questions.

Source: [brief 03](archive/03-ink-tui-session-explorer.md), Summary; root README, Status.

## TUI mouse support and command prompt

Both deferred by brief 03.

- **Why:** mouse for scrolling and selection; a command prompt for running CLI-style queries
  without leaving the TUI.
- **Likely shape:** open. The keyboard contract in brief 03 (text inputs own input while active)
  is what a prompt has to respect.
- **Kill criteria:** the keyboard contract covers it in practice.

Source: [brief 03](archive/03-ink-tui-session-explorer.md), Summary; root README, Status.

## Parked
