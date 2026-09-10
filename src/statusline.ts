/** Schedule a refresh without making the statusline wait for keychain/network.
 * The child uses refreshFromApi's atomic, persisted attempt guard, including
 * when multiple polling processes race here. No new endpoint or bypass.
 */
import type { Database } from "bun:sqlite";
import { getMeta } from "./schema.ts";
import { MIN_REFRESH_MS, DEFAULT_STALE_MS } from "./oauth.ts";
import { LAST_ATTEMPT_KEY, type RefreshMode } from "./limits.ts";
import { build } from "./version.ts";
export function scheduleStatusRefresh(
  db: Database,
  file: string,
  mode: RefreshMode,
): boolean {
  if (mode === "off") return false;
  const now = Date.now();
  const lastAttempt = Number(getMeta(db, LAST_ATTEMPT_KEY)) || 0;
  if (now - lastAttempt < MIN_REFRESH_MS) return false;
  const latest = (
    db
      .query("SELECT MAX(ts_ms) t FROM limit_samples WHERE source='oauth-live'")
      .get() as { t: number | null }
  ).t;
  if (mode !== "force" && latest !== null && now - latest < DEFAULT_STALE_MS)
    return false;
  const entry = build.sha
    ? [process.execPath]
    : [process.execPath, `${import.meta.dir}/cli.ts`];
  try {
    const child = Bun.spawn(
      [...entry, "limits", "--refresh", "--json", "--db", file],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, CUSAGE_REFRESH: "force" },
      },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}
