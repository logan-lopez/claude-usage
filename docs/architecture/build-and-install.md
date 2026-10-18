# Build and install

cusage ships as two self-contained executables in `~/.local/bin`, and two launchd agents run the
CLI from there. Neither the checkout nor `node_modules` is needed at run time.

**Sources:** `tools/build.ts`, `src/version.ts`, `Makefile`, `launchd/`, `scripts/`

**History:** [brief 02](../briefs/archive/02-cli-reports-and-binaries.md)

`tools/build.ts` compiles `dist/cusage` and `dist/cusage-tui` and stamps them. `src/version.ts`
reads the stamp. `make install` copies both binaries into place. `scripts/install-agents.sh`
renders the plists in `launchd/` and loads them.

## How it works

**Building.** `Bun.build` with `compile` produces one binary per entry point, each with the runtime
and every dependency inside it.

- Each build embeds its Git SHA, build time, source checkout path and a dirty flag through
  `CUSAGE_BUILD_*`.
- A source invocation is deliberately unstamped.
- On macOS, `tools/build.ts` re-signs each binary ad hoc after compiling.

**Installing.** `make install` rebuilds, then replaces `~/.local/bin/cusage` and `cusage-tui`
atomically (install to `.new`, then `mv`). `BIN_DIR` overrides the directory. It doesn't reload
the launch agents.

**The agents.**

| Agent | Runs | Every |
| --- | --- | --- |
| `com.logan.claude-usage` | `cusage sync` | 3600 s |
| `com.logan.claude-usage-limits` | `cusage sync --limits-only` | 900 s |

- Both run `~/.local/bin/cusage` with `$HOME` as the working directory.
- Logs go to `~/Library/Logs/claude-usage/{sync,limits}.log`.
- `scripts/uninstall-agents.sh` removes them and never touches the archive.

**Stamps and `doctor`.** `cusage doctor` compares the binary's stamp with the checkout's HEAD.
`--repo <path>` or `CUSAGE_REPO` picks the checkout. A missing checkout, a different SHA or a
dirty build is a warning, not a silently trusted build.

## Rules worth keeping

- **The installed binary doesn't follow source edits.** Rebuild and reinstall after changes, and
  check `doctor`'s build line.
- **Agents never run Bun or a worktree's source file.** Archiving a worktree must not remove the
  agents' executable or working directory. That's why the path is fixed in `~/.local/bin`.
- **Two schedules, on purpose.**
  - The full sync walks the whole transcript tree (about 240 MB), so it runs hourly.
  - The limits run reads one cached JSON blob and fetches once, so it runs every 15 minutes:
    sampling a five-hour window hourly is worse resolution than the desktop series being
    archived.
  - The 15-minute agent is also what builds the `weekly_scoped` history on a schedule.
- **Dependencies are an ordinary decision.** `bun build --compile` answers the old reason for "no
  runtime dependencies" (a launchd agent failing on a missing or half-installed `node_modules`)
  better than abstinence did. Two things don't follow from that: React and Ink stay out of the CLI
  ([architecture overview](README.md#two-binaries)), and no dependency may add a second network
  host ([Network](network.md)).

## Decisions

- **Startup.** The compiled CLI starts in about 39 ms, against about 98 ms for
  `bun run src/cli.ts`. The statusline polls it several times a minute.
- **Ad hoc re-signing.** Bun 1.3's compiled output fails `codesign -v` ("code or signature have
  been modified"). On arm64 macOS the kernel kills such an executable at exec with SIGKILL (exit
  137) before it prints anything.
