---
type: Decision
title: Test baselines are computed by a second, independent dedup implementation
description: fixtures/BASELINE.json is produced by a separate plain-JavaScript reducer inside tools/make-fixture.ts, so the tests compare two implementations of the dedup rule instead of the ingester against itself.
generated: { by: agent/cli, at: 2026-09-09T17:39:54Z }
---

## Decision

`tools/make-fixture.ts` contains its own ~30-line reducer that implements the
dedup rule (keep-max, then non-sidechain, then has-speed) in plain JavaScript
over the committed fixture bytes, and writes the result to
`fixtures/BASELINE.json`. The test suite asserts `src/ingest.ts` reproduces it.

## Why

Reading the expected numbers out of the ingester — or hard-coding numbers the
ingester produced — only proves the ingester agrees with itself. The SQL UPSERT
and the JavaScript reducer are genuinely different implementations of the same
rule; if they disagree, one of them is wrong and the test says so.

`MANIFEST.json` pins the fixture bytes by sha256, so `BASELINE.json` cannot
drift without the fixture changing, and regenerating rewrites both together.

## Related

The fixture is committed to a public repo, so `tools/make-fixture.ts` scrubs by
**allowlist** (`VERBATIM_ENVELOPE`, `KEEP_TYPES`) rather than denylist — a
denylist leaks the first time Claude Code adds a field. `tests/fixture.test.ts`
re-runs the leak scan on every `bun test` rather than trusting generation time.

Fields kept verbatim were checked against the live corpus first: every distinct
value of `entrypoint`, `version`, `effort`, `promptSource`, `sessionKind` and
all five `attribution*` fields is a tool, model, skill or agent name — never
user text.
- [requests is WITHOUT ROWID with request_id stored as empty string](without-rowid-request-key.md): The baseline is what proves the key design holds across full re-reads
