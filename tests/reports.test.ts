import { test, expect } from "bun:test";
import { freshDb, totals } from "./helpers.ts";
import { openDb } from "../src/schema.ts";
import * as q from "../src/query.ts";
import { csv, serializeRows } from "../src/serialize.ts";
import type { Database } from "bun:sqlite";

test("attribution coverage counts missing data and survives a row cap", () => {
  const db = freshDb();
  try {
    const all = totals(db);
    for (const by of Object.keys(
      q.ATTRIBUTION_COLUMNS,
    ) as (keyof typeof q.ATTRIBUTION_COLUMNS)[]) {
      const report = q.attribution(db, by);
      expect(report.coverage.total).toBe(all.requests!);
      expect(report.rows.reduce((n, r) => n + r.requests, 0)).toBe(
        report.coverage.attributed,
      );
      expect(report.coverage.attributed + report.coverage.unattributed).toBe(
        all.requests!,
      );
      expect(q.attribution(db, by, { limit: 1 }).coverage).toEqual(
        report.coverage,
      );
    }
    const tools = q.attribution(db, "tool");
    expect(tools.overlapping).toBe(true);
    expect(tools.rows.reduce((n, r) => n + r.calls!, 0)).toBe(
      (
        db
          .query(
            "SELECT COUNT(*) n FROM tool_calls WHERE tool_name IS NOT NULL",
          )
          .get() as { n: number }
      ).n,
    );
  } finally {
    db.close();
  }
});

test("timeline has UTC Monday weeks, calendar months, empty buckets and exclusive until", () => {
  const db = openDb(":memory:");
  try {
    for (const [i, ts] of [
      "2026-01-31T23:59:00Z",
      "2026-02-02T00:00:00Z",
      "2026-03-01T00:00:00Z",
    ].entries())
      db.query(
        "INSERT INTO requests(message_id,request_id,session_id,ts_ms,output_tokens,model) VALUES (?, '', 's', ?, 10, 'm')",
      ).run(String(i), Date.parse(ts));
    const opts = {
      since: Date.parse("2026-01-31"),
      until: Date.parse("2026-03-01"),
    };
    const day = q.timeline(db, { ...opts, bucket: "day" });
    expect(day.rows.length).toBe(29);
    expect(day.rows[1]!.requests).toBe(0);
    expect(day.rows.reduce((n, r) => n + r.requests, 0)).toBe(2);
    const week = q.timeline(db, { ...opts, bucket: "week" });
    expect(new Date(week.rows[0]!.tsMs).toISOString()).toBe(
      "2026-01-26T00:00:00.000Z",
    );
    expect(week.rows[1]!.requests).toBe(1);
    const month = q.timeline(db, { ...opts, bucket: "month" });
    expect(month.rows.map((r) => r.requests)).toEqual([1, 1]);
  } finally {
    db.close();
  }
});

test("CSV escapes delimiters, quotes and newlines; streaming JSON is a single valid array", () => {
  const rows = [
    { a: 'a,"b"\nc', b: null },
    { a: "plain", b: 2 },
  ];
  expect(csv(rows)).toBe('a,b\r\n"a,""b""\nc",\r\nplain,2\r\n');
  expect(
    JSON.parse([...serializeRows(rows, "json", ["a", "b"])].join("")),
  ).toEqual(rows);
  expect([...serializeRows(rows, "ndjson", ["a", "b"])].length).toBe(2);
});

test("export iterates each table and honours literal substring filters", () => {
  const db = freshDb();
  try {
    for (const table of ["requests", "sessions", "tools", "limits"] as const) {
      const report = q.exportRows(db, table, { limit: 2 });
      expect([...report.rows].length).toBeLessThanOrEqual(2);
      expect(report.columns.length).toBeGreaterThan(0);
    }
    expect(q.attribution(db, "model", { project: "%" }).coverage.total).toBe(0);
  } finally {
    db.close();
  }
});

