# Brief 04: Move the project's knowledge onto the layout

**Size:** L. Docs only, but about twenty pages plus a code check of each.

Read `CLAUDE.md`, [`README.md`](README.md), `~/.claude/skills/brief/LAYOUT.md` (Project knowledge,
Architecture pages, The guide, The root README, The Areas table and rules) and
`~/.claude/skills/brief/MIGRATE.md` first. MIGRATE.md is the procedure, and this brief is the
claude-usage-specific part of it. `~/Code/personal/inn` is the worked example: its `AGENTS.md`,
`docs/architecture/README.md` and `docs/guide/README.md` show the finished shape.
No prerequisites. `brief-init` landed in `628fb6d`.

## Goal

The project's knowledge currently lives in three places that overlap:

- an OKF bundle in `knowledge/`: eight architecture concepts and one findings page;
- a long constraints section in `CLAUDE.md`;
- a 490-line root `README.md` that mixes what the project is with how every command behaves.

This brief gives each kind of knowledge its one home from LAYOUT.md:

- `docs/architecture/` for how the code works;
- `docs/guide/` for how cusage behaves as Logan uses it;
- a short root README;
- `AGENTS.md` for rules and commands, with `CLAUDE.md` reduced to `@AGENTS.md`.

OKF comes out entirely. After this, `wrap`'s drift check can watch every page.

## Decisions already made

Decided with Logan, 2026-10-17 (the mapping review). Don't revisit them silently.

- **Architecture pages:** these nine, with these Sources:

  | Page | Covers | **Sources:** |
  | --- | --- | --- |
  | `README.md` | Overview: data flow (sources → ingest → archive → query → format/serialize/TUI), the layering, the separate TUI bin, a module map, where the archive lives | none |
  | `ingest.md` | Transcript discovery (sub-agents two levels deep), dedup key and tie-breaks, `WITHOUT ROWID` and `''`, keep-max UPSERT, the three `ingest_state` rules, roll-up scoped to read files, migrations, no content, corpus numbers | `src/ingest.ts`, `src/schema.ts`, `src/paths.ts` |
  | `limits.md` | Limit sources (oauth-live, oauth-cache, desktop history, glaze), `currentLimits` by freshness, disagreements, stale labelling, peak buckets with null gaps, `blocks` meter cycles | `src/limits.ts`, `src/query.ts` |
  | `network.md` | `oauth.ts` as the only `fetch`, `MIN_REFRESH_MS` on attempts in `meta` with the atomic claim, soft failures, credentials (keychain first, 5 s kill), `redact`, the statusline worker, the offline suite | `src/oauth.ts`, `src/statusline.ts`, `tests/refresh.test.ts` |
  | `cost.md` | Price snapshot, measured vs estimated, exact-or-absent grouped cost, fallback-priced cost-state, the estimator audit and its frozen calibration table, `tools/refresh-pricing.ts` | `src/pricing.ts`, `src/pricing-snapshot.json`, `tools/refresh-pricing.ts`, `tools/make-pricing-calibration.ts`, `src/query.ts` |
  | `cli.md` | Commander, global flags, exit codes, machine output never loading `format.ts`, export streaming, UTC timeline, attribution coverage and the tool join, `cache`, `doctor` | `src/cli.ts`, `src/args.ts`, `src/format.ts`, `src/serialize.ts`, `src/doctor.ts`, `src/time.ts`, `src/query.ts` |
  | `build-and-install.md` | `bun build --compile`, ad hoc codesign, build stamps, `make install`, the two launchd agents and their logs, keychain under launchd, doctor's build check | `tools/build.ts`, `src/version.ts`, `Makefile`, `launchd/`, `scripts/` |
  | `tui.md` | Read-only open and the `query_only` fallback, `data_version` polling, the module split, key routing via a layout effect, the `string-width` patch, OSC 11 theme detection, `R` refresh | `src/tui.ts`, `src/tui/`, `patches/`, `tools/tui-pty-smoke.py` |
  | `fixtures.md` | The frozen scrubbed fixture, allowlist scrubbing, the independent baseline, `MANIFEST.json`, the leak test on every run, the offline suite, the pricing calibration fixture | `tools/make-fixture.ts`, `fixtures/`, `tests/fixture.test.ts`, `tests/helpers.ts` |

  `src/query.ts` appears in three Sources lines on purpose. It holds the functions all three
  pages describe, so drift flags all three when it changes.
