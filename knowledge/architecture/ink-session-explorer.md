---
type: Decision
title: Ink session explorer browses read-only with identity-preserving state
description: The separate Ink TUI consumes plain query data, preserves session identity across navigation and reloads, and confines guarded limit refreshes to cancellable short-lived writable connections.
sources: ["docs/BRIEFING-3.md", "src/tui/", "src/query.ts", "tests/tui.test.tsx", "tools/tui-pty-smoke.py"]
generated: { by: agent/codex, at: 2026-09-11T16:03:32Z }
---

## Decision

Phase 5A uses Ink 7.1.1, React 19.2.0 and @inkjs/ui 2.0.0. React and Ink are confined to src/tui.ts and src/tui/. The CLI import graph remains independent; both executables compile separately. Bun 1.3.3 compilation needs explicit production JSX settings. Ink's optional devtools import must resolve during bundling; compiled builds disable DEV and do not enable a devtools connection.

The TUI opens an existing current-schema archive read-only and never creates or migrates it. Missing or incompatible archives direct the user to cusage sync. A persistent connection polls PRAGMA data_version every five seconds. Clock updates do not requery archive aggregates. Diagnostics reuse doctor in credential-free archiveOnly mode after initial rendering and manual rereads, not each poll.

Sessions use 100-row cached pages with a total matching count. Search, project, model and activity filters choose session identities; displayed amounts remain whole-session totals. Costs are computed only for requested session IDs, using existing rate and provenance logic. Returning from Detail preserves browsing state; rereads retain selection by session ID when possible.

Scoped history filters the exact selected model before hourly peak aggregation: binding weekly_scoped model first, otherwise latest archived model. Five-hour/seven-day sources and scoped sources are reported separately. Missing buckets stay null, zero UTC days stay zero, and current readings remain separate from historical peaks.

Only uppercase R fetches limits. It opens a short-lived writable connection without migration and uses refreshFromApi's persisted attempt floor; CUSAGE_REFRESH=off is respected. A local in-flight guard prevents queues. Unmount cancels keychain/network work, suppresses late state updates and restores terminal state. Failures retain last successful archive data with explicit outdated/error notices.

The full dashboard starts at 110x36; compact mode down to 80x24 shows one selectable panel. Text inputs and overlays own keyboard input. q is data inside an input, while Ctrl+C always quits. Session Detail has Summary, Models, Attribution, Tools and API blocks; no transcript content or per-tool token allocation is introduced.

Sources: docs/BRIEFING-3.md; src/tui/; src/query.ts; src/doctor.ts; src/limits.ts; src/oauth.ts; tools/build.ts; tests/tui.test.tsx; tools/tui-pty-smoke.py.

# Related Concepts
- [CLI reports preserve provenance and install as standalone binaries](cli-reports-and-binary-install.md): Retains the separate executable and plain-data reporting boundaries.
