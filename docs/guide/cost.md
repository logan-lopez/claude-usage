# Cost

cusage shows what your usage would have cost on the API, two ways: measured, from Claude Code's
own per-session cost record, and estimated, from a price table. It never adds the two together.

**Covers:** [Cost](../architecture/cost.md)

This is API-equivalent cost, not what the subscription charges.

## The two kinds

| Mark | Meaning |
| --- | --- |
| `$1.06` | **Measured.** Claude Code's own cost record for the session |
| `~$1.06` | **Estimated.** Token counts × the price table, for sessions with no cost record. `cusage cost` prints `$1.06` and says `estimated` in its basis column |
| `+` after a figure | **Partial.** Some of this row's cost was left out: sessions that span groups, or requests with no price. The report counts them |
| `unavailable` | **Unpriced.** Nothing in the session could be priced (explorer only) |

A session's cost record can also be a guess. When Claude Code charged a model it had no price for
at another model's rate, cusage ignores that record and estimates the session instead, leaving the
unknown model unpriced, rather than showing the guess as measured.

Estimates don't price what they can't know:

- unknown models;
- the 1M-context tier of a model, whose premium isn't in the price table.

The report counts those requests instead. Without a cost record the 1M tier can't be told apart
at all, so every estimated request is priced at the standard rate and also counted as tier unknown.

## `cusage cost`

```bash
cusage cost                     # the last 30 days, measured and estimated side by side
cusage cost --by model          # also: project, session, day
cusage cost --measured          # only the measured basis
cusage cost --since all --by session
```

`--measured` and `--estimated` choose which basis to show. They don't turn measured sessions into
estimates.

## Why grouped cost has gaps

Claude Code records cost per session, not per request. One session can span several projects (a
chat that sent sub-agents into three worktrees) or several models. Splitting that cost between
groups would be invented, and adding the whole of it to each group would count it several times.

So a session contributes its cost to a group only when all of its requests are in that group and
no filter cut any of them off. Otherwise its requests still count, its cost is left out, and the
row is marked `+`.

- `--by model` shows large gaps, since nearly every session uses more than one model.
- `--by day` leaves out the session that crosses midnight UTC, which is usually the one in
  progress.
- `cost --by session --since all` has no gaps.

## How good are the estimates

On 61 sessions that have a cost record and could be fully priced, the estimate's median error was
18% and the worst 78%. In total it ran about 15% low. The architecture page has the full audit.
