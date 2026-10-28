import { afterEach, expect, test } from "bun:test";
import { sessionPage, timeline, type SessionPageOptions } from "../../src/query.ts";
import { readTimeline, TIMELINE_BUCKETS, type TimelineSplit } from "../../src/tui/data.ts";
import { bookLine } from "../../src/tui/books.ts";
import { bucketLabel, cacheShare } from "../../src/tui/timeline.tsx";
import { num } from "../../src/tui/text.ts";
import { NOW, dependencies, mount, settle, teardown, until } from "./helpers.tsx";

afterEach(teardown);

/** The table's rows, top to bottom, the selected one, and the ▲ line. */
function screen(frame: string) {
  const lines = frame.split("\n");
  const header = lines.findIndex((l) => /^ {2}\S+\s+Output\s+Tokens\s+Reqs\s+Cache read/.test(l));
  const rows: string[] = [];
  for (const l of lines.slice(header + 1)) {
    if (!/^[▸ ] \S/.test(l)) break;
    rows.push(l);
  }
  const key = (l: string) => l.slice(2).split(/\s{2,}/)[0]!;
  const cursor = lines.find((l) => l.startsWith("▲ "))!.match(/^▲ (.+?)( \(partial\))?: (\S+) output tokens/)!;
  return {
    rows,
    keys: rows.map(key),
    selected: rows.filter((l) => l.startsWith("▸")).map(key)[0],
    cell: (k: string) => rows[rows.map(key).indexOf(k)]!.slice(2).split(/\s{2,}/),
    bucket: cursor[1]!,
    output: cursor[3]!,
    top: lines.find((l) => /^(days|weeks|months) · /.test(l))!,
  };
}

/** Every page the drilled list reads, with the scope it was given. */
function scopes(deps: ReturnType<typeof dependencies>["deps"]) {
  const seen: SessionPageOptions[] = [];
  const page = deps.page;
  deps.page = (opts) => (seen.push(opts), page(opts));
  return seen;
}

async function open(width = 120, height = 40) {
  const fixture = dependencies();
  const app = mount(fixture.deps, width, height);
  await until(() => app.frame().includes("Recent sessions"));
  return { ...fixture, app };
}
const days = (db: Parameters<typeof readTimeline>[0], by: TimelineSplit = null) => readTimeline(db, "day", by, NOW).buckets;
/** ←: back from the newest bucket to `index`. */
const back = (buckets: unknown[], index: number) => "h".repeat(buckets.length - 1 - index);

test("4 shows Timeline; it reads only when shown, once, after a change passed it by", async () => {
  const { app, counts, change } = await open();
  expect(app.frame().split("\n")[2]).toContain(" 4 Timeline");
  expect(counts.timeline).toBe(0);
  await app.key("4");
  expect(counts.timeline).toBe(1);
  expect(app.frame().split("\n")[2]).toContain("▸ 4 Timeline");
  await app.key("1");
  const reads = counts.overview;
  change();
  await until(() => counts.overview > reads);
  await settle();
  expect(counts.timeline).toBe(1);
  await app.key("4");
  expect(counts.timeline).toBe(2);
  await app.key("?");
  expect(app.frame()).toContain("Timeline · days · no split help");
  expect(app.frame()).toContain("4 Timeline · 5 Limits switch screens");
  expect(app.frame()).toContain("Bars are output tokens");
  expect(app.frame()).toContain("1.3 tokens a word");
  expect(app.frame()).toContain("No cost here");
});

