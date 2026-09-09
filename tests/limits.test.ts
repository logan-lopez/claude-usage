import { expect, test } from "bun:test";
import { openDb } from "../src/schema.ts";
import { backfillDesktopHistory, backfillGlazeHistory, snapshotOauthCache } from "../src/limits.ts";
import { currentLimits } from "../src/query.ts";
import { FIXTURES } from "./helpers.ts";

const CLAUDE_JSON = `${FIXTURES}/claude.json`;
const DESKTOP = `${FIXTURES}/plan-usage-history.json`;
const GLAZE = `${FIXTURES}/glaze-usage-history.json`;

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
