---
type: Decision
title: Grouped cost excludes sessions that straddle groups rather than double-counting them
description: Because cost-state is recorded per session and one session's requests can span several projects or models, grouped views sum cost only for sessions wholly inside a group and report the straddlers separately.
generated: { by: agent/cli, at: 2026-09-09T17:39:54Z }
---

## Decision

`groupSessions()` reports `cost_usd` summed **only** over sessions that appear
in exactly one group, plus two explicit counters — `sessions_split` and
`sessions_unpriced` — and a `cost_complete` boolean. The renderer marks an
incomplete column with `+` and prints why.

## Why

`cost-state` records cost per **session**. A session's individual requests can
land in several groups: one chat that dispatched sub-agents across three
worktrees is one session and three projects.

The naive implementation summed each session's total into every group it
touched. On the test fixture that turned $90.38 of real spend into $226 — and
the inflated figure looked entirely plausible per row.

## Rejected alternatives

- **Apportion by token share.** Rejected for phase 2: output tokens cost ~5x
  input and cache reads ~0.1x, so a raw token split is not a cost proxy.
  Apportioning correctly needs per-token prices, which is phase 3's
  `pricing.ts`. `cusage cost` is where that belongs.
- **Drop the cost column from grouped views.** Rejected as less informative
  than an exact partial with a stated exclusion.

## Consequence worth knowing

`sessions --by model` currently reports near-zero cost, because almost every
session touches more than one model. That is correct and conservative, not a
bug — but it is the strongest argument for finishing phase 3.

`tests/query.test.ts` asserts grouped cost never exceeds the cost-state ground
truth, and that any shortfall is declared.

# Related Concepts
- [Measured shape of the local Claude Code corpus, 2026-09-09](../findings/corpus-shape-2026-09-09.md): cost-state coverage and the cumulative-record trap that sets the ground truth