/** `attribution(db, "tool")` as it was before brief 06, kept here as the parity oracle. */
function toolOracle(db: Database, opts: q.RequestFilters) {
  const where = `($since IS NULL OR r.ts_ms >= $since) AND ($until IS NULL OR r.ts_ms < $until)
      AND ($project IS NULL OR instr(lower(COALESCE(r.project,'')), lower($project)) > 0)
      AND ($model IS NULL OR instr(lower(COALESCE(r.model,'')), lower($model)) > 0)`;
  const params = { $since: opts.since ?? null, $until: opts.until ?? null,
    $project: opts.project ?? null, $model: opts.model ?? null };
  const pairs = `SELECT DISTINCT t.tool_name AS key, r.message_id, r.request_id, r.session_id,
      r.input_tokens, r.output_tokens, r.thinking_tokens, r.cache_creation_tokens,
      r.cache_read_tokens, r.ephemeral_5m, r.ephemeral_1h, r.total_tokens
    FROM tool_calls t JOIN requests r ON r.session_id = t.session_id AND r.message_id = t.message_id
    WHERE t.tool_name IS NOT NULL AND ${where}`;
  const tokens = db.query(`SELECT key, COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens, COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens, COALESCE(SUM(ephemeral_5m), 0) AS ephemeral_5m,
      COALESCE(SUM(ephemeral_1h), 0) AS ephemeral_1h, COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM (${pairs}) GROUP BY key`).all(params) as (q.BreakdownRow & { calls?: number })[];
  const calls = new Map((db.query(`SELECT t.tool_name AS key, COUNT(*) AS n FROM tool_calls t
    WHERE t.tool_name IS NOT NULL AND EXISTS (SELECT 1 FROM requests r
      WHERE r.session_id = t.session_id AND r.message_id = t.message_id AND ${where})
    GROUP BY t.tool_name`).all(params) as { key: string; n: number }[]).map((r) => [r.key, r.n]));
  const rows = tokens.map((row) => ({ ...row, calls: calls.get(row.key) ?? 0 }));
  const attributed = (db.query(`SELECT COUNT(*) n FROM (SELECT DISTINCT r.message_id, r.request_id, r.session_id
    FROM tool_calls t JOIN requests r ON r.session_id = t.session_id AND r.message_id = t.message_id
    WHERE t.tool_name IS NOT NULL AND ${where})`).get(params) as { n: number }).n;
  rows.sort((a, b) => b.total_tokens - a.total_tokens || a.key.localeCompare(b.key));
  const total = (db.query(`SELECT COUNT(*) n FROM requests r WHERE ${where}`).get(params) as { n: number }).n;
  return { coverage: q.coverage(total, attributed), groups: rows.length, rows: rows.slice(0, opts.limit) };
}

function expectToolParity(db: Database, opts: q.RequestFilters) {
  const report = q.attribution(db, "tool", opts);
  const oracle = toolOracle(db, opts);
  expect({ coverage: report.coverage, groups: report.groups, rows: report.rows }).toEqual(oracle);
  // `--json` prints the rows as they are, so their key order is output too.
  expect(JSON.stringify(report.rows)).toBe(JSON.stringify(oracle.rows));
  return report;
}

test("tool attribution matches the pre-brief-06 SQL for every filter", () => {
  const db = freshDb();
  try {
    const mid = 1788450000000;
    const cases: q.RequestFilters[] = [
      {}, { since: mid }, { until: mid }, { project: "proj-06" }, { model: "opus" }, { limit: 3 },
      { since: 1788200000000, until: 1788700000000, project: "PROJ-1", model: "fable", limit: 5 },
    ];
    const all = expectToolParity(db, {});
    for (const opts of cases.slice(1)) {
      const report = expectToolParity(db, opts);
      // Each filter has to bite, or parity under it proves nothing.
      expect(report.rows).not.toEqual(all.rows);
    }
  } finally {
    db.close();
  }
});

test("tool attribution matches the pre-brief-06 SQL where a message has several requests", () => {
  const db = openDb(":memory:");
  try {
    const request = db.query(`INSERT INTO requests(message_id, request_id, session_id, ts_ms, project, model, input_tokens, output_tokens)
      VALUES (?, ?, ?, ?, 'p', 'm', ?, 1)`);
    const call = db.query("INSERT INTO tool_calls(session_id, tool_use_id, message_id, tool_name) VALUES (?, ?, ?, ?)");
    // One message, two requests; two Reads and an Edit in it.
    request.run("m1", "a", "s1", 1000, 10);
    request.run("m1", "b", "s1", 2000, 20);
    call.run("s1", "t1", "m1", "Read");
    call.run("s1", "t2", "m1", "Read");
    call.run("s1", "t3", "m1", "Edit");
    // The same message id in another session is another message.
    request.run("m1", "", "s2", 3000, 30);
    call.run("s2", "t4", "m1", "Read");
    // Calls with no request, no message or no name count nowhere.
    call.run("s1", "t5", "gone", "Read");
    call.run("s1", "t6", null, "Read");
    call.run("s1", "t7", "m1", null);
    // A request no tool reached.
    request.run("m2", "", "s1", 4000, 40);
    for (const opts of [{}, { since: 1500 }, { until: 2500 }, { since: 2500 }, { limit: 1 }])
      expectToolParity(db, opts);
    const read = q.attribution(db, "tool").rows.find((r) => r.key === "Read")!;
    expect([read.requests, read.calls, read.total_tokens]).toEqual([3, 3, 63]);
  } finally {
    db.close();
  }
});
