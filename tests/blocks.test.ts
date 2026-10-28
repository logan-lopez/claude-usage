import { expect, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb, setMeta } from "../src/schema.ts";
import { blocks, clusterResets, coverage, statusline, type MeterCycle, type RequestFilters, type TokenTotals } from "../src/query.ts";
import { scheduleStatusRefresh } from "../src/statusline.ts";
import { LAST_ATTEMPT_KEY, backfillDesktopHistory } from "../src/limits.ts";
import { FIXTURES, freshDb } from "./helpers.ts";
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

/**
 * `blocks` as it was before brief 08, totals through requestWhere's SQL, kept as the parity oracle.
 * `endPad` widens each cycle's local range, so the test can show it catches an off-by-one.
 */
function oldBlocks(db: Database, opts: RequestFilters = {}, endPad = 0) {
  const TOTALS = `COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens,
    COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens, COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
    COALESCE(SUM(ephemeral_5m), 0) AS ephemeral_5m, COALESCE(SUM(ephemeral_1h), 0) AS ephemeral_1h,
    COALESCE(SUM(total_tokens), 0) AS total_tokens`;
  const requestWhere = (o: RequestFilters) => ({
    sql: `($since IS NULL OR ts_ms >= $since) AND ($until IS NULL OR ts_ms < $until)
      AND ($project IS NULL OR instr(lower(COALESCE(project,'')), lower($project)) > 0)
      AND ($model IS NULL OR instr(lower(COALESCE(model,'')), lower($model)) > 0)`,
    params: { $since: o.since ?? null, $until: o.until ?? null, $project: o.project ?? null, $model: o.model ?? null },
  });
  const until = opts.until ?? Date.now();
  const earliest = (db.query("SELECT MIN(ts_ms) t FROM limit_samples WHERE source <> 'glaze'").get() as { t: number | null }).t;
  const since = opts.since ?? earliest ?? until;
  const samples = db.query(`SELECT ts_ms, source, five_hour_pct pct, five_hour_resets_at reset FROM limit_samples
    WHERE ts_ms >= $since AND ts_ms < $until AND source <> 'glaze' AND five_hour_pct IS NOT NULL ORDER BY ts_ms`)
    .all({ $since: since, $until: until }) as { ts_ms: number; source: string; pct: number; reset: string | null }[];
  const source = samples.some(s => s.source === "desktop-history") ? "desktop-history"
    : samples.some(s => s.source === "oauth-live") ? "oauth-live" : "oauth-cache";
  const meter = samples.filter(s => s.source === source);
  const setAside = { samples: samples.length - meter.length,
    sources: [...new Set(samples.filter(s => s.source !== source).map(s => s.source))].sort() };
  const resets = clusterResets(samples.filter(s => s.source.startsWith("oauth") && s.reset).map(s => Date.parse(s.reset!)));
  const rows: MeterCycle[] = [];
  let active: MeterCycle | null = null;
  let previous: typeof meter[number] | undefined;
  const begin = (sample: typeof meter[number], reason: MeterCycle["startReason"]) => ({
    kind: "cycle" as const, startMs: sample.ts_ms, endMs: sample.ts_ms + 1, startReason: reason,
    peakPct: sample.pct, peakAtMs: sample.ts_ms, timeToPeakMs: 0,
    resetAtMs: null, resetConfirmed: false, resetBetween: null, samples: 0, local: null,
  });
  for (const sample of meter) {
    const gap = previous && sample.ts_ms - previous.ts_ms > 30 * 60_000;
    const drop = previous && !gap && previous.pct - sample.pct >= 5 && sample.pct <= previous.pct * .5;
    if (!active) active = begin(sample, "observation");
    else if (gap) {
      active.endMs = previous!.ts_ms + 1; rows.push(active);
      rows.push({ ...begin(sample, "gap"), kind: "gap", startMs: previous!.ts_ms + 1, endMs: sample.ts_ms,
        peakPct: null, peakAtMs: null, timeToPeakMs: null });
      active = begin(sample, "gap");
    } else if (drop) {
      active.endMs = sample.ts_ms;
      active.resetBetween = [previous!.ts_ms, sample.ts_ms];
      const confirmations = resets.filter(c => c[0]! >= previous!.ts_ms - 120_000 && c.at(-1)! <= sample.ts_ms + 120_000);
      if (confirmations.length === 1) {
        active.resetAtMs = confirmations[0]![Math.floor(confirmations[0]!.length / 2)]!;
        active.resetConfirmed = true;
      }
      rows.push(active); active = begin(sample, "drop");
    }
    active.samples++;
    active.endMs = sample.ts_ms + 1;
    if (sample.pct > (active.peakPct ?? -1)) {
      active.peakPct = sample.pct; active.peakAtMs = sample.ts_ms; active.timeToPeakMs = sample.ts_ms - active.startMs;
    }
    previous = sample;
  }
  if (active) rows.push(active);
  for (const row of rows) if (row.kind === "cycle") {
    const w = requestWhere({ ...opts, since: row.startMs, until: row.endMs + endPad });
    row.local = db.query(`SELECT ${TOTALS} FROM requests WHERE ${w.sql}`).get(w.params) as TokenTotals;
  }
  const m = requestWhere(opts);
  const meta = db.query(`SELECT COUNT(*) total FROM requests WHERE ${m.sql}`).get(m.params) as { total: number };
  const covered = rows.reduce((n, r) => n + (r.local?.requests ?? 0), 0);
  return { since, until, source, setAside, lastSampleMs: meter.at(-1)?.ts_ms ?? null, samples: meter.length,
    coverage: coverage(meta.total, covered), resetToleranceMs: 120_000, gapThresholdMs: 1_800_000,
    dropRule: "drop of at least 5 percentage points and at least 50% between adjacent samples of one source",
    note: "Observed meter cycles, not inferred 5h token blocks. First/last cycles and gaps are partial. Time to peak is from first observation. Reset time is confirmed only by OAuth, otherwise bracketed by samples. Local activity is context, not explanation: historical r=0.69; 39% of intervals >=15% had no local activity.",
    cycles: rows.filter(r => r.kind === "cycle").length, rows: rows.slice(0, opts.limit) };
}

