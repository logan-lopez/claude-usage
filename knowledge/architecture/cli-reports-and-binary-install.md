---
type: Decision
title: CLI reports preserve provenance and install as standalone binaries
description: Commander validates the phase 3-4 CLI, reports preserve coverage and cost provenance, and stamped standalone binaries remove launchd dependence on disposable checkouts.
generated: { by: agent/codex, at: 2026-09-10T00:54:25Z }
sources: ["README.md", "src/query.ts", "src/limits.ts", "approved phase 3-4 user briefing"]
---

## Decision

The approved phase 3-4 briefing replaces the hand parser with Commander 15.
Global flags work on both sides of commands; usage failures exit 2. The query
layer returns plain data, serialize.ts owns CSV and streaming exports, and
machine paths never load format.ts. CLI and TUI compile to separate binaries.

`make install` atomically replaces ~/.local/bin/cusage and cusage-tui. Launchd
uses the fixed CLI path and HOME working directory, not a disposable Conductor
worktree. Build SHA, time, source path and dirty state are embedded; doctor
compares the build against repo HEAD. Building is not installing or reloading
existing agents.

## Reporting provenance

Attribution and other grouped views expose full-selection request coverage,
even when row caps hide groups. Tool-call groups overlap: count calls, and
show request tokens as context rather than claiming per-tool consumption.
Tool attribution is two grouped passes over a `tool_calls`-to-`requests` join,
not a query per tool name; schema v3 adds the `(session_id, message_id)` index
on each side, without which neither could seek and the view took 5.5s.
Timeline calendar boundaries are UTC, weeks start Monday, and empty buckets
remain present. Export uses SQLite iteration and stdout backpressure.

Five-hour cycles use adjacent same-source meter drops (at least 5 points and
50%), not request gaps or api_block_index. Gaps over 30 minutes remain gaps.
Samples from the sources that lose the single-series choice are counted and
reported, so set-aside observations do not read as missing data.
OAuth reset times only confirm drops, clustering within two minutes of a fixed
anchor. This deliberately misses some low-utilization resets. Local token
columns remain separate context, not an explanation of the server meter.

Prices are explicit per model/speed/token category. The initial snapshot is
transcribed from the approved briefing dated 2026-06-24; fetched_at is null
rather than pretending a fetch occurred. Known [1m] requests remain unpriced;
without cost-state, tier identity is unknown and labelled. Measured and
estimated subtotals never blend. The anonymous calibration corpus contains
166 measured sessions. No rates are fitted to the observed error distribution.

The estimator's error distribution is scored over **fully priced sessions
only** (61 of 166). A session whose every request is [1m] or an unknown model,
or which has no ingested requests at all, estimates to $0 and scores a relative
error of exactly 1.0 -- an absence graded as a wrong answer. Pooling those in
put 37 sessions at exactly 1.0 and pinned p90 to 100%, a bound no improvement
to the estimator could move. Declined sessions are reported beside the
distribution in dollars so the hole stays visible.

`statusline` carries no dollar figure. Grouped cost is exact-or-absent, so
`cost --by day` excludes any session straddling UTC midnight -- nearly always
the session in progress -- and a cost there would read $0.00 for most of the
day. It shows today's tokens and requests, which need no attribution and no
price table. Cost lives in `cusage cost`, where the exclusions are on screen.

Sources: approved cusage phases 3-4 user briefing; README.md; src/args.ts;
src/query.ts; src/pricing-snapshot.json; tools/build.ts; tests/pricing.test.ts.

## Related Concepts

- [Exact-or-absent grouped cost](grouped-cost-is-exact-or-absent.md): Shared monetary exclusion rule.
- [One endpoint and refresh guard](live-oauth-fetch-with-guard.md): Nonblocking statusline workers share an atomic attempt claim.
