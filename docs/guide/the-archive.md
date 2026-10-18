# The archive

cusage copies your Claude usage into a SQLite archive you own, before Claude Code and the desktop
app delete it, and every report reads from that archive.

**Covers:** [Ingest](../architecture/ingest.md), [Build and install](../architecture/build-and-install.md), [CLI](../architecture/cli.md)

## Why it exists

Transcripts in `~/.claude/projects/` are deleted after about 70 days. The desktop app keeps only
30 days of limit history. Once either is gone, it's gone. The archive keeps every token count, so
reports can be rebuilt or rewritten at any time, but data that ages out before a sync can't come
back.

## Installing

From the checkout:

```bash
bun install --frozen-lockfile
make install                 # builds cusage and cusage-tui into ~/.local/bin
cusage sync                  # the first sync takes a couple of seconds
./scripts/install-agents.sh  # the two background agents
```

The installed programs carry everything they need. They don't follow edits to the checkout:
after changing the source, run `make install` again.

## Keeping it current

Two launchd agents run `~/.local/bin/cusage` in the background:

- every hour, a full `cusage sync`, which reads new transcript lines and snapshots the limits;
- every 15 minutes, `cusage sync --limits-only`, which snapshots the limits and fetches the live
  reading when the last one is over 15 minutes old.

Their logs are in `~/Library/Logs/claude-usage/` (`sync.log`, `limits.log`). You can run
`cusage sync` by hand at any time; running it twice changes nothing. `--limits-only` skips the
transcripts, and `--no-backfill` skips the desktop and Glaze history files.

`./scripts/uninstall-agents.sh` removes the agents and leaves the archive alone.

## Where it lives

`~/.local/share/claude-usage/usage.db`, outside the repo, because it's data. `--db <path>` or
`CUSAGE_DB` points any command at another archive.

## Checking on it

`cusage status` shows what the archive holds: requests and sessions, how many sessions have
Claude Code's own cost record, tool calls, transcript files tracked, limit samples, the date range
covered and token totals.

`cusage doctor` checks that it's healthy:

- both agents and how they last exited;
- how old the newest request and limit rows are;
- database integrity and size;
- transcript files that have disappeared since they were read;
- whether the installed build matches the checkout;
- whether credentials are present (never shown);
- whether the transcript directory exists and isn't empty.

Each check is ok, a warning or broken, and the exit code is 0, 1 or 2 to match. A request row
more than two hours old (or a limit row more than 30 minutes old) is marked broken, but an old
request row can just mean you haven't used Claude Code lately, and the message says so. A deleted
transcript is only a warning, since the archive is meant to outlive it. To compare the build
against a different checkout, use `cusage doctor --repo <path>`.
