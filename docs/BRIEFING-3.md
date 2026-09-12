# Phase 5A briefing: Ink TUI foundation and session explorer

## Summary

Build a usable first TUI release with three screens: **Overview, Sessions, and Session Detail**. Follow the visual hierarchy and muted styling of `docs/cusage_tui_overview_120x40.html`, adapting the layout to terminal size.

The primary workflow is: inspect current usage and archive health → find a session → inspect its tokens, costs, and attribution → return without losing browsing state.

Use two top-level tabs: **1 Overview** and **2 Sessions**. Session Detail opens from either screen. Defer the standalone Timeline and other future tabs, grouped session views, mouse support, and the command prompt.

## Layout and interaction

**Shared shell**

- Use Ink’s alternate screen, a persistent status header, tab bar, bounded content area, and contextual shortcut footer.
- Follow the mockup’s warm neutral text, muted labels, terracotta selection accent, amber warnings, and green healthy states. Prefer section headings and thin rules over boxed cards.
- The header shows the binding server limit, its source and age, five-hour/seven-day readings, and abbreviated archive totals. Prioritize limit freshness when space is tight.
- Support `NO_COLOR` and `--no-color`; selection, warnings, and missing data must remain understandable without color.
- At **110×36 or larger**, use the full dashboard arrangement. At smaller supported sizes, down to **80×24**, show one Overview panel at a time with a visible panel selector. Below 80×24, show a resize notice while retaining quit handling.
- Resize must preserve the active screen, focused panel, selected session, filters, and scroll position.

**Keyboard contract**

| Key | Behavior |
|---|---|
| `1`, `2` | Open Overview or Sessions |
| `Tab`, `Shift+Tab` | Cycle focus; switch Overview panels in compact mode |
| `↑/↓`, `j/k` | Move selection or scroll the focused content |
| `PageUp/PageDown`, `Home/End` | Navigate the focused list or section |
| `Enter` | Open the selected session |
| `Esc` | Close an overlay, cancel editing, or return from Detail |
| `/` | Edit Sessions search |
| `f`, `s` | Open Sessions filters or sorting |
| `r` | Reread archive data and rerun archive diagnostics |
| `R` | Explicitly fetch fresh limits through the existing refresh guard |
| `?` | Open contextual help |
| `q`, `Ctrl+C` | Quit |

Text inputs and overlays own input while active; typing `q`, numbers, or other shortcut characters must not trigger background actions. Show only relevant shortcuts in the footer.

**Overview**

Preserve the five-panel arrangement from the example:

1. **Server limits:** scoped limits, binding indicator, reconciled five-hour/seven-day readings, reset times, source, age, stale state, and disagreements.
2. **Archive:** requests, sessions, distinct projects, tokens, limit samples, archive span, database size, and actual diagnostic results.
3. **Meters:** trailing 72-hour sparklines using hourly peak buckets. Missing samples remain `·`; never interpolate. Label sources accurately, including mixed-source history.
4. **Daily output tokens:** 30 UTC calendar days including today, with today marked partial. Preserve zero buckets; label these as archived local usage.
5. **Recent sessions:** six newest sessions with project/name, model summary, requests, tokens, and cost provenance. `Enter` opens Detail.

At 120×40, all five panels and the footer must be visible. Recent Sessions receives initial focus. In compact mode, every panel remains reachable through the selector.

Use **“latest archived request”**, not “last sync ran”: the archive does not currently record successful sync completion times. Do not reproduce illustrative mockup values or infer healthy agents from recent usage.

**Sessions**

- Use a full-width, scrollable table with last activity, session name/project, model summary, requests, total tokens, and cost.
- Search case-insensitively across session ID and slug/name. Provide separate project and model filters.
- Activity presets: **All** by default, Today UTC, Last 7 days, Last 30 days.
- Sorting: **Last activity descending** by default, Total tokens descending, Requests descending; break ties by session ID.
- Filters select sessions; displayed amounts remain **whole-session totals**. State this beside the controls.
- Show the total matching count and visible range. Fetch additional pages as navigation reaches them; never silently stop at the CLI’s default 30 rows.
- Preserve browsing state when opening Detail and returning. Archive updates retain selection by session ID where possible.

**Session Detail**

Keep session identity and a compact totals summary above switchable, scrollable sections:

- **Summary:** full ID, slug, project/path, branch, entrypoint, first/last activity, durations, token categories, main/sub-agent totals, and cost basis.
- **Models:** token breakdown and available measured model costs.
- **Attribution:** selectable effort, agent, skill, MCP server, and plugin breakdowns, including unattributed coverage.
- **Tools:** tool names and call counts.
- **API blocks:** per-session API-block breakdown, explicitly distinguished from server five-hour windows.

Default to Summary. Empty sections show a meaningful empty state. Do not add transcript content or assign token consumption to individual tool calls.

## Implementation and data contracts

**Runtime and component boundary**

