---
type: Decision
title: The no-network rule is replaced by one endpoint behind a 3-minute floor
description: cusage fetches GET /api/oauth/usage on a schedule because weekly_scoped exists in no local file, with a hard attempt floor persisted in meta so it holds across processes.
generated: { by: agent/codex, at: 2026-09-10T00:54:25Z }
sources: ["README.md", "src/query.ts", "src/limits.ts", "approved phase 3-4 user briefing"]
---

## Decision

`src/oauth.ts` is the only shipped file permitted to call `fetch`, and it calls exactly
one endpoint: `GET https://api.anthropic.com/api/oauth/usage`. `limits` and
`sync` refresh when the archived copy is older than 15 minutes; `--refresh`
forces a check, `--no-refresh` or `$CUSAGE_REFRESH=off` keeps a run local. The
15-minute launchd agent does this on a schedule.

Every attempt passes `MIN_REFRESH_MS`, a floor of 3 minutes.

## Why the original rule was wrong

The project began with "no automatic network calls, ever", on the premise that
`~/.claude.json → cachedUsageUtilization` was as good as the endpoint. Measured
on 2026-09-09: across a full day of heavy Claude Code use, that key was
refreshed **once**, producing a single distinct snapshot 27.5 hours old.
`cusage limits` therefore reported `weekly_scoped Fable 53%` and `weekly_all
37%` while the app on screen showed 74% and 54%.

`weekly_scoped` is the constraint that actually binds, and it exists in no local
file. It is absent from `plan-usage-history.json` (which carries only
`{t, org, u:{fh, sd, xu}}` — verified across the union of keys in all 1,976
samples), absent from the desktop app's leveldb, and absent from its Session
Storage. The app holds it in memory. There is no local route to it.

The rule was protecting a number that was wrong.

## The clauses that replaced it, and why each one is load-bearing

- **Attempts, not successes.** The floor is keyed on attempts and the timestamp
  is written *before* the request, so a 401 or a hung endpoint cannot be
  retried faster than a success, and a slow endpoint cannot become a retry
  storm.
- **Persisted in `meta`, not a module variable.** A launchd agent and a
  statusline poll are separate processes. A floor that only holds within one
  process is not a floor.
- **`Math.max(180_000, env)`, not `??`.** `$CUSAGE_MIN_REFRESH_MS` can raise the
  floor and cannot lower it. `--refresh` skips the *staleness* check and not the
  floor. `tests/refresh.test.ts` proves this by spawning a child process with
  `CUSAGE_MIN_REFRESH_MS=1000` and asserting it still reads 180000.
- **A blocked attempt does not extend the window.** Otherwise a caller in a loop
  keeps the guard permanently closed and it never refreshes at all.
- **Failures are soft.** `refreshFromApi` never throws. A caller asking for
  limits has a local archive and prints it, with one line on stderr.

## Credentials

Read from the macOS login keychain item `Claude Code-credentials` first, falling
back to `~/.claude/.credentials.json`; an unexpired token beats an expired one
regardless of store order. On the development machine the file was three weeks
stale while the keychain was current, which is why store order alone is not the
rule.

The token signs one request and is dropped. It is never written to the archive,
never logged, and `redact()` strips `sk-ant-*` from anything leaving the module.
`fromKeychain` kills the `security` subprocess after 5s: if the item's ACL ever
changes, a LaunchAgent must not hang forever on a keychain dialog. Verified
working under launchd in the GUI session.

## Testing

The suite makes no remote calls. `tests/cli.test.ts` pins `CUSAGE_REFRESH=off`;
the one test that drives a real request points at `127.0.0.1:1`, which refuses
instantly and thereby proves the attempt was recorded, the failure was soft, and
the next call was refused by the guard.

# Related Concepts
- [Measured shape of the local Claude Code corpus, 2026-09-09](../findings/corpus-shape-2026-09-09.md): The measurements that showed the cached snapshot was 27h stale and weekly_scoped is nowhere on disk

## Phase 3-4 update (2026-09-10 UTC)

The refresh attempt is now claimed inside an immediate SQLite transaction.
The previous separate read/write could race across processes. Four concurrent
no-token CLI processes are tested offline: one claims the attempt, three see
the guard. The statusline emits its archived reading and starts an unreferenced
CLI worker; the worker survives parent exit and shares the same floor.

The only exception outside shipped code is `tools/refresh-pricing.ts`, invoked
manually to download pricing documentation. It is never imported or scheduled.

Sources: `src/limits.ts`, `src/statusline.ts`, `tests/refresh.test.ts`, `tests/cli.test.ts`.
