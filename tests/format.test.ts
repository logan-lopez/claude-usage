import { expect, test } from "bun:test";
import {
  num, renderGroups, renderLimits, renderLimitsHistory, renderSession, renderSessions,
  setColour, sparkline, table, truncate, usd,
} from "../src/format.ts";
import {
  currentLimits, getSession, groupSessions, limitsHistory, listSessions, resolveSessionId,
} from "../src/query.ts";
import { snapshotOauthCache } from "../src/limits.ts";
import { openDb } from "../src/schema.ts";
import { FIXTURES, freshDb } from "./helpers.ts";

setColour(false);

// format.ts takes rows and returns strings. That is the entire contract, and
// it is what makes these tests possible without spawning a process.
test("num abbreviates at the documented thresholds", () => {
  expect(num(0)).toBe("0");
  expect(num(999)).toBe("999");
  expect(num(9_999)).toBe("9,999");
  expect(num(10_500)).toBe("10.5K");
  expect(num(2_500_000)).toBe("2.50M");
  expect(num(1_071_000_000)).toBe("1.07B");
  expect(num(null)).toBe("-");
});

test("usd formats to cents and marks absence", () => {
  expect(usd(14.901182)).toBe("$14.90");
  expect(usd(0)).toBe("$0.00");
  expect(usd(null)).toBe("-");
});

test("table aligns columns and handles an empty set", () => {
  const out = table(
    [{ a: "x", n: 1 }, { a: "longer", n: 4200 }],
    [{ header: "a", get: (r) => r.a }, { header: "n", get: (r) => String(r.n), align: "right" }],
  );
  const lines = out.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[1]!).toBe("x          1");
  expect(lines[2]!).toBe("longer  4200");
  expect(table([], [{ header: "a", get: () => "" }])).toContain("(none)");
});

test("one long key does not blow out the whole table", () => {
  // Real project names reach 84 characters, which padded every other column to
  // match and made the view unreadable.
  expect(truncate("short", 10)).toBe("short");
  expect(truncate("x".repeat(50), 10)).toHaveLength(10);
  const rows = groupSessions(freshDb(), "project").map((r) => ({ ...r, key: "p".repeat(120) }));
  // Only the table itself; the trailing note is prose and wraps in the terminal.
  const table = renderGroups(rows, "project").split("\n\n")[0]!.split("\n");
  expect(table.length).toBeGreaterThan(1);
  for (const line of table) expect(line.length).toBeLessThan(120);
});

test("renderGroups marks an incomplete cost column and explains why", () => {
  const rows = groupSessions(freshDb(), "project");
  const out = renderGroups(rows, "project");
  if (rows.some((r) => !r.cost_complete)) {
    expect(out).toContain("+");
    expect(out.toLowerCase()).toMatch(/unpriced|span more than one/);
  }
});

test("renderSession shows the [1m] variant that requests.model collapses", () => {
  const db = freshDb();
  const row = db
    .query("SELECT session_id FROM cost_state_models WHERE model LIKE '%[1m]%' LIMIT 1")
    .get() as { session_id: string };
  const out = renderSession(getSession(db, row.session_id)!);
  expect(out).toContain("[1m]");
  expect(out).toContain("measured");
});

test("renderSession says so when a session has no cost-state", () => {
  const db = freshDb();
  const row = db
    .query(`SELECT s.session_id FROM sessions s WHERE s.total_cost_usd IS NULL
              AND s.message_count > 0 LIMIT 1`)
    .get() as { session_id: string };
  const out = renderSession(getSession(db, row.session_id)!);
  expect(out).toContain("estimated");
  expect(out).not.toContain("measured");
});

test("renderSessions and renderLimits produce one header plus rows", () => {
  const db = freshDb();
  const rows = listSessions(db, { limit: 5 });
  expect(renderSessions(rows).split("\n")).toHaveLength(rows.length + 1);
  expect(renderLimits(null)).toContain("--limits-only");
});

// The corollary to "never present a derived number as fact" that the first
// version missed: never present a stale number as current. A bold binding
// constraint with no age, when the true figure had moved 53 -> 74, is the
// single most misleading thing this tool could print.
test("renderLimits never presents a stale number as current", async () => {
  const db = openDb(":memory:");
  await snapshotOauthCache(db, `${FIXTURES}/claude.json`);
  const cacheAt = (await Bun.file(`${FIXTURES}/claude.json`).json())
    .cachedUsageUtilization.fetchedAtMs;

  const stale = renderLimits(currentLimits(db, { nowMs: cacheAt + 27.5 * 3_600_000 }));
  expect(stale).toContain("27h");
  expect(stale).toContain("may be out of date");
  expect(stale).toContain("--refresh");

  const fresh = renderLimits(currentLimits(db, { nowMs: cacheAt + 120_000 }));
  expect(fresh).toContain("binding constraint");
  expect(fresh).not.toContain("may be out of date");
  // Provenance is on the screen either way, not only when something is wrong.
  expect(fresh).toContain("oauth-cache");
});

test("renderLimits shows both sides when current sources disagree", () => {
  const db = openDb(":memory:");
  const nowMs = Date.parse("2026-09-09T21:00:00Z");
  const add = (src: string, ago: number, fh: number, sd: number) =>
    db.query(
      `INSERT INTO limit_samples (ts_ms, source, five_hour_pct, seven_day_pct)
       VALUES (?, ?, ?, ?)`,
    ).run(nowMs - ago, src, fh, sd);
  add("oauth-live", 4 * 60_000, 10, 40);
  add("desktop-history", 60_000, 10, 54);

  const out = renderLimits(currentLimits(db, { nowMs }));
  expect(out).toContain("sources disagree");
  expect(out).toContain("54%");
  expect(out).toContain("40%");
  expect(out).toContain("neither is averaged");
});

test("a sparkline distinguishes no sample from zero", () => {
  expect(sparkline([0, 100])).toBe("▁█");
  expect(sparkline([null])).toBe("·");
  // The bug this prevents: rendering a gap as ▁ turns an outage into a
  // convincing flat line at zero usage.
  expect(sparkline([null])).not.toBe(sparkline([0]));
  expect(sparkline([50]).length).toBe(1);
  expect(sparkline([])).toBe("");
});

test("renderLimitsHistory says the scoped series is missing rather than flat", () => {
  const db = openDb(":memory:");
  const base = Date.parse("2026-09-08T00:00:00Z");
  for (let i = 0; i < 10; i++) {
    db.query(
      `INSERT INTO limit_samples (ts_ms, source, five_hour_pct, seven_day_pct)
       VALUES (?, 'desktop-history', ?, ?)`,
    ).run(base + i * 3_600_000, i * 10, 40 + i);
  }
  const out = renderLimitsHistory(
    limitsHistory(db, { since: base, until: base + 10 * 3_600_000, bucketMs: 3_600_000 }),
  );
  expect(out).toContain("Limit history");
  expect(out).toContain("seven_day");
  expect(out).toContain("no weekly_scoped samples");
  expect(out).toContain("daily peaks");
});

test("rendering never mutates its input", () => {
  const db = freshDb();
  const detail = getSession(db, resolveSessionId(db, null)!)!;
  const before = JSON.stringify(detail);
  renderSession(detail);
  expect(JSON.stringify(detail)).toBe(before);
});
