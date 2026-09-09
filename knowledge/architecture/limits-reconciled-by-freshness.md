---
type: Decision
title: Current limits are reconciled per meter by freshness, never taken from one source
description: Each limit meter takes the newest source that carries it and keeps its provenance and age, after reading only the oauth cache produced a confident 37% weekly against a real 54%.
generated: { by: agent/cli, at: 2026-09-09T22:05:11Z }
---

## Decision

`currentLimits()` in `src/query.ts` selects each meter independently, taking the
newest source that actually carries it, and returns a reading annotated with its
`source`, `tsMs` and `ageMs` rather than a bare number. `renderLimits` prints
that provenance and age on every row.

Precedence on a tie is `oauth-live > oauth-cache > desktop-history`, but only on
a tie — freshness decides first.

## Why

The first version read `WHERE source = 'oauth-cache'` and nothing else. On
2026-09-09 that produced a bold, unqualified `binding constraint: weekly_scoped
(Fable) at 53%` alongside `weekly_all 37%`, while the desktop series **in the
same database** held `sd 54` sampled four minutes earlier, matching the app on
screen. Nothing was mis-archived. The query chose the wrong row and the renderer
printed it without an age.

The two meters were cross-validated as the same quantity before reconciling
them: around the cache's `fetchedAtMs`, `desktop.sd` read 37 at 13:11 and 13:26
against the cache's `seven_day: 37`, and `fh` bracketed 30→34 against
`five_hour: 31`.

## Rules

- **Glaze is archived but never reconciled from.** Not because it is stale —
  its metric is inferred rather than labelled, and it is a daily high-water
  mark, so "the value right now" is not a question it can answer. It still
  appears in the sources list, flagged `reconcilable: false`.
- **A null does not shadow the reading behind it.** Each meter is selected with
  `WHERE <col> IS NOT NULL`, because a desktop sample missing `sd` must not
  turn a known 54% into "unknown".
- **Disagreement is reported, never resolved.** Two sources that are *both*
  current and differ by more than 2 points produce a `disagreements` entry
  naming both, with ages. Nothing is averaged and nothing is interpolated. A
  stale source that differs is not a disagreement — it is just old, and the
  sources table says so.
- **A stale binding constraint is labelled, not bolded.** Over 15 minutes old
  it prints with its age and a pointer to `--refresh` instead of as an answer.
  This is the corollary the first version missed: *never present a stale number
  as current* is a separate rule from *never present a derived number as fact*,
  and only the second one was written down.

## History

`limitsHistory()` buckets the same sources over time, holding the **peak** per
bucket rather than the mean — a limit touched at 98% and backed off from is a
fact about the week that an average hides. Empty buckets are emitted as `null`
and rendered `·`: "no sample" and "0%" are different facts, and a sparkline that
conflates them invents a quiet period. Before this existed, ~2,000 archived
desktop samples had never been queried by anything.

# Related Concepts
- [The no-network rule is replaced by one endpoint behind a 3-minute floor](live-oauth-fetch-with-guard.md): The live source that made an honest reconciliation possible
