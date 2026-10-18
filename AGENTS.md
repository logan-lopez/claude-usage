# AGENTS.md — Instructions for AI Agents in `claude-usage`

Welcome to the **claude-usage** repository. Read the project notes below.

## The project

`cusage` is a CLI over an owned SQLite archive of Claude subscription usage, with a separate Ink
explorer (`cusage-tui`). The archive is the product; the reporting on top of it is replaceable.
Two of its sources are garbage collected, so the archiver is the part that can't be redone later.
Start with `README.md`, then the architecture page for the code you're touching ([Areas](#areas)).
The pages say how the code works now; the archived briefs are its history.

`docs/guide/` is how cusage works as Logan uses it, one page per feature: what he runs and sees,
not how it's built. When a brief changes that (a command, a flag, a screen, a key), update the
guide pages it changes once, before the brief's report, and keep the root README's feature list
in step. Guide pages name what they draw on in a `**Covers:**` line, which `wrap`'s drift check
watches.

Handoff briefs are in `docs/briefs/`. Start with `README.md`; unscheduled ones are in `FUTURE.md`,
and finished ones move to `archive/`.

Logan's notes on cusage are in his Obsidian vault,
`~/Writing/Books/TheBond/Development/Projects/claude-usage/`. They're his ideas: read them as
files, and leave them to him. `Docs/` there is a symlink to `docs/`, so write docs in the repo,
and add nothing under `Docs/`.

### Commands

Default to Bun over Node: `bun <file>`, `bun test`, `bun install`, `bun run <script>`. Bun loads
`.env` automatically; don't add `dotenv`.

| | |
|---|---|
| `bun test` (or `make test`) | the offline suite, against `fixtures/` |
| `bun run typecheck` | `bunx tsc --noEmit` |
| `make build` | compile `dist/cusage` and `dist/cusage-tui` |
| `make install` | rebuild, then atomically replace both in `~/.local/bin` (`BIN_DIR` overrides). Doesn't reload the agents |
| `bun run fixture` | regenerate `fixtures/` from the live corpus, with `MANIFEST.json` and `BASELINE.json` |
| `bun run tools/make-pricing-calibration.ts` | regenerate `fixtures/pricing-calibration.json` from the live archive |
| `./scripts/install-agents.sh`, `./scripts/uninstall-agents.sh` | install or remove the two launchd agents |
| `python3 tools/tui-pty-smoke.py <db>` | PTY smoke test of the TUI (startup, resize, navigation, terminal restore). Use a scrubbed fixture archive, never the live one |
| `bun run tools/refresh-pricing.ts [--rates <file>]` | developer-only: fetch pricing docs, then apply reviewed rates |

### Rules that aren't obvious from the code

Each is the kind of thing a reasonable refactor deletes. The page linked has the reasoning.

