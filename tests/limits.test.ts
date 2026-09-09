import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/schema.ts";
import {
  backfillDesktopHistory, backfillGlazeHistory, recordUtilization, snapshotOauthCache,
} from "../src/limits.ts";
import { chooseBucket, currentLimits, limitsHistory } from "../src/query.ts";
import { FIXTURES } from "./helpers.ts";

const CLAUDE_JSON = `${FIXTURES}/claude.json`;
const DESKTOP = `${FIXTURES}/plan-usage-history.json`;
const GLAZE = `${FIXTURES}/glaze-usage-history.json`;

const cached = async () => (await Bun.file(CLAUDE_JSON).json()).cachedUsageUtilization;

/** A bare desktop-shaped reading, for constructing precise clock scenarios. */
function sample(
  db: Database,
  source: string,
  tsMs: number,
  fh: number | null,
  sd: number | null,
): void {
  db.query(
    `INSERT INTO limit_samples (ts_ms, source, five_hour_pct, seven_day_pct)
     VALUES (?, ?, ?, ?)`,
  ).run(tsMs, source, fh, sd);
}

test("the oauth cache snapshot reproduces the server response exactly", async () => {
  const db = openDb(":memory:");
  await snapshotOauthCache(db, CLAUDE_JSON);
  const source = (await Bun.file(CLAUDE_JSON).json()).cachedUsageUtilization;
  const now = currentLimits(db)!;

  expect(now.fiveHourPct).toBe(source.utilization.five_hour.utilization);
  expect(now.fiveHourResetsAt).toBe(source.utilization.five_hour.resets_at);
  expect(now.sevenDayPct).toBe(source.utilization.seven_day.utilization);
  expect(now.sevenDayResetsAt).toBe(source.utilization.seven_day.resets_at);

  // Every entry of limits[] round-trips, including scope and is_active.
  expect(now.scoped.length).toBe(source.utilization.limits.length);
  for (const l of source.utilization.limits) {
    const got = now.scoped.find(
      (r) => r.kind === l.kind && r.scope_model === (l.scope?.model?.display_name ?? ""),
    );
    expect(got).toBeDefined();
    expect(got!.percent).toBe(l.percent);
    expect(got!.severity).toBe(l.severity);
    expect(got!.resets_at).toBe(l.resets_at);
    expect(got!.is_active).toBe(!!l.is_active);
  }
});

test("weekly_scoped is surfaced and identified as the binding constraint", async () => {
  const db = openDb(":memory:");
  await snapshotOauthCache(db, CLAUDE_JSON);
  const now = currentLimits(db)!;
  // The tray shows the weekly_all number. weekly_scoped is higher and is the
  // one that actually binds; nothing else installed surfaces it.
  const scoped = now.scoped.find((r) => r.kind === "weekly_scoped")!;
  expect(scoped).toBeDefined();
  expect(scoped.is_active).toBe(true);
  expect(scoped.scope_model).toBe("Fable");
  expect(scoped.percent).toBeGreaterThan(now.sevenDayPct!);
  expect(now.scoped[0]!.is_active).toBe(true); // active row sorts first
});

test("the open set of codename buckets is archived, not dropped", async () => {
  const db = openDb(":memory:");
  await snapshotOauthCache(db, CLAUDE_JSON);
  const now = currentLimits(db)!;
  const source = (await Bun.file(CLAUDE_JSON).json()).cachedUsageUtilization.utilization;
  const named = new Set(["five_hour", "seven_day", "extra_usage", "limits", "spend", "member_dashboard_available"]);
  for (const k of Object.keys(source)) {
    if (!named.has(k)) expect(now.buckets).toHaveProperty(k);
  }
});

test("snapshotting twice against an unchanged cache adds no rows", async () => {
  const db = openDb(":memory:");
  await snapshotOauthCache(db, CLAUDE_JSON);
  await snapshotOauthCache(db, CLAUDE_JSON);
  await snapshotOauthCache(db, CLAUDE_JSON);
  const n = db.query("SELECT COUNT(*) c FROM limit_samples").get() as { c: number };
  expect(n.c).toBe(1);
});

