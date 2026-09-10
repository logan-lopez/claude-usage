/** Frozen estimator audit corpus. Read-only archive; strict metadata allowlist.
 * Contains no session identities, timestamps, paths, prompts or tool content.
 * Dollar ground truth is the independently archived cumulative cost-state.
 */
import { Database } from "bun:sqlite";
import { paths } from "../src/paths.ts";
const db = new Database(paths.db, { readonly: true });
try {
  const sessions = db
    .query(
      "SELECT session_id, total_cost_usd FROM sessions WHERE total_cost_usd IS NOT NULL ORDER BY session_id",
    )
    .all() as { session_id: string; total_cost_usd: number }[];
  const rows = sessions.map((session) => {
    const tiers = (
      db
        .query(
          "SELECT model FROM cost_state_models WHERE session_id=? AND model LIKE '%[1m]'",
        )
        .all(session.session_id) as { model: string }[]
    ).map((r) => r.model);
    const tokens = db
      .query(
        `SELECT model, speed, COUNT(*) requests,
      SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
      SUM(cache_creation_tokens) cache_creation_tokens, SUM(cache_read_tokens) cache_read_tokens
      FROM requests WHERE session_id=? GROUP BY model, speed ORDER BY model, speed`,
      )
      .all(session.session_id);
    return { measured: session.total_cost_usd, tiers, tokens };
  });
  await Bun.write(
    "fixtures/pricing-calibration.json",
    JSON.stringify(
      {
        captured_at: new Date().toISOString(),
        source:
          "read-only archive: grouped token counts and cumulative session cost-state",
        sessions: rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Saved ${rows.length} anonymous measured sessions`);
} finally {
  db.close();
}
