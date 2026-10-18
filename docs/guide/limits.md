# Limits

`cusage limits` shows the server's usage limits with where each number came from and how old it
is, including the per-model weekly limit the menu-bar tray doesn't show.

**Covers:** [Limits](../architecture/limits.md), [Network](../architecture/network.md)

## The current reading

```
Server-reported limits  oauth-live · just now
     kind           scope  pct  severity  resets
  ▸  weekly_scoped  Fable  74%  normal    2026-09-13 05:59
     weekly_all     all    54%  normal    2026-09-13 05:59
     session        all     2%  normal    2026-09-10 01:29

  binding constraint: weekly_scoped (Fable) at 74% · just now

  meter      pct  source      age       resets
  five_hour   2%  oauth-live  just now  2026-09-10 01:29
  seven_day  54%  oauth-live  just now  2026-09-13 05:59

  archived sources
    source           age          five_hour  seven_day
    oauth-live       just now            2%        54%
    glaze            just now           15%          -  daily, inferred — not reconciled
    desktop-history  7m ago              2%        54%
    oauth-cache      28h 40m ago        31%        37%
```

- **The top table** is the server's list of limits. The tray shows `weekly_all`. The one marked
  `▸` is the binding one, which is often `weekly_scoped`: a weekly limit for one model, and
  usually the higher number.
- **The meters** are the five-hour and seven-day readings. Each comes from the freshest source
  that has it, with that source and its age beside it.
- **The archived sources** are every place a reading came from:
  - `oauth-live` is fetched from Anthropic.
  - `oauth-cache` is what Claude Code last cached in `~/.claude.json`, which can be a day old.
  - `desktop-history` is the desktop app's 15-minute series.
  - `glaze` is the Glaze app's daily figure, shown but never used.

  When two current sources disagree by more than a couple of points, both are shown. cusage
  never averages them.

A binding constraint more than 15 minutes old is printed with its age and a hint to refresh, not
as a bold answer.

## Refreshing

`limits` and `sync` fetch a fresh reading when the archived one is over 15 minutes old. To change
that:

- `--refresh` checks now;
- `--no-refresh`, or `CUSAGE_REFRESH=off` in the environment, keeps a run entirely local.

Fetches are at least 3 minutes apart across every cusage process, including the background
agents, and nothing lowers that. A failed fetch prints one line on stderr and you still get the
archived view.

## History

`cusage limits --history` plots the meters over time:

```
Limit history  2026-09-06 22:18 → 2026-09-09 22:18  ·  73 × 1h  ·  210 samples

  seven_day (weekly)     ▂▂▂▂▂▂▂▂▂▂▂▂·····▂▃▃▃▃▃▃▃▃▃▃▃▃▃········▃▄▄▄▄▄▄▄▄▄▄·▄▄▄▄▄▄···▅▅·▅▅▅▅▅▅▅▅▅▅  now  54%  peak 54%
  five_hour (session)    ▂▂▂▂▂▂▂▁▂▂▂▂·····▁▂▂▁▁▁▂▂▃▃▃▅▅▂········▂▂▂▂▄▂▂▃▅▆▁·▁▁▁▁▁▁···▁▁·▁▂▂▁▂▂▂▂▁▁  now   2%  peak 65%
  weekly_scoped (Fable)  ···········································▅···························▆▆  now  74%  peak 74%

  daily peaks (UTC)
    day         five_hour  seven_day  Fable  samples
    2026-09-08        65%        49%    53%       64
    2026-09-09        15%        54%    74%       66
```

- Each bucket shows the **peak**, not the average. A limit you touched at 98% and backed off from
  still shows.
- `·` means no sample, usually because the desktop app wasn't running. Gaps are never filled in.
- The `weekly_scoped` row is sparse because that number is recorded only when cusage fetches it
  or snapshots Claude Code's rarely refreshed cache. The desktop series doesn't carry it.

It covers the last 7 days unless `--since`, `--until` and `--bucket <duration>` set the window and bucket size. `--glaze` includes
the Glaze series.

## The statusline

`cusage statusline` prints one line for a shell or Claude Code status bar:

```
weekly_all 51% [oauth-live, 13m ago] · 5h 1% [oauth-live, 13m ago] · 323.4K tok, 3 req today UTC [local 21m ago]
```

It answers straight from the archive and never waits on the network. If the limits are stale, it
starts a background refresh that the next call will see. It shows tokens and requests for today
(UTC), not dollars ([Cost](cost.md) says why). `--no-refresh` turns the background refresh off.
