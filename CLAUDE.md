# CLAUDE.md

Guidance for Claude Code working in this repository.

Default to Bun over Node: `bun <file>`, `bun test`, `bun install`, `bun run <script>`.
Bun loads `.env` automatically; do not add `dotenv`.

## What this is

`cusage` — a CLI over an owned SQLite archive of Claude subscription usage. The
archive is the product; the reporting on top of it is replaceable. See
`README.md` for the data sources and the deduplication rules.

## The constraints that must not be quietly removed

These are here because each of them is exactly the kind of thing a reasonable
refactor deletes.

**`src/tui.ts` is a separate bin target and the only file allowed to import
`react` or `ink`.** The archiver runs hourly under launchd and the statusline
may poll `--json` several times a minute; neither may pay React's startup cost.
If the TUI is ever folded into `cli.ts`, it must be behind a lazy
`await import('./tui.ts')` inside that one command arm and nowhere else.
`tests/cli.test.ts` walks the CLI's import graph and fails if `react` or `ink`
is reachable — keep that test.

**The layering is `query.ts` → data, `format.ts` → strings, `cli.ts` → argv.**
Consequences, all of which are load-bearing:

- `--json` is `JSON.stringify` on a `query.ts` result and never touches
  `format.ts`. A test asserts the JSON output contains no ANSI.
- `format.ts` has no database handle and no I/O, so every view is unit-testable
  without spawning a process.
- The TUI will consume `query.ts` directly. It is not a rewrite of `cli.ts`.

Do not let a query start returning a padded string, and do not let the
formatter start taking a `Database`.

**`requests` is `WITHOUT ROWID` and `request_id` is `''`, never `NULL`.** 228
records corpus-wide have no `requestId`. On a rowid table, primary-key columns
are nullable and NULLs never compare equal, so each of those would re-insert on
every sync — and an idempotency test that re-runs the same data would still
pass. Changing either of these silently reintroduces unbounded duplication.

**Ingest writes are one atomic UPSERT that implements keep-max in SQL.** Not
read-then-decide-then-write. Across 574 files that degrades to "keep last" under
any interruption, and "last" is the smallest streaming snapshot.

**Three rules in `ingest_state`, all of which the naive version gets wrong:**
offsets advance only to the last complete newline; `size < stored_size` or a
changed inode forces a re-read from zero; commit per file, not per run.

**No runtime dependencies.** This is a scoping rule, not a purity rule: it means
the launchd agents have no install surface that can break. Adding one is a
normal decision once it buys something real. The TUI phase adds `ink` and
`react`, and that is expected.

**No automatic network calls.** `cusage pricing --refresh` will be the only
command that touches the network, and only when run by hand.

**Never ingest content.** Tool *names* and token *counts* only. No message
bodies, no tool inputs or results, no prompts, and none of the identity keys in
`~/.claude.json`.

## Fixtures

`fixtures/` is a frozen, scrubbed copy of 24 real transcripts, and it is
committed. Every numeric assertion runs against it — never against live data,
which is appended to continuously and garbage collected.

- Regenerate with `bun run fixture`. That rewrites `MANIFEST.json` (checksums)
  and `BASELINE.json` (expected numbers) together. Regenerating is allowed;
  editing a fixture file by hand is not.
- `BASELINE.json` is computed by a **second, independent** dedup implementation
  inside `tools/make-fixture.ts`. That is deliberate: reading the expected
  numbers out of `src/ingest.ts` would only prove the ingester agrees with
  itself. Keep the two implementations separate.
- Scrubbing is an **allowlist** (`VERBATIM_ENVELOPE`, `KEEP_TYPES`). A denylist
  leaks the first time Claude Code adds a field. If a new field is needed in the
  fixture, add it to the allowlist deliberately and re-run the leak test.
- `tests/fixture.test.ts` re-checks for personal data on every `bun test`, not
  once at generation time.

## launchd

Two agents, installed by `scripts/install-agents.sh` from the templates in
`launchd/`. Full `sync` hourly; `sync --limits-only` every 15 minutes — one job
walks 240 MB, the other reads a cached JSON blob, and sampling a five-hour
window once an hour is worse resolution than the desktop series being archived.

`bun` is invoked by absolute path (`~/.bun/bin/bun`) because node lives behind
an ephemeral fnm multishell path that launchd does not have.

The install script warns if it is run from a Conductor worktree: those are
deleted when the workspace is archived, and the agents would start failing
silently. Re-run it from the canonical checkout after merging.

Logs: `~/Library/Logs/claude-usage/{sync,limits}.log`.

## Numbers to sanity-check against

Corpus as of 2026-09-09 (they grow; the ratios are the useful part):

- 574 transcript files, ~241 MB, 60 of them sub-agent transcripts nested at
  `<project>/<sessionId>/subagents/`. A one-level glob misses those.
- ~18.7K raw assistant records → ~8.8K deduped. **2.12×.** A result near the raw
  count means dedup is off; a result near half the deduped count means it is
  keeping first-seen.
- cost-state: $744.68 across 162 of 506 sessions, with `claude-opus-5[1m]` as
  its own row at $139.79. Note that cost-state records are **cumulative** and
  there are 371 of them — summing every record gives $1652.36, which is wrong.
  Keep max per session.
