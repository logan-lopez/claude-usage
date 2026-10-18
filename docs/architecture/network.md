# Network

cusage contacts one endpoint, `GET https://api.anthropic.com/api/oauth/usage`, behind a floor of
3 minutes between attempts that holds across processes. It does so because `weekly_scoped`, the
limit that usually binds, exists on disk only in a cache Claude Code rarely refreshes.

**Sources:** `src/oauth.ts`, `src/statusline.ts`, `tests/refresh.test.ts`

**History:** [brief 02](../briefs/archive/02-cli-reports-and-binaries.md)

- `oauth.ts` reads the token (`readToken`, `fromKeychain`, `fromFile`, `pickToken`), makes the
  request (`fetchUsage`) and scrubs errors (`redact`).
- `refreshFromApi` in `src/limits.ts` owns the floor and records the result as an `oauth-live`
  sample.
- `statusline.ts` starts the background refresh for the statusline.

## How it works

- **When it fetches.** `limits` and `sync` refresh when the archived copy is over 15 minutes old.
  - `--refresh` forces a check.
  - `--no-refresh` or `$CUSAGE_REFRESH=off` keeps a run local.
  - The 15-minute launchd agent refreshes on a schedule.
  - The TUI's `R` forces a check (`src/tui/data.ts`), unless `$CUSAGE_REFRESH=off`.
  - Environment overrides, mostly for tests:
    - `CUSAGE_REFRESH` (`off`, `stale` or `force`);
    - `CUSAGE_REFRESH_STALE_MS` (default 15 minutes);
    - `CUSAGE_REFRESH_TIMEOUT_MS` (default 10 s);
    - `CUSAGE_OAUTH_USAGE_URL`;
    - `CUSAGE_NO_KEYCHAIN`.
- **The floor.** Every attempt passes `MIN_REFRESH_MS`, which is `Math.max(180_000, env)`.
  - The attempt is claimed inside an immediate SQLite transaction on `meta`, and the timestamp is
    written before the request goes out.
  - Four concurrent CLI processes resolve to one claim and three refusals.
- **Credentials.** The macOS login keychain item `Claude Code-credentials` is read first, with
  `~/.claude/.credentials.json` as the fallback. An unexpired token beats an expired one whatever
  the store order. `fromKeychain` kills `security` after 5 s.
- **Statusline.** `cusage statusline` prints its archived line immediately and starts an
  unreferenced CLI worker to refresh stale limits. The worker survives the parent's exit and
  shares the same floor. The line is never delayed by the keychain or the network.

## Rules worth keeping

- **One host.**
  - `src/oauth.ts` is the only shipped file that may call `fetch`.
  - `tools/refresh-pricing.ts` is a manual developer tool and is never imported by the CLI.
  - A dependency doesn't get to bring a second host along.
- **The floor counts attempts, not successes.** A 401 or a hung endpoint then can't be retried
  faster than a success, and a slow endpoint can't become a retry storm.
- **The floor is persisted in `meta`, not held in a module variable.** A launchd agent and a
  statusline poll are separate processes; a floor that holds within one process isn't a floor.
- **Config can raise the floor and can't lower it.** `--refresh` skips the staleness check, not
  the floor. `tests/refresh.test.ts` spawns a child with `CUSAGE_MIN_REFRESH_MS=1000` and asserts
  it still reads 180000. Keep that test.
- **A blocked attempt doesn't extend the window.** Otherwise a caller in a loop keeps the guard
  closed forever.
- **Failures are soft.** `refreshFromApi` never throws. With no token, a 401, a timeout or no
  network, the caller prints the archived view and one line on stderr. Under `--json`, the
  outcome is in the result's `refresh` field instead, and only a failed attempt still writes to
  stderr.
- **The token is read, used once and dropped.** It is never persisted or logged, and `redact()`
  strips `sk-ant-*` from anything that leaves the module.
- **The suite is offline.**
  - `tests/cli.test.ts` pins `CUSAGE_REFRESH=off`.
  - The one test that drives a real request points at `127.0.0.1:1`. It refuses instantly, which
    proves the attempt was recorded, the failure was soft and the next call met the guard.

## Decisions

- **Why the "no network, ever" rule went.** The original rule assumed `cachedUsageUtilization`
  was as good as the endpoint. Measured on 2026-09-09: across a full day of heavy use, Claude Code
  refreshed it once, leaving a snapshot 27.5 hours old. `cusage limits` reported
  `weekly_scoped Fable 53%` and `weekly_all 37%` while the app showed 74% and 54%. The rule was
  protecting a number that was wrong.
- **Why the keychain comes first.** On the development machine the credentials file was three
  weeks stale while the keychain was current.
- **Keychain under launchd.** `security find-generic-password` reaches the login keychain from a
  LaunchAgent in the GUI session (verified). If that ever changes, the 5 s kill keeps a job from
  hanging on a keychain dialog forever.