test("b and g cycle; the ▲ line and the book line are timeline()'s output tokens for each bucket", async () => {
  const { app, db, counts } = await open();
  await app.key("4");
  for (const [i, bucket] of TIMELINE_BUCKETS.entries()) {
    if (i) await app.key("b");
    const rows = timeline(db, { bucket, until: NOW }).rows;
    const s = screen(app.frame());
    // 120 columns hold 60 bars, more than the fixture's buckets: all of them are on screen.
    const total = rows.reduce((n, r) => n + r.output_tokens, 0);
    expect(s.top).toContain(`${num(total)} output tokens ${bookLine(total)}`);
    expect(s.bucket).toBe(bucketLabel(i, rows.at(-1)!.tsMs));
    for (let j = rows.length - 1; j >= 0; j--) {
      const shown = screen(app.frame());
      expect(`${shown.bucket} ${shown.output}`).toBe(`${bucketLabel(i, rows[j]!.tsMs)} ${num(rows[j]!.output_tokens)}`);
      await app.key("h");
    }
    await app.key("l".repeat(rows.length));
  }
  await app.key("b");
  expect(screen(app.frame()).top).toStartWith("days · ");
  for (const [split, header] of [["model", "model"], ["project", "project"], ["effort", "effort"], [null, "series"]] as const) {
    await app.key("g");
    expect(app.frame()).toMatch(new RegExp(`^  ${header}\\s+Output`, "m"));
    expect(screen(app.frame()).keys.length > 1).toBe(split !== null && screen(app.frame()).keys.length > 1);
  }
  // Every bucket and split read once; the last g and b round trip reused them.
  expect(counts.timeline).toBe(3 + 3);
});

test("the table is the cursor's bucket: all equals its total, then its non-zero series; cache share by the formula", async () => {
  const { app, db } = await open();
  await app.key("4");
  const buckets = days(db, "model");
  const busy = buckets.findIndex((b) => b.rows.length > 2);
  await app.key(back(buckets, busy));
  await app.key("g");
  const slot = buckets[busy]!;
  const s = screen(app.frame());
  expect(s.bucket).toBe(bucketLabel(0, slot.tsMs));
  expect(s.keys).toEqual(["all", ...slot.rows.map((r) => r.key)]);
  expect(s.cell("all")).toEqual(["all", num(slot.total.output_tokens), num(slot.total.total_tokens), num(slot.total.requests), cacheShare(slot.total)]);
  const unsplit = timeline(db, { bucket: "day", until: NOW }).rows.find((r) => r.tsMs === slot.tsMs)!;
  expect(slot.total.total_tokens).toBe(unsplit.total_tokens);
  // Cache-read share on one fixture bucket, worked out by hand from the columns.
  const top = slot.rows[0]!;
  const share = (top.cache_read_tokens / (top.input_tokens + top.cache_creation_tokens + top.cache_read_tokens)) * 100;
  expect(share).toBeGreaterThan(0);
  expect(s.cell(top.key).at(-1)).toBe(`${share.toFixed(1)}%`);
  // A zero-filled series never shows.
  const all = timeline(db, { bucket: "day", by: "model", until: NOW }).rows.filter((r) => r.tsMs === slot.tsMs);
  expect(all.length).toBeGreaterThan(s.keys.length - 1);
});

test("the cursor keeps its bucket across r, and across b round trips; g keeps the row's key or falls back to all", async () => {
  const { app, db } = await open();
  await app.key("4");
  const buckets = days(db);
  const chosen = buckets.findIndex((b) => b.output > 0 && new Date(b.tsMs).getUTCDay() !== 1);
  await app.key(back(buckets, chosen));
  const label = bucketLabel(0, buckets[chosen]!.tsMs);
  expect(screen(app.frame()).bucket).toBe(label);
  await app.key("r");
  expect(screen(app.frame()).bucket).toBe(label);
  await app.key("b");
  const week = screen(app.frame()).bucket;
  expect(week).toStartWith("week of ");
  const weekStart = Date.parse(week.slice(8, 18));
  expect(weekStart).toBeLessThanOrEqual(buckets[chosen]!.tsMs);
  expect(buckets[chosen]!.tsMs).toBeLessThan(weekStart + 7 * 86_400_000);
  await app.key("b");
  expect(screen(app.frame()).bucket).toBe(`${label.slice(0, 7)} UTC`);
  await app.key("b");
  expect(screen(app.frame()).bucket).toBe(label);
  // g to model, choose a model, g on: project has no such key, so the row falls back to all.
  await app.key("g");
  await app.key("j");
  const model = screen(app.frame()).selected!;
  expect(model).not.toBe("all");
  await app.key("r");
  expect(screen(app.frame()).selected).toBe(model);
  await app.key("g");
  expect(screen(app.frame()).selected).toBe("all");
});

