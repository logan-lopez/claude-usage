#!/usr/bin/env bun
/**
 * Ink entrypoint. Phase 5. Stub for now.
 *
 * This is the ONLY file in the project permitted to import react or ink, and
 * it is a separate bin target from src/cli.ts on purpose: the hourly launchd
 * archiver and any statusline polling `--json` must not pay React's startup
 * cost. If this is ever merged into cli.ts, it must be behind a lazy
 * `await import('./tui.ts')` inside the tui command arm and nowhere else.
 *
 * It will consume src/query.ts directly. It is not a rewrite of cli.ts.
 */
process.stderr.write(
  "cusage tui is not built yet (phase 5: Ink 7.1.1 + React 19.2).\n" +
    "Use `cusage session`, `cusage sessions` or `cusage limits` for now.\n",
);
process.exit(2);