test("desktop history backfills at 15-minute cadence and is idempotent", async () => {
  const db = openDb(":memory:");
  const n = await backfillDesktopHistory(db, DESKTOP);
  const source = await Bun.file(DESKTOP).json();
  expect(n).toBe(source.samples.length);
  expect(n).toBeGreaterThan(1500);

  await backfillDesktopHistory(db, DESKTOP);
  const rows = db
    .query("SELECT COUNT(*) c FROM limit_samples WHERE source = 'desktop-history'")
    .get() as { c: number };
  expect(rows.c).toBe(n);

  const span = db
    .query("SELECT MIN(ts_ms) lo, MAX(ts_ms) hi FROM limit_samples WHERE source = 'desktop-history'")
    .get() as { lo: number; hi: number };
  const days = (span.hi - span.lo) / 86_400_000;
  expect(days).toBeGreaterThan(25); // the rolling 30-day cap
  const medianGapMin = (span.hi - span.lo) / (n - 1) / 60_000;
  expect(medianGapMin).toBeLessThan(25);
});

test("glaze days land in five_hour, tagged so they can be filtered out", async () => {
  const db = openDb(":memory:");
  const n = await backfillGlazeHistory(db, GLAZE);
  expect(n).toBe(Object.keys(await Bun.file(GLAZE).json()).length);
  const rows = db
    .query("SELECT five_hour_pct, seven_day_pct, raw_buckets FROM limit_samples WHERE source = 'glaze'")
    .all() as { five_hour_pct: number; seven_day_pct: number | null; raw_buckets: string }[];
  for (const r of rows) {
    expect(r.five_hour_pct).not.toBeNull();
    // Which meter Glaze records is inferred, not documented, so seven_day is
    // left empty rather than filled with a guess.
    expect(r.seven_day_pct).toBeNull();
    expect(JSON.parse(r.raw_buckets).metric).toContain("inferred");
  }
});

test("sources stay distinguishable in the archive", async () => {
  const db = openDb(":memory:");
  await snapshotOauthCache(db, CLAUDE_JSON);
  await backfillDesktopHistory(db, DESKTOP);
  await backfillGlazeHistory(db, GLAZE);
  const bySource = db
    .query("SELECT source, COUNT(*) c FROM limit_samples GROUP BY source ORDER BY source")
    .all() as { source: string; c: number }[];
  expect(bySource.map((r) => r.source)).toEqual(["desktop-history", "glaze", "oauth-cache"]);
});

/* ------------------------------------------------------- reconciliation -- */

// The bug this whole section exists for: `cusage limits` read only
// source='oauth-cache' and printed a bold 37% weekly while the desktop series
// sitting in the same database -- and the app on screen -- said 54%. The cache
// was 27 hours old. Nothing was mis-archived; the query chose the wrong row.
test("a stale oauth cache never outranks a current desktop reading", async () => {
  const db = openDb(":memory:");
  await snapshotOauthCache(db, CLAUDE_JSON);
  const cacheAt = (await cached()).fetchedAtMs;
  const nowMs = cacheAt + 27.5 * 3_600_000;
  sample(db, "desktop-history", nowMs - 6 * 60_000, 1, 54);

  const l = currentLimits(db, { nowMs })!;
  expect(l.sevenDay!.source).toBe("desktop-history");
  expect(l.sevenDayPct).toBe(54);
  expect(l.sevenDay!.ageMs).toBe(6 * 60_000);

  // The loser is not discarded, it is labelled. Being able to see that the
  // cache says 37 and is a day old is the point.
  const stale = l.sources.find((s) => s.source === "oauth-cache")!;
  expect(stale.sevenDayPct).toBe((await cached()).utilization.seven_day.utilization);
  expect(stale.ageMs).toBeGreaterThan(24 * 3_600_000);
});

test("a stale binding constraint is marked stale rather than presented as now", async () => {
  const db = openDb(":memory:");
  await snapshotOauthCache(db, CLAUDE_JSON);
  const cacheAt = (await cached()).fetchedAtMs;

  const old = currentLimits(db, { nowMs: cacheAt + 27.5 * 3_600_000 })!;
  expect(old.binding!.kind).toBe("weekly_scoped");
  expect(old.scopedStale).toBe(true);
  expect(old.scopedAgeMs!).toBeGreaterThan(24 * 3_600_000);

  const fresh = currentLimits(db, { nowMs: cacheAt + 60_000 })!;
  expect(fresh.scopedStale).toBe(false);
});

