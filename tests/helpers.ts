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
