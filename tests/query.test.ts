import { expect, test } from "bun:test";
import { getSession, groupSessions, listSessions, resolveSessionId } from "../src/query.ts";
import { baseline, freshDb } from "./helpers.ts";

test("per-session totals match the independent baseline, session by session", () => {
  const db = freshDb();
  for (const [id, expected] of Object.entries<any>(baseline.perSession)) {
    const d = getSession(db, id);
    expect(d).not.toBeNull();
    expect(`${id}:${d!.session.requests}`).toBe(`${id}:${expected.requests}`);
    expect(`${id}:${d!.session.output_tokens}`).toBe(`${id}:${expected.output_tokens}`);
    expect(`${id}:${d!.session.total_tokens}`).toBe(`${id}:${expected.total_tokens}`);
  }
});

test("--last resolves to the most recently active session", () => {
  const db = freshDb();
  const id = resolveSessionId(db, null)!;
  expect(id).not.toBeNull();
  const newest = db
    .query("SELECT session_id FROM sessions WHERE message_count > 0 ORDER BY last_ts_ms DESC LIMIT 1")
    .get() as { session_id: string };
  expect(id).toBe(newest.session_id);
});

test("a session id prefix resolves, an unknown one does not", () => {
  const db = freshDb();
  const full = resolveSessionId(db, null)!;
  expect(resolveSessionId(db, full.slice(0, 8))).toBe(full);
  expect(resolveSessionId(db, "nope-nope-nope")).toBeNull();
});

test("session detail splits main from sub-agent work and adds up", () => {
  const db = freshDb();
  const withSidechain = db
    .query("SELECT session_id FROM requests WHERE is_sidechain = 1 GROUP BY session_id LIMIT 1")
    .get() as { session_id: string };
  expect(withSidechain).toBeDefined();
  const d = getSession(db, withSidechain.session_id)!;
  expect(d.sidechain.requests).toBeGreaterThan(0);
  expect(d.main.requests + d.sidechain.requests).toBe(d.session.requests);
  expect(d.main.total_tokens + d.sidechain.total_tokens).toBe(d.session.total_tokens);
});

test("every breakdown of a session sums back to the session total", () => {
  const db = freshDb();
  for (const id of Object.keys(baseline.perSession)) {
    const d = getSession(db, id)!;
    for (const rows of [d.byModel, d.byEffort, d.byAgent, d.bySkill, d.byMcpServer, d.byPlugin]) {
      const sum = rows.reduce((a, r) => a + r.total_tokens, 0);
      expect(`${id}:${sum}`).toBe(`${id}:${d.session.total_tokens}`);
    }
  }
});

test("grouped cost never exceeds the cost-state ground truth", () => {
  // The bug this exists for: cost-state is per session, a session's requests
  // can land in several groups, and summing the session total into each group
  // it touched turned $90 of real spend into $226.
  const db = freshDb();
  const truth = (db.query("SELECT COALESCE(SUM(total_cost_usd),0) c FROM sessions").get() as { c: number }).c;
  expect(truth).toBeCloseTo(baseline.costStateTotalUSD, 6);
  for (const by of ["project", "model", "entrypoint", "branch"] as const) {
    const rows = groupSessions(db, by);
    const summed = rows.reduce((a, r) => a + r.cost_usd, 0);
    expect(`${by}:${summed <= truth + 1e-6}`).toBe(`${by}:true`);
    // Anything left out has to be declared, not silently dropped.
    if (summed < truth - 1e-6) {
      const declared = rows.reduce((a, r) => a + r.sessions_split + r.sessions_unpriced, 0);
      expect(`${by}:${declared > 0}`).toBe(`${by}:true`);
      expect(rows.every((r) => r.cost_complete)).toBe(false);
    }
  }
});

test("grouped token totals partition the corpus exactly", () => {
  const db = freshDb();
  for (const by of ["project", "model", "entrypoint", "branch"] as const) {
    const rows = groupSessions(db, by);
    expect(`${by}:${rows.reduce((a, r) => a + r.total_tokens, 0)}`)
      .toBe(`${by}:${baseline.tokens.total_tokens}`);
    expect(`${by}:${rows.reduce((a, r) => a + r.requests, 0)}`)
      .toBe(`${by}:${baseline.requests}`);
  }
});

test("listSessions honours --since and --limit", () => {
  const db = freshDb();
  expect(listSessions(db, { limit: 3 }).length).toBeLessThanOrEqual(3);
  expect(listSessions(db, { since: Date.now() + 86_400_000 })).toEqual([]);
  // Sessions with no assistant turns are not listed as usage.
  expect(listSessions(db, { limit: 500 }).every((r) => r.requests > 0)).toBe(true);
});

test("costBasis says measured only when a cost-state record exists", () => {
  const db = freshDb();
  for (const id of Object.keys(baseline.perSession)) {
    const d = getSession(db, id)!;
    expect(`${id}:${d.costBasis}`).toBe(
      `${id}:${d.session.total_cost_usd !== null ? "measured" : "estimated"}`,
    );
  }
});