test("a live fetch supersedes the cache for the scoped breakdown", async () => {
  const db = openDb(":memory:");
  await snapshotOauthCache(db, CLAUDE_JSON);
  const cacheAt = (await cached()).fetchedAtMs;
  const nowMs = cacheAt + 27.5 * 3_600_000;

  // What the endpoint actually returned when this was implemented: the tray
  // number had moved 37 -> 54 and Fable 53 -> 74 while the cache sat still.
  const live = structuredClone((await cached()).utilization);
  live.seven_day.utilization = 54;
  for (const lim of live.limits) {
    if (lim.kind === "weekly_all") lim.percent = 54;
    if (lim.kind === "weekly_scoped") lim.percent = 74;
  }
  recordUtilization(db, live, { source: "oauth-live", tsMs: nowMs - 120_000 });

  const l = currentLimits(db, { nowMs })!;
  expect(l.scopedSource).toBe("oauth-live");
  expect(l.scopedStale).toBe(false);
  expect(l.binding!.kind).toBe("weekly_scoped");
  expect(l.binding!.percent).toBe(74);
  expect(l.sevenDayPct).toBe(54);
  expect(l.sevenDay!.source).toBe("oauth-live");
});

test("two current sources that disagree are reported, not averaged", async () => {
  const db = openDb(":memory:");
  const nowMs = Date.parse("2026-09-09T21:00:00Z");
  sample(db, "oauth-live", nowMs - 4 * 60_000, 10, 40);
  sample(db, "desktop-history", nowMs - 60_000, 10, 54);

  const l = currentLimits(db, { nowMs })!;
  expect(l.sevenDayPct).toBe(54); // fresher wins
  const dis = l.disagreements.find((x) => x.metric === "seven_day")!;
  expect(dis).toBeDefined();
  expect(dis.other.source).toBe("oauth-live");
  expect(dis.deltaPoints).toBe(14);
  // five_hour agrees to the point, so it produces nothing.
  expect(l.disagreements.some((x) => x.metric === "five_hour")).toBe(false);
});

test("a stale source does not count as a disagreement, only as stale", async () => {
  const db = openDb(":memory:");
  const nowMs = Date.parse("2026-09-09T21:00:00Z");
  sample(db, "oauth-cache", nowMs - 27 * 3_600_000, 31, 37);
  sample(db, "desktop-history", nowMs - 60_000, 1, 54);

  const l = currentLimits(db, { nowMs })!;
  expect(l.disagreements).toEqual([]);
  expect(l.sources.find((s) => s.source === "oauth-cache")!.ageMs).toBe(27 * 3_600_000);
});

test("glaze is archived but never reconciled from", async () => {
  const db = openDb(":memory:");
  const nowMs = Date.parse("2026-09-09T21:00:00Z");
  sample(db, "desktop-history", nowMs - 30 * 60_000, 1, 54);
  // Deliberately the freshest row in the table, and deliberately ignored: it
  // is a daily high-water mark of an inferred metric, not a reading of now.
  sample(db, "glaze", nowMs - 60_000, 88, null);

  const l = currentLimits(db, { nowMs })!;
  expect(l.fiveHour!.source).toBe("desktop-history");
  expect(l.fiveHourPct).toBe(1);
  expect(l.sources.find((s) => s.source === "glaze")!.reconcilable).toBe(false);
});

test("a meter is taken from the newest row that actually has it", async () => {
  const db = openDb(":memory:");
  const nowMs = Date.parse("2026-09-09T21:00:00Z");
  sample(db, "desktop-history", nowMs - 20 * 60_000, 12, 54);
  sample(db, "desktop-history", nowMs - 5 * 60_000, 12, null); // sd missing

  const l = currentLimits(db, { nowMs })!;
  expect(l.fiveHour!.ageMs).toBe(5 * 60_000);
  // A null must not shadow the reading behind it into "unknown".
  expect(l.sevenDayPct).toBe(54);
  expect(l.sevenDay!.ageMs).toBe(20 * 60_000);
});

test("an empty archive reconciles to null rather than to zero", () => {
  expect(currentLimits(openDb(":memory:"))).toBeNull();
});

/* ---------------------------------------------------------- write fixes -- */

