---
type: Fact
title: Measured shape of the local Claude Code corpus, 2026-09-09
description: Ground-truth measurements of the transcript corpus and limit sources taken on 2026-09-09, including two corrections to the assumptions the project plan was written from.
generated: { by: agent/mcp, at: 2026-09-09T17:39:48Z }
---

Measured directly, not assumed. Absolute counts grow; the ratios are the
durable part.

## Transcripts

- **574** `*.jsonl` files, ~241 MB read. **60 of them are sub-agent transcripts**
  nested at `<project>/<sessionId>/subagents/agent-*.jsonl`. A one-level glob
  finds only 514 and misses all sub-agent attribution. The plan's stated 563
  files came from such a glob.
- ~18.7K raw assistant records with a `usage` object → **8,842 deduped**.
  Ratio **2.12×**. Raw output tokens 34.8M; deduped 11.3M.
- Exactly **228** assistant records have no `requestId`.
- 2,406 sidechain records, all of which also carry `agentId`.
- `sessionKind` has one observed value: `bg`.

## cost-state

- 371 records across **162 of 506** sessions. Records are **cumulative** and
  several exist per session: summing every record gives **$1652.36**, which is
  wrong. Max-per-session gives **$744.68**, which the ingester reproduces
  exactly and which reconciles to the per-model rollup to the cent.
- Per model: fable-5-1 $434.72, opus-5 $157.90, **opus-5[1m] $139.79**,
  sonnet-5 $10.99, haiku-4-5 $1.28.
- `claude-opus-5[1m]` appears **only** here. `requests.model` collapses it to
  `claude-opus-5` (0 rows match `[1m]`).

## Limit sources

- `cachedUsageUtilization.limits[]` had `weekly_scoped` / Fable / 53% /
  `is_active: true` while `weekly_all` (the tray number) read 37%.
- `plan-usage-history.json`: 1,969 samples, 2026-08-10 → now, modal gap 15 min
  (1,716 of 1,968 intervals).
- **Glaze's metric is `five_hour`, established by correlation, not assumed.**
  Its flat day→percent map carries no label. On every overlapping day it lands
  within one point of that day's `fh` maximum (56/56, 24/23, 19/18, 13/12) and
  nowhere near `seven_day`. The plan had filed it as the same shape as the
  desktop series, which would have put it in the wrong column.

## Confirmed plan caveats

- `server_tool_use.web_search_requests` and `web_fetch_requests` are **0**
  across the entire corpus, even where WebSearch ran. Client-side tools.
- `ephemeral_5m + ephemeral_1h` does not reconcile with
  `cache_creation_input_tokens`: gap of ~1K tokens out of 42M, and the sign is
  the opposite of what the plan predicted.
