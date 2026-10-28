# cusage — Claude subscription usage explorer

Claude Pro/Max usage is visible only as a rough percentage: no token-level view, no per-session
attribution, no history, and the API console doesn't cover subscriptions at all. The local data
that holds far more than that is being deleted as you go. Transcripts age out after about 70 days,
and the desktop app keeps 30 days of limit history. `cusage` copies all of it into a SQLite
archive you own and answers questions against that: where usage went, what it would cost on the
API, how it's trending, and how close a limit is. `cusage-tui` browses the same archive.

## What it's built around

- **The archive is the product.** Reporting can be rebuilt at any time; data that ages out is
  gone, so the archiver runs on a schedule.
- **Never ingest content.** Tool names and token counts only: no message text, prompts or tool
  results.
- **One network endpoint.** The only host contacted is `api.anthropic.com/api/oauth/usage`, at
  most once every 3 minutes, because the limit that usually binds is on disk only in a cache
  Claude Code rarely refreshes.
- **Never present a stale number as current.** Every limit carries its source and its age.
- **Measured cost is exact or absent.** It's never blended with estimates, and never split across
  groups by guesswork.

## What it does

- [Keeps the archive](docs/guide/the-archive.md): `sync`, two background agents, `status` and
  `doctor`.
- [Shows limits](docs/guide/limits.md): every meter with its source and age, the per-model
  limit the tray doesn't show, history, and a statusline.
- [Breaks down sessions](docs/guide/sessions.md): one chat's tokens and cost, chats grouped by
  project or model, and attribution by agent, skill, MCP server or tool.
- [Prices usage](docs/guide/cost.md): measured from Claude Code's own records, estimated where
  there are none, and never mixed.
- [Plots it over time](docs/guide/over-time.md): daily to monthly totals, observed five-hour
  cycles, and cache ratios.
- [Feeds scripts](docs/guide/scripting.md): JSON, CSV and a streaming export.
- [Browses it](docs/guide/explorer.md) in a terminal explorer, from a day's output or a
  breakdown by project, skill or tool down to the sessions behind it.
- [Says what it can't tell you](docs/guide/trusting-the-numbers.md).

## Requirements

macOS (the agents are launchd jobs, and credentials come from the login keychain).
[Bun](https://bun.com) 1.3.3 to build. The installed programs embed Bun and every dependency,
so neither the checkout nor `node_modules` is needed to run them.

## Install and run

```bash
bun install --frozen-lockfile
make install                 # cusage and cusage-tui into ~/.local/bin
cusage sync                  # first sync
./scripts/install-agents.sh  # hourly sync, plus a limits snapshot every 15 minutes
cusage limits
cusage session --last
cusage-tui
```

The archive is `~/.local/share/claude-usage/usage.db` (`--db` or `CUSAGE_DB` to override).
After changing the source, run `make install` again; the installed programs don't follow the
checkout.

## Where the rest is

- [The guide](docs/guide/README.md): how each feature works as you use it.
- [Architecture](docs/architecture/README.md): how the code works, one page per area.
- [Briefs](docs/briefs/README.md): status, open work and the decisions already made.
- [`AGENTS.md`](AGENTS.md): commands and the rules for working in the repo.