- **Only `src/tui.ts` and `src/tui/` may import `react`, `ink` or `@inkjs/ui`.** The CLI runs
  under launchd and the statusline polls it; neither may pay React's startup. `tests/cli.test.ts`
  walks the CLI's import graph; keep it. If the TUI is ever folded into `cli.ts`, it goes behind a
  lazy `await import('./tui.ts')` in that one command arm, and the test becomes a check at startup
  ([overview](docs/architecture/README.md#two-binaries)).
- **`query.ts` → data, `format.ts` → strings, `cli.ts` → argv.** `--json` and `--csv` never load
  `format.ts`; `format.ts` never takes a `Database`; a query never returns a padded string
  ([CLI](docs/architecture/cli.md)).
- **`requests` is `WITHOUT ROWID` and `request_id` is `''`, never `NULL`.** Either change
  silently reintroduces unbounded duplication, and an idempotency test would still pass
  ([Ingest](docs/architecture/ingest.md)).
- **Ingest writes are one atomic keep-max UPSERT**, and `ingest_state` advances only to the last
  complete newline, re-reads from zero on a shrink or inode change, and commits per file
  ([Ingest](docs/architecture/ingest.md)).
- **Never ingest content.** Tool names and token counts only; no bodies, tool inputs or results,
  prompts, or `~/.claude.json` identity keys. Credentials sign one request and are dropped
  ([Ingest](docs/architecture/ingest.md), [Network](docs/architecture/network.md)).
- **One host: `GET https://api.anthropic.com/api/oauth/usage`, only from `src/oauth.ts`.** The
  floor is 3 minutes between *attempts*, persisted in `meta`, `Math.max(180_000, env)`, and
  `--refresh` doesn't bypass it. `refreshFromApi` never throws. No dependency may add a host. Keep
  `tests/refresh.test.ts` ([Network](docs/architecture/network.md)).
- **Never present a stale number as current.** Every limit carries its source and age, meters are
  reconciled per meter by freshness, and disagreements are reported, never averaged
  ([Limits](docs/architecture/limits.md)).
- **Measured and estimated cost never blend, and grouped cost is exact or absent.** Every reader
  of measured cost goes through `MEASURED_COST` ([Cost](docs/architecture/cost.md)).
- **`string-width` is pinned to the exact version Ink resolves, and patched.** A bump silently
  drops the patch; re-create it with `bun patch` rather than deleting the test in
  `tests/tui.test.tsx` ([TUI](docs/architecture/tui.md)).
- **Every numeric assertion runs against `fixtures/`, never live data.** Regenerate the fixture,
  never hand-edit it; scrubbing is an allowlist; `BASELINE.json` comes from a second dedup
  implementation in `tools/make-fixture.ts` — keep the two separate
  ([Fixtures](docs/architecture/fixtures.md)).
- **The suite is offline.** `tests/cli.test.ts` pins `CUSAGE_REFRESH=off`; the one real request
  goes to `127.0.0.1:1`.
- **The installed binaries don't follow source edits.** The agents run `~/.local/bin/cusage`;
  rebuild with `make install` after changes and check `cusage doctor`'s build line
  ([Build and install](docs/architecture/build-and-install.md)).
- **Dependencies are an ordinary decision**, weighed on what they buy: the compiled binary
  carries them. The three rules above about React, `string-width` and the one host still hold.

### Areas

`docs/architecture/` has one page per area, describing the code as it is now (start with [the
overview](docs/architecture/README.md)). Before changing code in an area, read its page. When a
change makes a sentence on a page untrue, fix the page in the same commit. A new area gets a page, a
row here and a pointer in `.claude/rules/` (Claude Code loads the matching one by itself; this table
is the same map for every agent).

| Code | Read first |
| --- | --- |
| `tools/build.ts`, `src/version.ts`, `Makefile`, `launchd/**`, `scripts/**` | [Build and install](docs/architecture/build-and-install.md) |
| `src/cli.ts`, `src/args.ts`, `src/format.ts`, `src/serialize.ts`, `src/doctor.ts`, `src/time.ts`, `src/query.ts` | [The CLI and its reports](docs/architecture/cli.md) |
| `src/pricing.ts`, `src/pricing-snapshot.json`, `tools/refresh-pricing.ts`, `tools/make-pricing-calibration.ts`, `src/query.ts` | [Pricing and cost](docs/architecture/cost.md) |
| `tools/make-fixture.ts`, `fixtures/**`, `tests/fixture.test.ts`, `tests/helpers.ts` | [Fixtures and the test suite](docs/architecture/fixtures.md) |
| `src/ingest.ts`, `src/schema.ts`, `src/paths.ts` | [Ingest and the archive](docs/architecture/ingest.md) |
| `src/limits.ts`, `src/query.ts`, `src/format.ts` | [Limits](docs/architecture/limits.md) |
| `src/oauth.ts`, `src/statusline.ts`, `tests/refresh.test.ts` | [Network](docs/architecture/network.md) |
| `src/tui.ts`, `src/tui/**`, `patches/**` | [The explorer (TUI)](docs/architecture/tui.md) |