- **Guide pages:** eight pages plus `docs/guide/README.md` as the index:

  | Page | Covers |
  | --- | --- |
  | `the-archive.md` | Install, `sync`, the agents, `doctor`, `status`, where the archive lives |
  | `limits.md` | `limits`, `--history`, the limit the tray doesn't show, the refresh flags, `statusline` |
  | `sessions.md` | `session`, `sessions --by`, `attribution` |
  | `cost.md` | `cost`, and what `$`, `~$`, `+` and "unavailable" mean |
  | `over-time.md` | `daily`/`weekly`/`monthly`/`timeline`, `blocks`, `cache` |
  | `scripting.md` | `--json`, `--csv`, `export`, exit codes |
  | `explorer.md` | The TUI: screens, keys, theme, refresh |
  | `trusting-the-numbers.md` | The README's "Known limits" and "What this tool will not do", from the user's side |
- **Root README:** rewritten per LAYOUT.md's "The root README". It keeps:
  - a paragraph on what cusage is;
  - "What it's built around", about five lines: the archive is the product, never ingest
    content, one endpoint, never a stale number as current, grouped cost exact or absent;
  - a feature list that links into the guide;
  - requirements (macOS, Bun 1.3.3 for development);
  - install and run;
  - where the rest is.

  `## Status` becomes a pointer to `docs/briefs/README.md`. Behavior moves to the guide. The
  frozen calibration table moves to `docs/architecture/cost.md`.
- **`AGENTS.md`** follows inn's shape: `## The project` (the project paragraph), `### Commands`,
  `### Rules that aren't obvious from the code` and `### Areas`.
  - The rules section is the current `CLAUDE.md` constraints condensed to a line or two each,
    each linking the page that holds the reasoning.
  - `CLAUDE.md` becomes `@AGENTS.md` and nothing else.
  - The current `CLAUDE.md` holds nothing Claude-only, so all of it moves.
- **OKF comes out:**
  - `knowledge/`;
  - the OKF block and the "Powered by OKF" header in `AGENTS.md`;
  - `.agents/skills/okf-memory/` (tracked, added in `71dd8bb` "Adding OKF bootstrap");
  - the Makefile's `validate`, `search` and `help` targets and `OKF_BIN`/`BUNDLE`.

  In the Makefile, `test` runs only `bun test`, and `all` becomes `test`.
- **Dropped:** OKF's `log.md`, its `index.md` files and every concept's provenance frontmatter
  (`generated:`, `sources:`, `type:`). History is in git and the archived briefs.
- **Obsidian:** point claude-usage's line in `Projects.md` at
  `[[claude-usage/Docs/guide/README|claude-usage]]`, with a one-line description. Change nothing
  else in the vault.

## Already checked

All on 2026-10-17.

- **Staleness.** Code commits since each concept last changed (`git log <last>..HEAD -- <code>`):
  | Concept | Commits | Which |
  | --- | --- | --- |
  | `limits-reconciled-by-freshness` | 4 | `44111c3`, `1a3f0e5`, `9d6d28d`, `0ee1199` |
  | `without-rowid-request-key` | 3 | `e9d9174`, `44111c3`, `1a3f0e5` |
  | `grouped-cost-is-exact-or-absent` | 2 | `9d6d28d`, and `0ee1199`, the fallback-priced cost-state fix, which changes what counts as measured |
  | `session-rollup-scoped-to-read-files` | 1 | `1a3f0e5` |
  | `live-oauth-fetch-with-guard` | 1 | `9d6d28d` |
  | `ink-session-explorer` | 1 | `177065c`, the palette and theme detection; its last content edit was `403def6` |
  | `cli-reports-and-binary-install`, `independent-fixture-baseline` | 0 | |

  Give the pages built from the first three, and `tui.md`, the closest check.
- **No other OKF wiring.** There's no `.mcp.json` and no CI directory. `okf` exists only as a
  binary in `~/.local/bin`, and nothing in `~/Dev/dotfiles` configures it for this repo.
- **`.cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc`** is a tracked symlink to
  `../../CLAUDE.md`. Once `CLAUDE.md` is `@AGENTS.md`, Cursor would get one useless line, so
  repoint the link to `../../AGENTS.md`.
- **`.claude/worktrees/`** holds a stale worktree with its own copies of the old docs. It's
  excluded in `.git/info/exclude` and untracked, so it doesn't count. Leave it alone.
- **`areas.py`** is at `~/.claude/skills/brief/scripts/areas.py`. Its usage line:
  `python3 -I areas.py <repo root> [doc dir ...]`. It writes the section where `### Areas` is and
  writes nothing if no page has a Sources line.
- **Obsidian.** `~/Writing/Books/TheBond/Development/Projects/claude-usage/Docs` already links to
  the repo's `docs/`. There's no Project Doc to retire, and `Projects.md` has no claude-usage line
  yet.
- **`okf validate knowledge --strict`** passes at `628fb6d`. Nothing in `knowledge/` is broken
  going in, just possibly stale.

## Open questions

None. The mapping was approved in full.

## Shape