test("blocks matches the pre-brief-08 implementation for every filter, on the fixture with desktop history", async () => {
  const db = freshDb();
  try {
    await backfillDesktopHistory(db, `${FIXTURES}/plan-usage-history.json`);
    const all = blocks(db, { until: Date.UTC(2026, 9, 28) });
    const active = all.rows.filter((r) => r.local?.requests);
    expect(active.length).toBeGreaterThanOrEqual(5);
    // A request on each active cycle's end, which belongs to the cycle after it (or none), so an
    // off-by-one at either boundary changes some cycle's totals under every filter below.
    for (const [i, r] of active.entries())
      db.query(`INSERT INTO requests(message_id, request_id, session_id, ts_ms, project, model, output_tokens)
        VALUES (?, '', 'boundary', ?, 'proj-15', 'claude-fable-5-1', 7)`).run(`edge-${i}`, r.endMs);
    const inside = active[2]!.startMs + 60_000;
    const cases: RequestFilters[] = [
      {},
      { since: active[1]!.startMs },
      { since: active[1]!.startMs, until: active[4]!.endMs },
      { since: inside },
      { project: "PROJ-15" },
      { model: "Fable" },
      { since: active[0]!.startMs, until: active.at(-1)!.endMs, project: "proj-1", model: "fable" },
      { project: "", model: "" },
    ];
    setSystemTime(new Date(Date.UTC(2026, 9, 28, 12)));
    const unfiltered = JSON.stringify(blocks(db, {}).rows.map((r) => r.local));
    for (const opts of cases) {
      const expected = oldBlocks(db, opts);
      expect(blocks(db, opts)).toEqual(expected);
      if (opts.project || opts.model)
        expect(JSON.stringify(expected.rows.map((r) => r.local))).not.toBe(unfiltered);
      // The comparison is sharp enough to catch a range that ends a millisecond late.
      expect(oldBlocks(db, opts, 1)).not.toEqual(expected);
    }
    expect(blocks(db, { since: inside }).rows[0]!.startMs).toBeGreaterThanOrEqual(inside);
  } finally {
    setSystemTime();
    db.close();
  }
});
