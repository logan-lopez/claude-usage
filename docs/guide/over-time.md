# Over time

Token totals by day, week or month; the five-hour cycles the server's meter went through; and how
much of your input came from the cache.

**Covers:** [CLI](../architecture/cli.md), [Limits](../architecture/limits.md)

## Daily, weekly, monthly

```bash
cusage daily                       # the last 30 days, one row per UTC day
cusage weekly --since 90d
cusage monthly --since all --by model
cusage timeline --bucket auto      # picks a bucket size for the window
```

`daily`, `weekly` and `monthly` are `timeline` with the bucket fixed.

- Days are UTC days, and weeks start on Monday. `--bucket auto` uses fixed-length buckets
  instead of calendar ones.
- Days with no activity are still shown, as zero.
- `--by model|project|effort` gives one series per group.

## Five-hour cycles

`cusage blocks --since 7d` lists the five-hour cycles the server's meter actually went through,
with your Claude Code tokens and requests alongside.

- A cycle starts where the meter dropped sharply between two readings.
- A reset time from Anthropic confirms a drop when it matches.
- A quiet reset at low usage can be missed. cusage won't invent one from gaps in your activity.
- Gaps of more than 30 minutes between readings stay gaps.
- The first and last cycles are usually partial.

The local token columns are context, not the cause of the meter's movement: the meter also counts
claude.ai and the desktop app, which aren't on disk.

## Cache

`cusage cache --by model|project` shows how much input came from cache reads against cache
writes, and the five-minute and one-hour cache writes separately. The last column is the gap
between the total cache writes and those two added up. It isn't zero, and cusage shows it rather
than hiding it ([Trusting the numbers](trusting-the-numbers.md)).
