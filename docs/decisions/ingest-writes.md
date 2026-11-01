---
description: "One atomic keep-max UPSERT"
covers: []
---
# Ingest writes

## Choice

One atomic keep-max UPSERT; offsets to the last complete newline, re-read on shrink or inode change, commit per file

## Why

Read-then-write degrades to "keep last", and last is the smallest streaming snapshot. (`CLAUDE.md`)
