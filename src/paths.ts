import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

/**
 * Every filesystem location the tool touches, in one place.
 *
 * All of them are overridable by environment variable. That is not a
 * convenience: the test suite points the whole tool at a frozen fixture
 * directory, and the launchd agents point it at the real one. Nothing else may
 * hard-code these paths.
 */
export const paths = {
  /** Owned archive. Data, not config -- deliberately outside any repo. */
  db: process.env.CUSAGE_DB ?? join(HOME, ".local/share/claude-usage/usage.db"),

  /** Source 1 + 2: transcripts, and the cost-state records inside them. */
  transcripts: process.env.CUSAGE_TRANSCRIPTS ?? join(HOME, ".claude/projects"),

  /** Source 3: the cached OAuth /api/oauth/usage response. Read, never written. */
  claudeJson: process.env.CUSAGE_CLAUDE_JSON ?? join(HOME, ".claude.json"),

  /**
   * Source 3b fallback only. On macOS the live token is in the login keychain
   * (`Claude Code-credentials`) and this file is usually a stale leftover; it
   * is read only when the keychain has nothing usable. The token is used to
   * sign one request and is never written to the archive or to a log.
   */
  credentials:
    process.env.CUSAGE_CREDENTIALS ?? join(HOME, ".claude/.credentials.json"),

  /** Source 4: desktop app's 15-minute longitudinal series, rolling 30-day cap. */
  desktopHistory:
    process.env.CUSAGE_DESKTOP_HISTORY ??
    join(HOME, "Library/Application Support/Claude/plan-usage-history.json"),

  /** Source 4b: Glaze wrapper's sparse day -> percent map. */
  glazeHistory:
    process.env.CUSAGE_GLAZE_HISTORY ??
    join(
      HOME,
      "Library/Application Support/app.glaze.macos.pp8z5ilo/usage-history.json",
    ),
} as const;
