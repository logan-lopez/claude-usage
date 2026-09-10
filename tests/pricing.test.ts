import { expect, test } from "bun:test";
import { estimateRequest, normalizeModel } from "../src/pricing.ts";
import { freshDb } from "./helpers.ts";
import { cost, cache, estimatorAudit } from "../src/query.ts";
import { openDb } from "../src/schema.ts";
import calibration from "../fixtures/pricing-calibration.json";

const tokens = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_creation_tokens: 1_000_000,
  cache_read_tokens: 1_000_000,
};
test("pricing uses explicit cache rates, dated aliases, speed and unknown tiers", () => {
  expect(
    estimateRequest({ ...tokens, model: "claude-fable-5-1", speed: "standard" })
      .usd,
  ).toBe(72.75);
  expect(
    estimateRequest({ ...tokens, model: "claude-opus-5", speed: "fast" }).usd,
  ).toBe(73.5);
  expect(
    estimateRequest({
      ...tokens,
      model: "claude-haiku-4-5-20251001",
      speed: null,
    }).usd,
  ).toBe(7.35);
  for (const [model, speed] of [
    ["claude-opus-5[1m]", "standard"],
    ["unknown", "standard"],
    ["claude-opus-5", "turbo"],
  ])
    expect(
      estimateRequest({ ...tokens, model: model!, speed: speed! }).usd,
    ).toBeNull();
});

test("cost bases never blend and measured partial windows never spend a lifetime total", () => {
  const db = freshDb();
  try {
    const report = cost(db, { by: "session" });
    const measured = (
      db.query("SELECT SUM(total_cost_usd) n FROM sessions").get() as {
        n: number;
      }
    ).n;
    expect(report.totals.measured).toBeCloseTo(measured, 8);
    expect(report.rows.some((r) => r.basis === "estimated")).toBe(true);
    expect(cost(db, { by: "project" }).totals.measured).toBeLessThanOrEqual(
      measured,
    );
    const session = db
      .query(
        "SELECT r.session_id, MIN(r.ts_ms) lo, MAX(r.ts_ms) hi FROM requests r JOIN sessions s ON s.session_id=r.session_id WHERE s.total_cost_usd>0 GROUP BY r.session_id HAVING lo<hi LIMIT 1",
      )
      .get() as { session_id: string; lo: number; hi: number };
    const partial = cost(db, { by: "session", since: session.hi }).rows.find(
      (r) => r.key === session.session_id,
    )!;
    expect(partial.cost_complete).toBe(false);
    expect(partial.cost_usd).toBe(0);
    expect(partial.sessions_split).toBe(1);
    expect(
      cost(db, { basis: "estimated" }).rows.every(
        (r) => r.basis === "estimated",
      ),
    ).toBe(true);
    expect(cache(db).rows.reduce((n, r) => n + r.reconciliationGap, 0)).toBe(
      (
        db
          .query(
            "SELECT SUM(cache_creation_tokens-ephemeral_5m-ephemeral_1h) n FROM requests",
          )
          .get() as { n: number }
      ).n,
    );
  } finally {
    db.close();
  }
});

test("frozen aggregate calibration reports error distribution without fitting rates", () => {
  const db = openDb(":memory:");
  try {
    for (const [i, session] of calibration.sessions.entries()) {
      const id = String(i);
      db.query(
        "INSERT INTO sessions(session_id,total_cost_usd) VALUES (?,?)",
      ).run(id, session.measured);
      for (const tier of session.tiers)
        db.query(
          "INSERT INTO cost_state_models(session_id,model) VALUES (?,?)",
        ).run(id, tier);
      for (const [j, row] of session.tokens.entries())
        db.query(
          `INSERT INTO requests(message_id,request_id,session_id,model,speed,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens)
        VALUES (?, '', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          String(j),
          id,
          row.model,
          row.speed,
          row.input_tokens,
          row.output_tokens,
          row.cache_creation_tokens,
          row.cache_read_tokens,
        );
    }
    const audit = estimatorAudit(db);
    expect(audit.sessions).toBe(166);
    expect(audit.zeroCostSessions).toBe(59);
    expect(audit.measured).toBeCloseTo(752.04845015, 6);
    expect(audit.estimated).toBeCloseTo(500.15662315, 6);
    expect(audit.median!).toBeLessThan(0.23);
    expect(audit.p90!).toBeLessThanOrEqual(1);
    expect(audit.worst!).toBeLessThan(2);
    expect(audit.rows.some((r) => r.unpricedRequests > 0)).toBe(true);
  } finally {
    db.close();
  }
});

test("calibration fixture is allowlisted and contains no source identifiers", () => {
  for (const session of calibration.sessions) {
    expect(Object.keys(session).sort()).toEqual([
      "measured",
      "tiers",
      "tokens",
    ]);
    for (const row of session.tokens)
      expect(Object.keys(row).sort()).toEqual([
        "cache_creation_tokens",
        "cache_read_tokens",
        "input_tokens",
        "model",
        "output_tokens",
        "requests",
        "speed",
      ]);
  }
  expect(JSON.stringify(calibration)).not.toMatch(
    /\/Users\/|session_id|sk-ant-|msg_01|req_01/,
  );
});
