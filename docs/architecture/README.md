# cusage: architecture

How cusage works now, one page per area. The Areas table in [`AGENTS.md`](../../AGENTS.md#areas)
says which page goes with which code. History is in the archived briefs (`docs/briefs/archive/`).

`cusage` is a CLI over an owned SQLite archive of Claude subscription usage. The archive is the
product; the reporting on top of it is replaceable. Two of its sources are garbage collected
(transcripts after ~70 days, the desktop app's history after 30), so the archiver is the part that
can't be rebuilt later.

## Data flow

```
transcripts, cost-state ──► ingest.ts ─┐
~/.claude.json cache ──────► limits.ts ─┤
desktop / Glaze history ──► limits.ts ─┼──► usage.db ──► query.ts ──┬──► format.ts ──► cli.ts (human)
GET /api/oauth/usage ─────► oauth.ts ──┘   (schema.ts)  (plain data)├──► JSON.stringify / serialize.ts (--json, --csv)
                                                                    └──► src/tui/ (the explorer)
```

- `sync` snapshots the limit sources and then runs ingest. The hourly launchd agent runs it in full; the
  15-minute agent runs `sync --limits-only`.
- The archive is `~/.local/share/claude-usage/usage.db`, outside the repo because it's data.
  `$CUSAGE_DB` or `--db` overrides it, and `src/paths.ts` is the only place any source path is
  spelled out. Each one has its own environment override, which is how the tests point the whole
  tool at `fixtures/`.

## Layering

`query.ts` returns data, `format.ts` turns data into strings, and `cli.ts` turns argv into calls.

- `--json` is `JSON.stringify` on a `query.ts` result, and `--csv` goes through
  `serialize.ts`. Neither machine path loads `format.ts`.
- `format.ts` has no database handle and does no I/O, so every view is unit-testable without
  spawning a process.
- The TUI consumes `query.ts` directly. It is not a rewrite of `cli.ts`.

A query never returns a padded string, and the formatter never takes a `Database`.

## Two binaries

`src/cli.ts` and `src/tui.ts` compile to separate executables (`cusage`, `cusage-tui`). Only
`src/tui.ts` and `src/tui/` may import `react`, `ink` or `@inkjs/ui`. The CLI runs hourly under
launchd and the statusline polls it, so neither may pay React's startup.
`tests/cli.test.ts` walks the CLI's import graph and fails if React or Ink is reachable.

## Modules

| Module | What it does | Page |
| --- | --- | --- |
| `src/ingest.ts`, `src/schema.ts`, `src/paths.ts` | Transcript discovery, dedup, the archive schema and its migrations | [Ingest](ingest.md) |
| `src/limits.ts` | Limit sources, snapshotting and backfill, the refresh guard | [Limits](limits.md), [Network](network.md) |
| `src/oauth.ts`, `src/statusline.ts` | The one endpoint, credentials, the statusline's background refresh | [Network](network.md) |
| `src/pricing.ts`, `src/pricing-snapshot.json` | Price table and the estimator | [Cost](cost.md) |
| `src/query.ts` | Every read: sessions, groups, cost, limits, timeline, blocks, cache, export | [Cost](cost.md), [Limits](limits.md), [CLI](cli.md) |
| `src/cli.ts`, `src/args.ts`, `src/format.ts`, `src/serialize.ts`, `src/doctor.ts`, `src/time.ts` | Commands, flags, rendering, machine output, diagnostics | [CLI](cli.md) |
| `tools/build.ts`, `src/version.ts`, `Makefile`, `launchd/`, `scripts/` | Binaries, build stamps, launch agents | [Build and install](build-and-install.md) |
| `src/tui.ts`, `src/tui/` | The Ink explorer | [TUI](tui.md) |
| `tools/make-fixture.ts`, `fixtures/`, `tests/` | The frozen fixture and the offline suite | [Fixtures](fixtures.md) |

## Network

Shipped code contacts one host and one endpoint, `GET https://api.anthropic.com/api/oauth/usage`,
from `src/oauth.ts` only, behind a 3-minute floor between attempts. See [Network](network.md).
