import { openDb } from "../src/schema.ts";
import { ingestTranscripts } from "../src/ingest.ts";

export const FIXTURES = `${import.meta.dir}/../fixtures`;
export const FIXTURE_TRANSCRIPTS = `${FIXTURES}/projects`;

export const baseline = await Bun.file(`${FIXTURES}/BASELINE.json`).json();
export const manifest = await Bun.file(`${FIXTURES}/MANIFEST.json`).json();

/** A fresh in-memory archive with the frozen fixture ingested. */
export function freshDb() {
  const db = openDb(":memory:");
  ingestTranscripts(db, FIXTURE_TRANSCRIPTS);
  return db;
}

/**
 * Two cost-state sessions, identical except that Claude Code flagged one
 * `hasUnknownModelCost`. The flagged one is shaped like a real local-model run:
 * $0.9639155 is exactly Opus-tier rates applied to a Qwen model's tokens. The
 * fixture has no flagged session, so this cannot come from it.
 */
export function unknownModelCostDb() {
  const db = openDb(":memory:");
  const add = (id: string, model: string, cost: number, unknown: 0 | 1) => {
    db.query("INSERT INTO sessions(session_id, request_count, total_cost_usd, has_unknown_model_cost, first_ts, last_ts, first_ts_ms, last_ts_ms) VALUES (?, 1, ?, ?, '2026-09-13T22:14:17.008Z', '2026-09-13T22:14:17.008Z', 1789337657008, 1789337657008)")
      .run(id, cost, unknown);
    db.query("INSERT INTO cost_state_models(session_id, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, 182391, 878, ?)")
      .run(id, model, cost);
    db.query(`INSERT INTO requests(message_id, request_id, session_id, ts, ts_ms, model, speed, input_tokens, output_tokens)
      VALUES ('msg', '', ?, '2026-09-13T22:14:17.008Z', 1789337657008, ?, 'standard', 182391, 878)`).run(id, model);
  };
  add("known", "claude-opus-5", 0.9639155, 0);
  add("local", "qwen/qwen3.8-27b", 0.9639155, 1);
  return db;
}

export function totals(db: import("bun:sqlite").Database) {
  return db
    .query(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COALESCE(SUM(thinking_tokens),0) AS thinking_tokens,
              COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
              COALESCE(SUM(ephemeral_5m),0) AS ephemeral_5m,
              COALESCE(SUM(ephemeral_1h),0) AS ephemeral_1h,
              COALESCE(SUM(total_tokens),0) AS total_tokens
         FROM requests`,
    )
    .get() as Record<string, number>;
}
