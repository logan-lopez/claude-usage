# The CLI and its reports

`cusage` is a Commander program over `query.ts`. Each command has a human rendering in `format.ts`
and machine output that never loads it.

**Sources:** `src/cli.ts`, `src/args.ts`, `src/format.ts`, `src/serialize.ts`, `src/doctor.ts`, `src/time.ts`, `src/query.ts`

**History:** [brief 01](../briefs/archive/01-archiver-and-session-views.md),
[brief 02](../briefs/archive/02-cli-reports-and-binaries.md)

- `cli.ts` builds the program (`createProgram`).
- `args.ts` parses the shared request filters (`filters`, `readWindow`).
- `time.ts` parses durations and formats ages.
- `format.ts` renders every view.
- `serialize.ts` owns CSV and the streaming export rows.
- `doctor.ts` runs the health checks.

## How it works

**Flags and exits.**

- `--db`, `--json`, `--csv`, `--no-color`, `--refresh` and `--no-refresh` work before or after
  the command.
- Unknown options and invalid grouping values exit 2, and `session` with no match exits 1.
- `doctor` exits 0 when clear, 1 on warnings and 2 when broken.

**Request filters.** `--since <duration|ISO|all>`, `--until <duration|ISO>`, `--project`,
`--model` and a positive-integer `--limit`.

- Project and model matching is case-insensitive and literal: `%` isn't a wildcard.
- Windows are start-inclusive and end-exclusive.
- Session lists and session exports select whole sessions by their last activity, so their totals
  stay lifetime totals.
- Grouped session reports filter individual requests.
- `limits --history` keeps its own inclusive endpoint.

**Coverage.** Every grouped report includes request coverage for the full selection, even when
`--limit` hides groups. Row limits never change coverage or cost totals.
`sessions --by … --json` returns `{ rows, coverage, …metadata }`.

**Attribution.** `attribution --by agent|skill|plugin|mcp|effort|entrypoint|branch|version|model|tool`,
defaulting to `agent`.

- Tool attribution is two flat scans grouped in JavaScript: the filtered requests summed per
  `(session_id, message_id)`, then `tool_calls`, each tool taking a message once however many
  calls it made there. It takes about 200 ms on 93K requests and 103K calls. In SQL, the
  `DISTINCT` and correlated `EXISTS` over the join took 2.6 s, and the best `GROUP BY` shape about
  490 ms, sorting the id strings. `tests/reports.test.ts` keeps the old SQL as a parity oracle.
- Tool groups overlap, because a request can appear under several tools. They count calls, and
  their request-token columns are context, not per-tool consumption.

**Timeline.** `timeline --bucket day|week|month|auto` shares one query with `daily`, `weekly`
and `monthly`.

- Calendar boundaries are UTC and weeks begin Monday.
- An empty bucket is emitted for each selected group.
- `auto` uses the `chooseBucket` ladder.
- The default window is 30 days. It's the same for `cost` and `cache`; `blocks` and
  `limits --history` default to 7 days.

**Export.** `export --table requests|sessions|tools|limits --format json|ndjson|csv` iterates
SQLite rows and respects stdout backpressure.

- All three formats stream, and NDJSON is the default.
- `--json` and `--csv` are shortcuts, and conflicting choices fail.
- Limit samples can't be filtered by project or model.

**CSV.** Quotes commas, quotes and newlines. Report metadata, including coverage, repeats on each
data row.

**`cache`.** `cache --by model|project` shows the cache read/creation ratio, the 5m and 1h creation
counts, and `creation − (5m + 1h)` as a signed reconciliation gap. Nothing is normalized.

**`doctor`** checks:

- both launch agents and their exit status;
- the newest request and limit row ages;
- read-only integrity and file size;
- ingest sources that have disappeared;
- the build stamp;
- credential presence;
- the transcript directory.

Rows older than twice their job interval are broken, and the message says inactivity can also
explain an old request row. Deleted source files are warnings, because the archive is meant to
outlive them. Credentials are never shown. The TUI runs it in a credential-free `archiveOnly`
mode.

## Rules worth keeping

- **Machine paths never load `format.ts`.** `--json` is `JSON.stringify` on a `query.ts` result,
  and `--csv` uses `serialize.ts`. A test asserts JSON output contains no ANSI.
- **`format.ts` takes data, never a `Database`,** and a query never returns a padded string.
- **Never present a derived number as fact.** Server truth and local attribution are separate
  sections, and every grouped view says what it covers.
- **`server_tool_use` counters read 0** even when WebSearch or WebFetch ran: those are client-side
  tools. Don't build a view on them.
- **`ephemeral_5m + ephemeral_1h` doesn't reconcile with `cache_creation_input_tokens`.** The gap
  is about 1K tokens out of 42M. `cache` shows it rather than assuming balance.
- **Post-compaction `cache_read_input_tokens` drops discontinuously.** Don't infer context size
  from it monotonically.
