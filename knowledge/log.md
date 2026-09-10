## 2026-09-10
* **Update**: Updated concept `architecture/grouped-cost-is-exact-or-absent.md`.
* **Creation**: Documented concept `architecture/cli-reports-and-binary-install.md` (CLI reports preserve provenance and install as standalone binaries).
* **Update**: Updated concept `architecture/live-oauth-fetch-with-guard.md`.

## 2026-09-09
* **Update**: Linked `architecture/session-rollup-scoped-to-read-files.md` to `findings/corpus-shape-2026-09-09.md` (The 510 sessions and 8,913 requests that made the full-table roll-up measurable waste).
* **Update**: Updated concept `architecture/session-rollup-scoped-to-read-files.md`.
* **Creation**: Documented concept `architecture/session-rollup-scoped-to-read-files.md` (sessions.request_count is rolled up only for the files a sync actually read).
* **Update**: Linked `architecture/live-oauth-fetch-with-guard.md` to `findings/corpus-shape-2026-09-09.md` (The measurements that showed the cached snapshot was 27h stale and weekly_scoped is nowhere on disk).
* **Update**: Updated concept `architecture/live-oauth-fetch-with-guard.md`.
* **Update**: Linked `architecture/limits-reconciled-by-freshness.md` to `architecture/live-oauth-fetch-with-guard.md` (The live source that made an honest reconciliation possible).
* **Update**: Updated concept `architecture/limits-reconciled-by-freshness.md`.
* **Creation**: Documented concept `architecture/limits-reconciled-by-freshness.md` (Current limits are reconciled per meter by freshness, never taken from one source).
* **Creation**: Documented concept `architecture/live-oauth-fetch-with-guard.md` (The no-network rule is replaced by one endpoint behind a 3-minute floor).
* **Update**: Linked `architecture/independent-fixture-baseline.md` to `architecture/without-rowid-request-key.md` (The baseline is what proves the key design holds across full re-reads).
* **Update**: Updated concept `architecture/independent-fixture-baseline.md`.
* **Update**: Linked `architecture/grouped-cost-is-exact-or-absent.md` to `findings/corpus-shape-2026-09-09.md` (cost-state coverage and the cumulative-record trap that sets the ground truth).
* **Update**: Updated concept `architecture/grouped-cost-is-exact-or-absent.md`.
* **Update**: Linked `architecture/without-rowid-request-key.md` to `findings/corpus-shape-2026-09-09.md` (The 228 requestId-less records this key design protects are counted here).
* **Update**: Updated concept `architecture/without-rowid-request-key.md`.
* **Creation**: Documented concept `findings/corpus-shape-2026-09-09.md` (Measured shape of the local Claude Code corpus, 2026-09-09).
* **Creation**: Documented concept `architecture/independent-fixture-baseline.md` (Test baselines are computed by a second, independent dedup implementation).
* **Creation**: Documented concept `architecture/grouped-cost-is-exact-or-absent.md` (Grouped cost excludes sessions that straddle groups rather than double-counting them).
* **Creation**: Documented concept `architecture/without-rowid-request-key.md` (requests is WITHOUT ROWID with request_id stored as empty string).
* **Creation**: Initialized OKF v0.2 project memory.