- Use **Ink 7.1.1**, React 19.2-compatible dependencies, and **`@inkjs/ui` 2.0.0** for `TextInput`, `Select`, and `Spinner`. Pin resolved versions in the lockfile. Ink’s published requirements and Ink UI’s declared peer range support this dependency choice; Bun compilation and terminal behavior still require verification. [Ink package](https://github.com/vadimdemedes/ink/blob/v7.1.1/package.json), [Ink UI package](https://github.com/vadimdemedes/ink-ui/blob/main/package.json)
- Use native `alternateScreen`, `useWindowSize`, and Ink input/focus hooks. Build small reusable table, viewport, section, sparkline, and bar-chart components; no additional fullscreen or table framework. [Ink API exports](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/index.ts), [render API](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/render.ts)
- Retain `src/tui.ts` as the separate executable entrypoint, with components under `src/tui/`. Update the existing “only one file may import React” wording to allow this isolated TUI subtree.
- Keep React, Ink, and Ink UI unreachable from the CLI import graph. Retain separate compiled binaries.
- Keep SQL and numeric aggregation in `src/query.ts`; components consume plain data. Do not parse CLI output or reuse ANSI-rendered report strings.

**Additive query work**

- Add a paginated session query returning `{ rows, total }`, with search, existing project/model/activity semantics, the three specified sort orders, and offset/page size. Use 100-row pages and preserve existing CLI query defaults.
- Add a batch session-cost query keyed by session IDs, reusing existing pricing and cost-provenance logic. Compute whole-session costs only for requested IDs; avoid a full-archive pricing pass on every keystroke.
- Add distinct-project count to archive inventory.
- Extend history querying to select an exact scoped model. The current scoped aggregation must not combine different models and label the result as one model. Prefer the current binding scoped model, otherwise the latest archived scoped model.
- Keep existing report APIs backward compatible. No schema migration or changes to ingestion are required.

**Provenance rules**

- Use existing reconciliation, stale thresholds, severity, and disagreement results; do not invent a new “binding” calculation.
- Show measured costs normally, estimates with `~`, partial amounts with `+`, and wholly unpriced amounts as unavailable. Explain markers in help and Detail.
- Never blend measured and estimated subtotals. Preserve unknown-rate and unknown-tier disclosures.
- Keep whole-session cost distinct from spend within an activity filter. Preserve existing exact-or-absent behavior wherever grouped calculations are reused.
- Historical peak values and current readings are separate quantities with separate labels.

## Refresh, diagnostics, and failure behavior

- Launch against the existing archive using `--db` or `CUSAGE_DB`, with the existing default path. Also support `--help` and `--no-color`.
- Open the archive read-only for normal browsing. Missing archives or incompatible schemas produce an actionable message directing the user to `cusage sync`; browsing does not create or migrate an archive.
- Check for external SQLite changes every **5 seconds** using the existing connection’s data version. Reload affected data when it changes; update relative-age labels independently without rerunning expensive queries.
- `r` forces an archive reread. It does not ingest transcripts or fetch limits.
- `R` invokes `refreshFromApi` with the existing attempt floor through a short-lived writable connection. Respect `CUSAGE_REFRESH=off`. Show fetching, guarded/retry time, success, or failure; retain archived readings throughout.
- Allow only one local refresh operation at a time. Repeated keys do not queue requests.
- Reuse doctor’s operational checks through a credential-free archive-diagnostics mode, preserving its default CLI behavior. Run diagnostics after initial rendering and on `r`, not every poll. Display their check time; never probe credentials during ordinary browsing.
- Keep the last successful data visible during recoverable read/refresh failures and mark it outdated. Distinguish loading, empty archive, no matching sessions, unavailable limits, and unreadable database.
- Quit and fatal-error cleanup must restore the terminal, stop timers/listeners, prevent updates after unmount, and safely release database connections. Non-TTY invocation exits with code 2 and a concise message pointing to the CLI.

## Acceptance and handoff

Implement in this order: dependency/build smoke → shell and navigation → Overview → Sessions → Detail → refresh and failure handling.

Verification must include:

- Deterministic Ink interaction tests with fixed dimensions, injected clock, scrubbed fixtures, and mocked refresh/diagnostic dependencies.
- Overview → Detail → back and Sessions → Detail → back, preserving selection and filters.
- Search, filter combinations, sorting, pagination, empty results, keyboard ownership, and selection preservation after archive updates.
- Full layout at 120×40, compact layout at 80×24, transitions between them, undersized terminals, long names, wide Unicode text, and monochrome rendering.
- Measured, estimated, partial, and unpriced costs; stale/disagreeing limits; meter gaps; multiple scoped models; zero-day buckets and partial today.
- External archive updates, manual reread, guarded refresh, offline failure, repeated refresh keys, and quit during pending work.
- Existing CLI import-boundary and machine-output tests, replacing the TUI-stub test with entrypoint behavior tests.
- `bun test`, `bun run typecheck`, `make build`, `git diff --check`, and strict OKF validation.
- PTY smoke tests of both source and compiled TUI for startup, resize, navigation, and terminal restoration.

The handoff should include the briefing as `docs/BRIEFING-3.md`, updated usage documentation, and durable architectural decisions recorded through the repository’s OKF workflow. Preserve the supplied HTML and existing briefings. Building and validating are included; installing binaries or changing launch agents is deferred.