test("today's glaze day is never stamped in the future, and stays one row", async () => {
  const dir = mkdtempSync(`${tmpdir()}/cusage-glaze-`);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const file = `${dir}/usage-history.json`;
    await Bun.write(file, JSON.stringify({ "2026-07-28": 56, [today]: 42 }));

    const db = openDb(":memory:");
    const t1 = Date.parse(`${today}T09:00:00.000Z`);
    await backfillGlazeHistory(db, file, t1);
    let rows = db
      .query("SELECT ts_ms FROM limit_samples WHERE source='glaze' ORDER BY ts_ms")
      .all() as { ts_ms: number }[];
    expect(rows).toHaveLength(2);
    expect(Math.max(...rows.map((r) => r.ts_ms))).toBe(t1);

    // Re-running later moves today's row forward instead of adding a second
    // one. Without the dedupe this grew by a row every 15 minutes.
    const t2 = t1 + 90 * 60_000;
    await backfillGlazeHistory(db, file, t2);
    rows = db
      .query("SELECT ts_ms FROM limit_samples WHERE source='glaze' ORDER BY ts_ms")
      .all() as { ts_ms: number }[];
    expect(rows).toHaveLength(2);
    expect(Math.max(...rows.map((r) => r.ts_ms))).toBe(t2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the desktop mirror rewrites only its tail on a second pass", async () => {
  const db = openDb(":memory:");
  const first = await backfillDesktopHistory(db, DESKTOP);
  const total = (
    db.query("SELECT COUNT(*) c FROM limit_samples WHERE source='desktop-history'").get() as
      { c: number }
  ).c;

  const second = await backfillDesktopHistory(db, DESKTOP);
  expect(second).toBeLessThan(first / 10); // an hour of overlap, not 30 days
  expect(second).toBeGreaterThan(0); // and not nothing, so late edits still land
  const after = (
    db.query("SELECT COUNT(*) c FROM limit_samples WHERE source='desktop-history'").get() as
      { c: number }
  ).c;
  expect(after).toBe(total);
});

/* -------------------------------------------------------------- history -- */

test("history buckets hold the peak and keep gaps as gaps", () => {
  const db = openDb(":memory:");
  const base = Date.parse("2026-09-09T00:00:00Z");
  const hour = 3_600_000;
  sample(db, "desktop-history", base + 5 * 60_000, 10, 50);
  sample(db, "desktop-history", base + 40 * 60_000, 90, 51); // same bucket, higher
  // hour 1 deliberately left empty
  sample(db, "desktop-history", base + 2 * hour, 20, 52);

  const h = limitsHistory(db, {
    since: base, until: base + 3 * hour, bucketMs: hour, nowMs: base + 3 * hour,
  });
  expect(h.buckets).toHaveLength(4);
  expect(h.buckets[0]!.fiveHourPct).toBe(90);
  expect(h.buckets[0]!.samples).toBe(2);
  // An empty hour is null, never 0 -- "no sample" and "0%" are different facts
  // and a sparkline that conflates them invents a quiet period.
  expect(h.buckets[1]!.fiveHourPct).toBeNull();
  expect(h.buckets[1]!.samples).toBe(0);
  expect(h.buckets[2]!.sevenDayPct).toBe(52);
});

test("history excludes glaze unless asked, and says which sources it used", async () => {
  const db = openDb(":memory:");
  await backfillDesktopHistory(db, DESKTOP);
  await backfillGlazeHistory(db, GLAZE);
  const span = db
    .query("SELECT MIN(ts_ms) lo, MAX(ts_ms) hi FROM limit_samples")
    .get() as { lo: number; hi: number };

  const without = limitsHistory(db, { since: span.lo, until: span.hi });
  expect(without.sources.map((s) => s.source)).not.toContain("glaze");

  const with_ = limitsHistory(db, { since: span.lo, until: span.hi, includeGlaze: true });
  expect(with_.sources.map((s) => s.source)).toContain("glaze");
  expect(with_.totalSamples).toBeGreaterThan(without.totalSamples);
});

test("the scoped series is reported as absent rather than as zero", async () => {
  const db = openDb(":memory:");
  await backfillDesktopHistory(db, DESKTOP);
  const span = db
    .query("SELECT MIN(ts_ms) lo, MAX(ts_ms) hi FROM limit_samples")
    .get() as { lo: number; hi: number };
  const h = limitsHistory(db, { since: span.lo, until: span.hi });
  // The desktop series carries fh/sd only. weekly_scoped exists nowhere on
  // disk, which is precisely why the live fetch had to be built.
  expect(h.scopedSamples).toBe(0);
  expect(h.scopedModel).toBeNull();
  expect(h.buckets.every((b) => b.scopedPct === null)).toBe(true);
});

test("bucket width scales with the window so the series stays printable", () => {
  expect(chooseBucket(6 * 3_600_000)).toBe(5 * 60_000);
  expect(chooseBucket(7 * 86_400_000)).toBe(2 * 3_600_000);
  expect(chooseBucket(365 * 86_400_000)).toBe(86_400_000); // clamps, never explodes
  // A year of history must not try to print 105,000 columns.
  for (const span of [3_600_000, 86_400_000, 30 * 86_400_000, 400 * 86_400_000]) {
    expect(span / chooseBucket(span)).toBeLessThanOrEqual(400);
  }
});
