import { test, expect } from "bun:test";
import { freshDb, totals } from "./helpers.ts";
import { openDb } from "../src/schema.ts";
import * as q from "../src/query.ts";
import { csv, serializeRows } from "../src/serialize.ts";

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
