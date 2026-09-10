import { expect, test } from "bun:test";
import { openDb, setMeta } from "../src/schema.ts";
import { blocks, clusterResets, statusline } from "../src/query.ts";
import { scheduleStatusRefresh } from "../src/statusline.ts";
import { LAST_ATTEMPT_KEY } from "../src/limits.ts";
import { renderStatusline } from "../src/format.ts";

test("cycles use same-source drops, tolerance-cluster resets, and preserve gaps", () => {
  const db = openDb(":memory:");
  const base = Date.parse("2026-09-01T00:00:00Z"),
    m = 60_000;
  try {
    for (const [offset, pct] of [
      [0, 15],
      [15, 30],
      [30, 2],
      [45, 8],
      [120, 1],
    ])
      db.query(
        "INSERT INTO limit_samples(ts_ms,source,five_hour_pct) VALUES (?,'desktop-history',?)",
      ).run(base + offset! * m, pct!);
    for (const [offset, reset] of [
      [1, 29],
      [16, 30],
    ])
      db.query(
        "INSERT INTO limit_samples(ts_ms,source,five_hour_pct,five_hour_resets_at) VALUES (?,'oauth-live',99,?)",
      ).run(base + offset! * m, new Date(base + reset! * m).toISOString());
    for (const [i, offset] of [10, 30, 60, 120].entries())
      db.query(
        "INSERT INTO requests(message_id,request_id,session_id,ts_ms,output_tokens) VALUES (?, '', 's', ?, 10)",
      ).run(String(i), base + offset * m);
    const report = blocks(db, { since: base, until: base + 121 * m });
    expect(report.rows.map((r) => r.kind)).toEqual([
      "cycle",
      "cycle",
      "gap",
      "cycle",
    ]);
    expect(report.rows[0]!.peakPct).toBe(30);
    expect(report.rows[0]!.resetConfirmed).toBe(true);
    expect(report.rows[0]!.timeToPeakMs).toBe(15 * m);
    expect(report.rows[0]!.local!.requests).toBe(1);
    expect(report.rows[1]!.local!.requests).toBe(1);
    expect(report.rows[2]!.local).toBeNull();
    expect(report.coverage).toEqual({
      total: 4,
      attributed: 3,
      unattributed: 1,
      percent: 75,
    });
    expect(
      clusterResets([base, base + m, base + 2 * m, base + 3 * m]).map(
        (c) => c.length,
      ),
    ).toEqual([3, 1]);
  } finally {
    db.close();
  }
});

test("statusline is one archived line with age markers and respects the attempt floor", () => {
  const db = openDb(":memory:");
  try {
    db.query(
      "INSERT INTO limit_samples(ts_ms,source,five_hour_pct) VALUES (1000,'oauth-live',42)",
    ).run();
    const output = renderStatusline(
      statusline(db, Date.parse("2026-09-01T01:00:00Z")),
    );
    expect(output.trim().split("\n").length).toBe(1);
    expect(output).toContain("ago");
    expect(output).toContain("42%");
    // Tokens, not cost: `cost --by day` excludes the in-progress session, so a
    // dollar figure here would read $0.00 for most of the day. See query.ts.
    expect(output).toContain("tok");
    expect(output).not.toContain("$");
    setMeta(db, LAST_ATTEMPT_KEY, String(Date.now()));
    expect(scheduleStatusRefresh(db, "unused", "force")).toBe(false);
    expect(scheduleStatusRefresh(db, "unused", "off")).toBe(false);
  } finally {
    db.close();
  }
});