test("Enter drills the bucket, a series, or (unknown) with key null, listing sessionPage's sessions; Esc comes back", async () => {
  const { app, db, deps } = await open();
  const seen = scopes(deps);
  await app.key("4");
  const buckets = days(db, "effort");
  const busy = buckets.findIndex((b) => b.rows.some((r) => r.key === "(unknown)") && b.rows.length > 1);
  const slot = buckets[busy]!;
  const label = bucketLabel(0, slot.tsMs);
  await app.key(back(buckets, busy));
  await app.key("ggg");
  for (const [key, scope, title] of [
    ["all", { since: slot.tsMs, until: slot.endMs }, label],
    [slot.rows[0]!.key, { since: slot.tsMs, until: slot.endMs, by: "effort", key: slot.rows[0]!.key }, `${label} · effort ${slot.rows[0]!.key}`],
    ["(unknown)", { since: slot.tsMs, until: slot.endMs, by: "effort", key: null }, `${label} · effort (unknown)`],
  ] as const) {
    const at = screen(app.frame()).keys.indexOf(key);
    expect(at).toBeGreaterThanOrEqual(0);
    await app.key("\u001b[H");
    if (at) await app.key("j".repeat(at));
    await app.key("\r");
    expect(seen.at(-1)!.scope).toEqual(scope);
    const listed = sessionPage(db, { scope });
    expect(listed.total).toBeGreaterThan(0);
    expect(app.frame()).toContain(`Sessions · ${title}`);
    expect(app.frame()).toContain(`${listed.total} matching`);
    for (const r of listed.rows) expect(app.frame()).toContain((r.slug ?? r.session_id).slice(0, 12));
    await app.key("\u001b");
    expect(screen(app.frame()).bucket).toBe(label);
    expect(screen(app.frame()).selected).toBe(key);
  }
});

test("↓ then Enter in one chunk drills the second row", async () => {
  const { app, db, deps } = await open(80, 24);
  const seen = scopes(deps);
  await app.key("4");
  const buckets = days(db, "model");
  const busy = buckets.findIndex((b) => b.rows.length > 1);
  await app.key(back(buckets, busy));
  await app.key("g");
  await app.key("\u001b[B\r");
  const slot = buckets[busy]!;
  expect(seen.at(-1)!.scope).toEqual({ since: slot.tsMs, until: slot.endMs, by: "model", key: slot.rows[0]!.key });
  expect(app.frame().split("\n").at(-1)!.length).toBeLessThanOrEqual(80);
});

test("moving past the left edge scrolls the chart back in time", async () => {
  const { app, db, deps, tick } = await open(80, 24);
  // Sixty days on, the daily buckets outnumber the 40 bars 80 columns hold.
  tick(60 * 86_400_000);
  await app.key("4");
  const buckets = readTimeline(db, "day", null, deps.now()).buckets;
  expect(buckets.length).toBeGreaterThan(40);
  const first = (s: ReturnType<typeof screen>) => s.top.split(" · ")[1]!.split(" → ")[0];
  expect(first(screen(app.frame()))).toBe(bucketLabel(0, buckets.at(-40)!.tsMs).slice(0, 10));
  await app.key("h".repeat(39));
  expect(first(screen(app.frame()))).toBe(bucketLabel(0, buckets.at(-40)!.tsMs).slice(0, 10));
  await app.key("h");
  expect(first(screen(app.frame()))).toBe(bucketLabel(0, buckets.at(-41)!.tsMs).slice(0, 10));
  expect(app.frame()).toContain(`· ${buckets.length - 41} older ←`);
  await app.key("h".repeat(buckets.length));
  expect(screen(app.frame()).bucket).toBe(bucketLabel(0, buckets[0]!.tsMs));
  // Back to the right: the window stays until the cursor leaves it on that side.
  await app.key("l".repeat(39));
  expect(first(screen(app.frame()))).toBe(bucketLabel(0, buckets[0]!.tsMs).slice(0, 10));
  await app.key("l");
  expect(first(screen(app.frame()))).toBe(bucketLabel(0, buckets[1]!.tsMs).slice(0, 10));
});