- `docs/architecture/README.md` and `docs/architecture/<eight pages>.md` follow LAYOUT.md's
  template: title, a summary, `**Sources:**`, `**History:**`, then How it works / Rules worth
  keeping / Decisions as each page needs.
  - **History:** links the archived brief or briefs the area came from (`../briefs/archive/0N-….md`).
  - Rewrite from the concepts, the README and the code. Don't copy concepts across with their
    frontmatter.
  - Measurements that a decisions-table row leans on go under the page's `## Decisions`, for
    example the $90 → $226 grouped-cost figure, the 27-hour stale cache, and the 228
    requestId-less records.
  - The 2026-09-09 findings page has no page of its own: its numbers go to `ingest.md`, `limits.md`
    and `cost.md` where they're evidence.
  - `CLAUDE.md`'s "Numbers to sanity-check against" goes to `ingest.md`.
- `docs/guide/README.md` and the eight guide pages follow LAYOUT.md's "The guide":
  - written for a person, in the present tense;
  - no function names or brief numbers;
  - a `**Covers:**` line linking the architecture pages each page draws on.

  The README's example `limits` and `limits --history` output belongs in `guide/limits.md`.
- `AGENTS.md` is rewritten whole (Decisions, above). The project paragraph names:
  - the architecture pages and the Areas table;
  - the guide, and that a brief changing what Logan sees updates it once before its report;
  - the briefs line from LAYOUT.md;
  - Logan's Obsidian folder, `~/Writing/Books/TheBond/Development/Projects/claude-usage/`,
    which is his to edit (`Docs/` there is a symlink, so add nothing under it).

  The Commands table:
  | Command | What it does |
  | --- | --- |
  | `bun test` | the offline suite |
  | `bun run typecheck` | type check (`bunx tsc --noEmit`) |
  | `make build` | compile both binaries |
  | `make install` | rebuild and replace the binaries in `~/.local/bin` |
  | `bun run fixture` | regenerate the fixture |
  | `./scripts/install-agents.sh` | install the launchd agents |
  | `python3 tools/tui-pty-smoke.py <db>` | PTY smoke test of the TUI |

  `launchd` facts (schedules, logs) go to `build-and-install.md`. The rule that the installed
  binary doesn't follow source edits stays in AGENTS.md as a rule.
- `.claude/rules/<page>.md`, one pointer per architecture page, written by `areas.py` and
  committed.
- `docs/briefs/README.md`:
  - **Where things stand:** replace the `knowledge/` bullet;
  - **Open → Done:** move brief 04, once Logan has reviewed it (that's `wrap`'s job, not this
    brief's).
- Fix every remaining reference to `knowledge/`, `okf` or the moved README sections:
  `rg -n 'knowledge/|okf|OKF'` outside `docs/briefs/archive/`. The archive records its time and
  stays as written.

## Out of scope

- Any change under `src/`, `tests/`, `tools/` or `fixtures/`. A wrong sentence found during the
  code check is fixed in the page, not in the code. A real bug found in the code goes in the report
  for Logan.
- `docs/briefs/archive/`, beyond what `brief-init` already did.
- Logan's other notes in the Obsidian folder, and anything in `~/.claude` or `~/Dev/dotfiles`.
- Rebuilding or reinstalling the binaries. Nothing shipped changes.

## Build order

1. **Architecture pages.** Write all nine. Then check them against the code: split the eight
   area pages among a few subagents (about three pages each), each told to:
   - verify every claim against the code;
   - fix wrong sentences in place with the smallest edit;
   - report what it changed (with file:line), what it couldn't verify, and anything missing.

   Read the reports and settle what's left.
2. **AGENTS.md, CLAUDE.md and OKF out.**
   - Rewrite `AGENTS.md`, set `CLAUDE.md` to `@AGENTS.md`, and repoint the `.cursor` symlink.
   - Add `### Areas` and run `areas.py`. Read what it wrote, and narrow any Sources line whose
     row matches half the repo.
   - `git rm -r knowledge .agents/skills/okf-memory`, then edit the Makefile.
3. **Guide.** Write the index and eight pages, then check them the same way: subagents by page,
   every claim against the code and the CLI's `--help`.
4. **Root README.** Rewrite it, then sweep the references.
5. **Obsidian.** The `Projects.md` line.

## Acceptance

- `python3 -I ~/.claude/skills/brief/scripts/checklinks.py .`: 0 broken.
- `rg -n 'knowledge/|okf|OKF' -g '!docs/briefs/archive/**' -g '!.claude/worktrees/**' .`: no hits
  except this brief.
- `test ! -e knowledge && test ! -e .agents/skills/okf-memory`.
- `cat CLAUDE.md` prints exactly `@AGENTS.md`. `readlink .cursor/rules/*.mdc` prints
  `../../AGENTS.md`.
- `make test` runs `bun test` and passes, with no `okf` invoked.
- `python3 -I ~/.claude/skills/brief/scripts/areas.py .` run a second time changes nothing
  (`git status` is the same before and after).
- Every architecture page has a `**Sources:**` line, and every guide page has a `**Covers:**`
  line and an entry in `docs/guide/README.md`.
- After the commit, `python3 -I ~/.claude/skills/brief/scripts/drift.py .` reports 0 pages to
  check.

Logan checks by hand:

- the guide reads right in Obsidian through `claude-usage/Docs/guide/README.md`;
- the `Projects.md` line links there.

Then stop. Per MIGRATE.md, don't commit until Logan says so. Show `git status`, a summary (pages
written, what each reviewer fixed, claims left unverified, anything for Logan) and the commit
message you'd use. Docs only, on `main`, no push.

