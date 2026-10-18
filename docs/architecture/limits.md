# Limits

Limit readings come from four sources of different freshness. They are archived as samples, and
each meter is reconciled to the freshest source that carries it, keeping that source and its age.

**Sources:** `src/limits.ts`, `src/query.ts`, `src/format.ts`

**History:** [brief 01](../briefs/archive/01-archiver-and-session-views.md),
[brief 02](../briefs/archive/02-cli-reports-and-binaries.md)

`limits.ts` writes samples: `syncLimits`, `snapshotOauthCache`, `backfillDesktopHistory`,
`backfillGlazeHistory`, `recordUtilization` and `refreshFromApi`. The last one is covered in
[Network](network.md). `query.ts` reads them back: `currentLimits`, `limitsHistory`, `blocks` and
`clusterResets`. Samples are in `limit_samples` (the five-hour and seven-day meters per source) and
`limit_scoped` (the OAuth `limits[]` entries such as `weekly_scoped`).

## Sources

| Source tag | Where it comes from | What it's good for |
| --- | --- | --- |
| `oauth-live` | `GET /api/oauth/usage`, via [Network](network.md) | Current, and the only current source of `weekly_scoped` |
| `oauth-cache` | `~/.claude.json` → `cachedUsageUtilization` | The same response as Claude Code last cached it. A single overwritten snapshot, refreshed on no reliable schedule |
| `desktop-history` | the desktop app's `plan-usage-history.json` | A 15-minute series `{fh, sd, xu}`, with a rolling 30-day cap, written only while the app runs |
| `glaze` | Glaze's `usage-history.json` | A sparse day → percent map, re-read on every sync |

## How it works

**`currentLimits`.** Each meter is selected independently: take the newest sample that actually
carries it, with precedence `oauth-live > oauth-cache > desktop-history` only on a tie. The
reading comes back with its `source`, `tsMs` and `ageMs`, never as a bare number.

**History.** `limitsHistory` buckets samples over time and holds the **peak** per bucket, not the
mean: a limit touched at 98% and backed off from is a fact about the week that an average hides.
An empty bucket is `null` and renders `·`.

**Meter cycles (`blocks`).** `blocks` builds five-hour cycles from one source's five-hour series:
desktop history when available, otherwise live OAuth, otherwise cached OAuth.

- A boundary is a drop of at least 5 points and 50% between adjacent samples. That
  conservative threshold can miss low-utilization resets.
- OAuth reset times only confirm an observed drop, clustered within two minutes of a fixed anchor.
- Gaps over 30 minutes stay gaps.
- Samples from the sources that lost the single-series choice are counted and reported, so
  set-aside observations don't read as missing data.
- Local token columns sit beside each cycle as context, not as an explanation of the server meter.

## Rules worth keeping

- **Never present a stale number as current.**
  - Every figure carries its source and age.
  - A binding constraint over 15 minutes old is printed with its age and a pointer to
    `--refresh`, not in bold.
- **A null doesn't shadow the reading behind it.** Each meter is selected `WHERE <col> IS NOT
  NULL`, so a desktop sample missing `sd` doesn't turn a known 54% into "unknown".
- **Disagreement is reported, never resolved.** Two *current* sources that differ by more than 2
  points produce a `disagreements` entry naming both, with ages. Nothing is averaged or
  interpolated. A stale source that differs is just old, and the sources table says so.
- **Glaze is archived but never reconciled from.** Its metric is inferred rather than labelled,
  and it's a daily high-water mark, so it can't answer "what is it now". It's stored as
  `five_hour` with `source='glaze'`, listed as `reconcilable: false`, and every query can exclude
  it.
- **Gaps are never bridged.** "No sample" and "0%" are different facts. A sparkline that closes a
  gap invents a quiet period.
- **Cycles don't come from request gaps or `api_block_index`.** `api_block_index` is a
  per-session counter, not a five-hour window id.
- **Server truth and local attribution stay separate.** Local data covers Claude Code only.
  - The seven-day meter correlates with local output tokens at r=0.04, so it isn't derivable
    from local data.
  - The five-hour meter correlates at r=0.69.

## Decisions

- **Why reconcile per meter.** The first `currentLimits` read `WHERE source = 'oauth-cache'` and
  nothing else. On 2026-09-09 that printed a bold, unqualified `weekly_scoped (Fable) at 53%`
  beside `weekly_all 37%`. Meanwhile the desktop series in the same database held `sd 54`, sampled
  four minutes earlier, which matched the app on screen. Nothing was mis-archived: the query chose
  the wrong row and the renderer printed it without an age.
- **The two meters are the same quantity.** Around the cache's `fetchedAtMs`, `desktop.sd` read 37
  at 13:11 and 13:26 against the cache's `seven_day: 37`. Over the same span `fh` went from 30 to
  34 against `five_hour: 31`.
- **Glaze tracks `five_hour`.** That's established by correlation, not documentation. On every
  overlapping day it lands within one point of that day's `fh` maximum (56/56, 24/23, 19/18,
  13/12), and nowhere near `seven_day`.
- **`weekly_scoped` has no local history.**
  - `plan-usage-history.json` carries only `{t, org, u:{fh, sd, xu}}` (checked across every key
    in 1,976 samples).
  - It isn't in the desktop app's leveldb or its Session Storage either.
  - `cachedUsageUtilization` holds one overwritten snapshot of it, so the OAuth responses
    archived here, mostly the 15-minute agent's fetches, are its only history.
