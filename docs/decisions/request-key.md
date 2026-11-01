---
description: "`requests` is `WITHOUT ROWID`"
covers: ["docs/architecture/ingest.md"]
---
# Request key

## Choice

`requests` is `WITHOUT ROWID`; `request_id` is `''`, never `NULL`

## Why

228 records have no `requestId`; nullable PK columns would re-insert them every sync. (`CLAUDE.md`)
