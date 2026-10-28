import { afterEach, expect, test } from "bun:test";
import { openDb } from "../../src/schema.ts";
import { backfillDesktopHistory } from "../../src/limits.ts";
import { blocks, sessionPage, type SessionPageOptions } from "../../src/query.ts";
import { fmtWhenMs } from "../../src/time.ts";
import { readLimits, readOverview } from "../../src/tui/data.ts";
import { ZOOMS, zoomRange } from "../../src/tui/limits.tsx";
import { FIXTURES } from "../helpers.ts";
import { NOW, closers, dependencies, mount, settle, teardown, until } from "./helpers.tsx";

afterEach(teardown);

/** The cycles table's start column, top to bottom, and the selected row's. */
function cycles(frame: string) {
  const lines = frame.split("\n");
  const header = lines.findIndex((l) => l.includes("Start (UTC)") && l.includes("Reset (UTC)"));
  const rows: string[] = [];
  for (const l of lines.slice(header + 1)) {
    if (!/^[▸ ] \d{4}-\d\d-\d\d \d\d:\d\d/.test(l)) break;
    rows.push(l);
  }
  const start = (l: string) => l.slice(2, 18);
  return { rows, starts: rows.map(start), selected: rows.filter((l) => l.startsWith("▸")).map(start)[0] };
}

/** Every page the drilled list reads, with the scope it was given. */
function scopes(deps: ReturnType<typeof dependencies>["deps"]) {
  const seen: SessionPageOptions[] = [];
  const page = deps.page;
  deps.page = (opts) => (seen.push(opts), page(opts));
  return seen;
}

/** The fixture with its desktop history: 1,969 five-hour samples ending two days before NOW. */
async function open(width = 120, height = 40) {
  const fixture = dependencies();
  await backfillDesktopHistory(fixture.db, `${FIXTURES}/plan-usage-history.json`);
  const app = mount(fixture.deps, width, height);
  await until(() => app.frame().includes("Recent sessions"));
  return { ...fixture, app };
}
/** What the table should list for a zoom: `blocks()` over its range, newest first. */
const expected = (db: Parameters<typeof blocks>[0], zoom: number, width = 120) =>
  [...blocks(db, { since: zoomRange(zoom, NOW, width - 36).since, until: NOW }).rows].reverse();

test("5 shows Limits; it reads only when shown, once, after a change passed it by", async () => {
  const { app, counts, change } = await open();
  expect(app.frame().split("\n")[2]).toContain(" 5 Limits");
  expect(counts.limits).toBe(0);
  await app.key("5");
  expect(counts.limits).toBe(1);
  expect(app.frame().split("\n")[2]).toContain("▸ 5 Limits");
  expect(app.frame()).toContain("History · 72 hours · 1h peaks");
  await app.key("1");
  const reads = counts.overview;
  change();
  await until(() => counts.overview > reads);
  await settle();
  expect(counts.limits).toBe(1);
  await app.key("5");
  expect(counts.limits).toBe(2);
  await app.key("?");
  expect(app.frame()).toContain("Limits · 72 hours help");
  expect(app.frame()).toContain("5 Limits switch screens");
  expect(app.frame()).toContain("drops by at least 5 points and by half");
  expect(app.frame()).toContain("the meter also counts claude.ai and the desktop app");
});

test("Now shows each meter's source and age, every source with its figures, and a current disagreement", async () => {
  const { deps } = dependencies();
  const db = openDb(":memory:");
  closers.push(() => db.close());
  const insert = (source: string, ago: number, five: number | null, seven: number | null) =>
    db.query("INSERT INTO limit_samples(ts_ms, source, five_hour_pct, seven_day_pct) VALUES (?, ?, ?, ?)")
      .run(NOW - ago, source, five, seven);
  insert("oauth-live", 4 * 60_000, 10, 40);
  insert("desktop-history", 60_000, 10, 54);
  insert("oauth-cache", 27 * 3_600_000, 31, 37);
  insert("glaze", 60_000, 88, null);
  deps.overview = () => readOverview(db, NOW);
  deps.limits = (since, bucketMs) => readLimits(db, since, bucketMs, NOW);
  const app = mount(deps, 120, 40);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("5");
  const frame = app.frame();
  expect(frame).toContain("five_hour 10% · desktop-history · 1m ago");
  expect(frame).toContain("seven_day 54% · desktop-history · 1m ago");
  expect(frame).toContain("! disagreement seven_day: desktop-history 54% vs oauth-live 40% (14 points)");
  const source = (name: string) => frame.split("\n").find((l) => l.trimStart().startsWith(`${name} `))!;
  expect(source("oauth-live")).toMatch(/4m ago\s+10%\s+40%/);
  expect(source("oauth-cache")).toMatch(/1d ago · STALE\s+31%\s+37%/);
  expect(source("glaze")).toMatch(/88%\s+—\s+daily, inferred · not reconciled/);
  expect(source("desktop-history")).toMatch(/1m ago\s+10%\s+54%/);
  // The stale cache differs by 14 points too, but a stale source is just old.
  expect(frame).not.toContain("disagreement five_hour");
  expect(frame.match(/! disagreement/g)!.length).toBe(1);
});

