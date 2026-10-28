import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  archiveStats, cost, estimatorAudit, exactSessionCost, getSession, groupSessions, listSessions, MEASURED_COST,
  resolveSessionId, sessionCosts, type GroupRow, type SessionsOptions,
} from "../src/query.ts";
import { baseline, freshDb, unknownModelCostDb } from "./helpers.ts";

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
    .query("SELECT session_id FROM sessions WHERE request_count > 0 ORDER BY last_ts_ms DESC LIMIT 1")
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

/** `groupSessions` as it was before brief 07, three queries per session, kept as the parity oracle. */
function groupOracle(db: Database, by: NonNullable<SessionsOptions["by"]>, opts: SessionsOptions = {}): GroupRow[] {
  const column = { project: "project", model: "model", entrypoint: "entrypoint", branch: "git_branch" }[by];
  const w = {
    sql: `($since IS NULL OR ts_ms >= $since) AND ($until IS NULL OR ts_ms < $until)
      AND ($project IS NULL OR instr(lower(COALESCE(project,'')), lower($project)) > 0)
      AND ($model IS NULL OR instr(lower(COALESCE(model,'')), lower($model)) > 0)`,
    params: { $since: opts.since ?? null, $until: opts.until ?? null,
      $project: opts.project ?? null, $model: opts.model ?? null },
  };
  const totals = db.query(`SELECT COALESCE(${column}, '(unknown)') key, COUNT(DISTINCT session_id) sessions,
    COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
    COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens, COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
    COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens, COALESCE(SUM(ephemeral_5m), 0) AS ephemeral_5m,
    COALESCE(SUM(ephemeral_1h), 0) AS ephemeral_1h, COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM requests WHERE ${w.sql} GROUP BY ${column} ORDER BY total_tokens DESC`).all(w.params) as GroupRow[];
  const memberships = db.query(`SELECT DISTINCT session_id, COALESCE(${column}, '(unknown)') key FROM requests WHERE ${w.sql}`).all(w.params) as { session_id: string; key: string }[];
  const costs = new Map<string, ReturnType<typeof exactSessionCost>>();
  for (const id of new Set(memberships.map(r => r.session_id))) {
    const all = db.query(`SELECT COUNT(*) n, COUNT(DISTINCT COALESCE(${column}, '(unknown)')) groups FROM requests WHERE session_id=$id`).get({ $id: id }) as { n: number; groups: number };
    const selected = db.query(`SELECT COUNT(*) n FROM requests WHERE session_id=$id AND ${w.sql}`).get({ ...w.params, $id: id }) as { n: number };
    const cost = db.query(`SELECT ${MEASURED_COST} AS total_cost_usd FROM sessions WHERE session_id=?`).get(id) as { total_cost_usd: number | null } | null;
    costs.set(id, exactSessionCost(cost?.total_cost_usd ?? null, all.groups, all.n === selected.n));
  }
  return totals.map(t => {
    const parts = memberships.filter(r => r.key === t.key).map(r => costs.get(r.session_id)!);
    return { ...t, cost_usd: parts.reduce((n, r) => n + r.cost_usd, 0),
      sessions_split: parts.reduce((n, r) => n + r.sessions_split, 0),
      sessions_unpriced: parts.reduce((n, r) => n + r.sessions_unpriced, 0), cost_complete: parts.every(r => r.cost_complete) };
  });
}

test("groupSessions matches the pre-brief-07 per-session loop for every grouping and filter", () => {
  const db = freshDb();
  const mid = 1788450000000;
  // Inside one session, so that session is partly selected: its cost has to drop out.
  const inside = (db.query(`SELECT ts_ms FROM requests WHERE session_id =
    (SELECT session_id FROM requests GROUP BY session_id HAVING COUNT(*) > 2 ORDER BY session_id LIMIT 1)
    ORDER BY ts_ms LIMIT 1 OFFSET 1`).get() as { ts_ms: number }).ts_ms;
  const cases: SessionsOptions[] = [
    {}, { since: mid }, { until: mid }, { since: inside }, { project: "proj-06" }, { model: "opus" },
    { since: 1788200000000, until: 1788700000000, project: "PROJ-1", model: "fable" },
  ];
  for (const by of ["project", "model", "entrypoint", "branch"] as const) {
    const all = groupSessions(db, by);
    for (const opts of cases) {
      const rows = groupSessions(db, by, opts);
      const oracle = groupOracle(db, by, opts);
      expect(rows).toEqual(oracle);
      // `--json` prints the rows as they are, so their key order is output too.
      expect(JSON.stringify(rows)).toBe(JSON.stringify(oracle));
      // Each filter has to bite, or parity under it proves nothing.
      if (Object.keys(opts).length) expect(rows).not.toEqual(all);
    }
    // A partly selected session's cost is excluded, or that path goes untested.
    expect(groupSessions(db, by, { since: inside }).some((r) => r.sessions_split > 0 && !r.cost_complete)).toBe(true);
  }
  // The flagged-cost archive: a NULL measured cost reaches the oracle and the rewrite alike.
  const flagged = unknownModelCostDb();
  try {
    for (const by of ["project", "model", "entrypoint", "branch"] as const)
      expect(groupSessions(flagged, by)).toEqual(groupOracle(flagged, by));
  } finally {
    flagged.close();
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

test("a cost-state total Claude Code flagged hasUnknownModelCost is never measured", () => {
  // Found on a real LM Studio run: Claude Code priced qwen/qwen3.8-27b at Opus
  // rates, set the flag, and every view printed $0.96 as exact spend. Each
  // assertion is one reader of "measured"; a reader that goes back to the bare
  // column fails its own line.
  const db = unknownModelCostDb();
  try {
    const local = getSession(db, "local")!;
    expect(local.costBasis).toBe("estimated");
    expect(local.unknownModelCost).toBe(true);
    expect(local.session.total_cost_usd).toBeNull();
    // Claude Code's per-model record is still archived, just not believed.
    expect(local.costModels[0]!.cost_usd).toBeCloseTo(0.9639155, 8);
    const known = getSession(db, "known")!;
    expect(known.costBasis).toBe("measured");
    expect(known.unknownModelCost).toBe(false);

    const costs = sessionCosts(db, ["known", "local"]);
    expect(costs.known!.basis).toBe("measured");
    expect(costs.local!.basis).toBe("estimated");
    expect(costs.local!.priced_requests).toBe(0);
    expect(costs.local!.cost_complete).toBe(false);

    const report = cost(db, { by: "session" });
    expect(report.totals.measured).toBeCloseTo(0.9639155, 8);
    expect(report.totals.estimated).toBe(0);
    expect(report.rows.find((r) => r.key === "local")!.basis).toBe("estimated");

    const groups = groupSessions(db, "model");
    expect(groups.find((r) => r.key === "qwen/qwen3.8-27b")!.sessions_unpriced).toBe(1);
    expect(groups.reduce((n, r) => n + r.cost_usd, 0)).toBeCloseTo(0.9639155, 8);

    expect(archiveStats(db).sessionsWithCost).toBe(1);
    expect(estimatorAudit(db).sessions).toBe(1);
  } finally {
    db.close();
  }
});