## Report

Done on `main`, 2026-10-17, in the session that wrote the brief. Not yet committed: per
MIGRATE.md, Logan says when. Session measured by `sessions.py`: 18 active minutes (M), including
the `brief-init` pass that came before.

**Written**

- `docs/architecture/`: the README plus eight pages, exactly as in Decisions.
- `docs/guide/`: the README plus eight pages, exactly as in Decisions.
- The root README is rewritten.
- `AGENTS.md` is rewritten, with its Areas table and `.claude/rules/` (eight pointers)
  generated by `areas.py`.
- `CLAUDE.md` is now `@AGENTS.md`.
- The `.cursor` rule symlink is repointed at `AGENTS.md`.
- The OKF pieces are removed: `knowledge/`, `.agents/skills/okf-memory/`, and the Makefile
  targets. `all` and `test` now run `bun test`.
- The claude-usage line is added to `Projects.md` in the vault.

**What the code checks changed.** Five subagents, one per group of pages, made about 45 small
edits. The ones that corrected a real misstatement:

- `sync` snapshots limits *before* ingesting, not after.
- `weekly_scoped` *is* on disk, in Claude Code's rarely refreshed cache (`oauth-cache`). "Nowhere
  on disk" was wrong in the old concept, the old README and the first drafts. It's corrected in
  `limits.md`, `network.md`, `guide/limits.md` and the root README.
- Glaze is re-read on every sync, not backfilled once.
- `sessions_unpriced` counts sessions with no measured cost, not split ones.
- `cusage cost` prints `$` with an `estimated` basis column; `~$` and `unavailable` appear only
  in the explorer.
- A fallback-priced cost record falls through to the estimate rather than making the whole
  session unpriced.
- The explorer does write: `R` stores the limits it fetches.
- The CLI ignores `NO_COLOR`. Only `--no-color`, or output that isn't a terminal, turns colour
  off. Only the TUI honours `NO_COLOR`.
- `session <id>` also takes a slug, and an ambiguous prefix exits 2.
- `attribution --by` has ten dimensions, not five.
- The build uses `Bun.build` with `compile`, not the `bun build` CLI.

**Deviations**

- `**Sources:**` and `**Covers:**` lines are kept on one line. `areas.py` reads only the first
  line of a wrapped one, which had dropped `src/time.ts`, `src/query.ts` and
  `tools/make-pricing-calibration.ts` from two rows. That's already logged in
  `~/Dev/dotfiles/IDEAS.md`.
- `limits.md` gained `src/format.ts` in its Sources, because it states two rendering rules that
  live there.
- `tui.md` dropped `tools/tui-pty-smoke.py` from its Sources, because the page doesn't describe
  it. The script is in AGENTS.md's Commands table.

**Environment, not code.** `bun test` failed at first. `node_modules` was stale, with
`string-width` 8.2.0 and a second copy nested under ink. That's the exact failure
`tests/tui.test.tsx` guards. `rm -rf node_modules && bun install --frozen-lockfile` fixed it, and
the suite is 139 pass, 0 fail. No tracked file changed.

**For Logan**

- **The frozen pricing calibration predates `MEASURED_COST` (0ee1199).** Its 166 "measured"
  sessions may include fallback-priced totals that the generator would now drop. Regenerating it
  changes every frozen figure and the exact assertions in `tests/pricing.test.ts`.
  `docs/architecture/cost.md` notes the caveat. Whether to regenerate is your call, and it would
  be its own brief.
- **The CLI not honouring `NO_COLOR`** may or may not be intended. The guide now describes it
  as it is.
- **Unverifiable from code** (historical measurements, kept as dated):
  - the 2026-09-09 corpus numbers;
  - the 39 ms / 98 ms startup times;
  - the string-width figures (106 → 12 ms, the U+2FFFF sweep);
  - r=0.69 and r=0.04.
- **Gaps the reviewers listed but I didn't add.** They're reference-level detail, and `--help`
  covers most of it:
  - extra environment overrides;
  - CSV line endings;
  - `blocks`' reset labels;
  - the Sessions `f` menu's "Clear all".