test("←→ cycles 72 hours, 7 days and 30 days, each listing blocks() for its since", async () => {
  const { app, db, counts } = await open();
  await app.key("5");
  const seen: string[] = [];
  for (const [zoom, step] of [[0, "l"], [1, "l"], [2, "l"], [0, "h"], [2, ""]] as const) {
    expect(app.frame()).toContain(`History · ${ZOOMS[zoom]!.label}`);
    const rows = expected(db, zoom);
    expect(rows.length).toBeGreaterThan(0);
    const shown = cycles(app.frame());
    expect(shown.starts).toEqual(rows.slice(0, shown.rows.length).map((r) => fmtWhenMs(r.startMs)));
    const all = blocks(db, { since: zoomRange(zoom, NOW, 84).since, until: NOW });
    expect(app.frame()).toContain(`Five-hour cycles · desktop-history · ${all.cycles} cycles`);
    seen.push(String(all.cycles));
    if (step) await app.key(step);
  }
  expect(new Set(seen.slice(0, 3)).size).toBe(3);
  // Back to a zoom already read this session reuses it.
  expect(counts.limits).toBe(3);
  // The full list, by End: the oldest cycle is the last row.
  await app.key("\u001b[F");
  expect(cycles(app.frame()).selected).toBe(fmtWhenMs(expected(db, 2).at(-1)!.startMs));
});

test("Enter on a cycle drills its range and lists exactly sessionPage's sessions; Enter on a gap does nothing", async () => {
  const { app, db, deps } = await open();
  const seen = scopes(deps);
  await app.key("5");
  await app.key("ll");
  const rows = expected(db, 2);
  const busy = rows.findIndex((r) => r.kind === "cycle" && (r.local?.requests ?? 0) > 1);
  expect(busy).toBeGreaterThan(0);
  await app.key("j".repeat(busy));
  const cycle = rows[busy]!;
  expect(cycles(app.frame()).selected).toBe(fmtWhenMs(cycle.startMs));
  await app.key("\r");
  const scope = { since: cycle.startMs, until: cycle.endMs };
  expect(seen.at(-1)!.scope).toEqual(scope);
  const listed = sessionPage(db, { scope });
  expect(listed.total).toBeGreaterThan(0);
  expect(app.frame()).toContain(`Sessions · five-hour cycle ${fmtWhenMs(cycle.startMs)} UTC`);
  expect(app.frame()).toContain(`${listed.total} matching`);
  for (const r of listed.rows) expect(app.frame()).toContain((r.slug ?? r.session_id).slice(0, 12));
  await app.key("\u001b");
  expect(app.frame()).toContain("History · 30 days");
  expect(cycles(app.frame()).selected).toBe(fmtWhenMs(cycle.startMs));
  // A gap has no meter readings to drill.
  const gap = rows.findIndex((r) => r.kind === "gap");
  await app.key("\u001b[H");
  await app.key("j".repeat(gap));
  const before = app.frame();
  const reads = seen.length;
  await app.key("\r");
  expect(seen.length).toBe(reads);
  expect(app.frame()).toBe(before);
});

test("the selected cycle is kept by its start across a reread that adds a newer one", async () => {
  const { app, db } = await open();
  await app.key("5");
  await app.key("jj");
  const chosen = cycles(app.frame()).selected!;
  expect(chosen).toBe(cycles(app.frame()).starts[2]!);
  // A drop after the newest sample starts a new cycle at the top.
  const last = db.query("SELECT MAX(ts_ms) t, five_hour_pct p FROM limit_samples").get() as { t: number; p: number };
  db.query("INSERT INTO limit_samples(ts_ms, source, five_hour_pct) VALUES (?, 'desktop-history', 0)").run(last.t + 15 * 60_000);
  await app.key("r");
  expect(cycles(app.frame()).selected).toBe(chosen);
  expect(cycles(app.frame()).starts.indexOf(chosen)).toBe(3);
});

test("below 36 rows Tab switches Now and History; ↓ then Enter in one chunk drills the second cycle", async () => {
  const { app, db, deps } = await open(80, 24);
  const seen = scopes(deps);
  await app.key("5");
  expect(app.frame()).toContain("Panel 1/2: Now");
  expect(app.frame()).toContain("five_hour 9% · desktop-history");
  await app.key("\t");
  expect(app.frame()).toContain("Panel 2/2: History");
  expect(app.frame().split("\n").at(-1)!.length).toBeLessThanOrEqual(80);
  await app.key("\u001b[B\r");
  const second = expected(db, 0, 80)[1]!;
  expect(second.kind).toBe("cycle");
  expect(seen.at(-1)!.scope).toEqual({ since: second.startMs, until: second.endMs });
  expect(app.frame()).toContain(`In five-hour cycle ${fmtWhenMs(second.startMs)} UTC`);
});

test("↓ then Enter in one chunk drills the second cycle at full size", async () => {
  const { app, db, deps } = await open();
  const seen = scopes(deps);
  await app.key("5");
  await app.key("\u001b[B\r");
  const second = expected(db, 0)[1]!;
  expect(seen.at(-1)!.scope).toEqual({ since: second.startMs, until: second.endMs });
});
