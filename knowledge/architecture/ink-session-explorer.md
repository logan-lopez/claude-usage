---
type: Decision
title: Ink session explorer browses read-only with identity-preserving state
description: The separate Ink TUI consumes plain query data, preserves session identity across navigation and reloads, and confines guarded limit refreshes to cancellable short-lived writable connections.
sources: ["docs/BRIEFING-3.md", "src/tui/", "src/query.ts", "tests/tui.test.tsx", "tools/tui-pty-smoke.py", "patches/string-width@8.2.2.patch"]
generated: { by: agent/codex, at: 2026-09-11T16:03:32Z }
---

## Decision

Phase 5A uses Ink 7.1.1, React 19.2.0 and @inkjs/ui 2.0.0. React and Ink are confined to src/tui.ts and src/tui/. The CLI import graph remains independent; both executables compile separately. Bun 1.3.3 compilation needs explicit production JSX settings. Ink's optional devtools import must resolve during bundling; compiled builds disable DEV and do not enable a devtools connection.

The TUI opens an existing current-schema archive read-only and never creates or migrates it. Missing or incompatible archives direct the user to cusage sync. A persistent connection polls PRAGMA data_version every five seconds. Clock updates do not requery archive aggregates. Diagnostics reuse doctor in credential-free archiveOnly mode after initial rendering and manual rereads, not each poll.

Sessions use 100-row cached pages with a total matching count. Search, project, model and activity filters choose session identities; displayed amounts remain whole-session totals. Costs are computed only for requested session IDs, using existing rate and provenance logic. Returning from Detail preserves browsing state; rereads retain selection by session ID when possible.

Scoped history filters the exact selected model before hourly peak aggregation: binding weekly_scoped model first, otherwise latest archived model. Five-hour/seven-day sources and scoped sources are reported separately. Missing buckets stay null, zero UTC days stay zero, and current readings remain separate from historical peaks.

Only uppercase R fetches limits. It opens a short-lived writable connection without migration and uses refreshFromApi's persisted attempt floor; CUSAGE_REFRESH=off is respected. A local in-flight guard prevents queues. Unmount cancels keychain/network work, suppresses late state updates and restores terminal state. Failures retain last successful archive data with explicit outdated/error notices.

The full dashboard starts at 110x36; compact mode down to 80x24 shows one selectable panel. Text inputs and overlays own keyboard input. q is data inside an input, while Ctrl+C always quits. Session Detail has Summary, Models, Attribution, Tools and API blocks; no transcript content or per-tool token allocation is introduced.

## Structure and rendering cost (2026-09-29)

App.tsx is only the shell: header, tabs, status, key hints and global keys. useArchive owns the archive lifecycle (first read, data_version polling, the clock, reread, diagnostics, refresh) and reports through one error/notice channel. Browsing state that must survive opening Detail lives in hooks the shell calls: useSessions (100-row pages, filters, selection kept by ID, committed as one view object and tracked in a ref so repeated keys compose), useDetail, and Overview's nav with the recent selection held by session ID rather than index. overview.tsx, sessions.tsx, detail.tsx and help.tsx render their screens and own their keys. text.ts holds the pure width, wrap and label helpers.

Screens receive keys through the shell's single useInput, via useKeys, which registers in a layout effect. Ink's useInput subscribes in a passive effect, so a freshly mounted screen would drop a key that arrives before that effect runs. Printable keys that queue behind a slow frame arrive as one string ("jjj"), and movement() counts them instead of ignoring the chunk.

Most per-keypress time went to string-width's /^\p{RGI_Emoji}$/v, which JavaScriptCore evaluates very slowly. Ink measures every text node on every frame, and nearly every dashboard line contains non-ASCII glyphs (rules, sparklines, ·, ▸). string-width is pinned to the exact version Ink resolves, so there is a single copy, and a bun patch memoizes per-cluster widths. Results are identical: every code point to U+2FFFF was checked under all three option sets. Overview navigation at 120×40 on a 631-session archive went from ~106 ms to ~12 ms per key in the test renderer. patchedDependencies is keyed by exact version, so tests/tui.test.tsx asserts the key, the pinned version, the single resolved copy and the patch marker.

A read-only SQLite handle cannot create a WAL archive's -wal/-shm files, so a copied or restored archive failed on first read. openArchive then falls back to a read-write handle with PRAGMA query_only=ON, which still never creates or migrates the file and refuses every write.

Sources: docs/BRIEFING-3.md; src/tui/; src/query.ts; src/doctor.ts; src/limits.ts; src/oauth.ts; tools/build.ts; tests/tui.test.tsx; tools/tui-pty-smoke.py.

# Related Concepts
- [CLI reports preserve provenance and install as standalone binaries](cli-reports-and-binary-install.md): Retains the separate executable and plain-data reporting boundaries.
