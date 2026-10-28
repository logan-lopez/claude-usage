import { afterEach, expect, test } from "bun:test";
import { groupSessions, sessionPage, type SessionPageOptions } from "../../src/query.ts";
import { BREAKDOWN_DIMENSIONS, DAY, readBreakdown, type BreakdownDimension } from "../../src/tui/data.ts";
import { NOW, dependencies, mount, settle, teardown, until } from "./helpers.tsx";

afterEach(teardown);

const MONTH = NOW - 30 * DAY;

/** The table's group keys, top to bottom, and the selected one. */
function table(frame: string) {
  const lines = frame.split("\n");
  const header = lines.findIndex((l) => /^ {2}\S.*Reqs\s+Tokens\s+Output\s+Share/.test(l));
  const rows: string[] = [];
  for (const l of lines.slice(header + 1)) {
    if (!/^[▸ ] \S/.test(l)) break;
    rows.push(l);
  }
  const key = (l: string) => l.slice(2).split(/\s{2,}/)[0]!;
  return {
    header: lines[header] ?? "",
    rows,
    keys: rows.map(key),
    selected: rows.filter((l) => l.startsWith("▸")).map(key)[0],
  };
}

/** Every page the drilled list reads, with the scope it was given. */
function scopes(deps: ReturnType<typeof dependencies>["deps"]) {
  const seen: SessionPageOptions[] = [];
  const page = deps.page;
  deps.page = (opts) => (seen.push(opts), page(opts));
  return seen;
}

async function open(width = 120, height = 60) {
  const fixture = dependencies();
  const app = mount(fixture.deps, width, height);
  await until(() => app.frame().includes("Recent sessions"));
  return { ...fixture, app };
}

/** ←→ from project to `by`, the short way round. */
const steps = (by: BreakdownDimension) => {
  const i = BREAKDOWN_DIMENSIONS.indexOf(by);
  return i <= BREAKDOWN_DIMENSIONS.length / 2 ? "l".repeat(i) : "h".repeat(BREAKDOWN_DIMENSIONS.length - i);
};

test("3 shows Breakdown; it reads only when shown, once, after a change passed it by", async () => {
  const { app, counts, change } = await open();
  expect(app.frame().split("\n")[2]).toContain(" 3 Breakdown");
  expect(counts.breakdown).toBe(0);
  await app.key("3");
  expect(counts.breakdown).toBe(1);
  expect(app.frame().split("\n")[2]).toContain("▸ 3 Breakdown");
  expect(app.frame()).toContain("project · last 30 days");
  await app.key("1");
  const reads = counts.overview;
  change();
  await until(() => counts.overview > reads);
  await settle();
  expect(counts.breakdown).toBe(1);
  await app.key("3");
  expect(counts.breakdown).toBe(2);
  await app.key("?");
  expect(app.frame()).toContain("Breakdown · project help");
  expect(app.frame()).toContain("3 Breakdown · 5 Limits switch screens");
  expect(app.frame()).toContain("some of the group's sessions were left out");
});

test("every dimension lists its groups in token order, with sessions and cost only where they're exact", async () => {
  const { app, db } = await open();
  await app.key("3");
  for (const [i, by] of BREAKDOWN_DIMENSIONS.entries()) {
    if (i) await app.key("l");
    expect(app.frame()).toContain(`· last 30 days`);
    const expected = readBreakdown(db, by, { since: MONTH });
    const t = table(app.frame());
    expect(`${by}: ${t.keys.join(" ")}`).toBe(`${by}: ${expected.rows.map((r) => r.key).join(" ")}`);
    const tokens = expected.rows.map((r) => r.total_tokens);
    expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
    expect(t.header.includes("Sess") && t.header.includes("Cost")).toBe(expected.priced);
    expect(t.header.includes("Calls")).toBe(by === "tool");
    expect(app.frame().includes("Tool groups overlap")).toBe(by === "tool");
  }
  expect(readBreakdown(db, "project", { since: MONTH }).priced).toBe(true);
  expect(readBreakdown(db, "model", { since: MONTH }).priced).toBe(true);
});

test("a group whose sessions span groups shows only exact cost, marked +", async () => {
  const { app, db } = await open();
  await app.key("3");
  const groups = groupSessions(db, "project", { since: MONTH });
  const split = groups.find((g) => g.sessions_split > 0 && g.cost_usd > 0) ?? groups.find((g) => g.sessions_split > 0)!;
  const whole = groups.find((g) => g.cost_complete)!;
  const t = table(app.frame());
  const line = (key: string) => t.rows[t.keys.indexOf(key)]!;
  expect(line(split.key).trimEnd()).toEndWith(` $${split.cost_usd.toFixed(2)}+`);
  expect(line(split.key)).toContain(` ${split.sessions} `);
  expect(line(whole.key).trimEnd()).toEndWith(` $${whole.cost_usd.toFixed(2)}`);
  // Exact or absent: the column never adds up past what the sessions themselves recorded.
  const recorded = (db.query("SELECT COALESCE(SUM(total_cost_usd), 0) c FROM sessions").get() as { c: number }).c;
  expect(groups.reduce((n, g) => n + g.cost_usd, 0)).toBeLessThan(recorded);
});

test("w cycles 30 days, 7 days and all time, each matching the query for its since", async () => {
  const { app, db, deps, tick } = await open();
  // Move the clock so the fixture straddles 30 days back and the three windows differ.
  tick(20 * DAY);
  await app.key("3");
  const now = deps.now();
  const seen: string[] = [];
  for (const [label, since] of [
    ["last 30 days", now - 30 * DAY],
    ["last 7 days", now - 7 * DAY],
    ["all time", null],
    ["last 30 days", now - 30 * DAY],
  ] as const) {
    expect(app.frame()).toContain(`project · ${label}`);
    const keys = readBreakdown(db, "project", { since }).rows.map((r) => r.key);
    expect(table(app.frame()).keys).toEqual(keys);
    seen.push(keys.join(" "));
    await app.key("w");
  }
  expect(new Set(seen.slice(0, 3)).size).toBe(3);
  // Two w's that queued behind a slow frame arrive as one string, and both count: 7 days → 30.
  expect(app.frame()).toContain("project · last 7 days");
  await app.key("ww");
  expect(app.frame()).toContain("project · last 30 days");
});

test("the selection is kept by key across a reread and a dimension round trip", async () => {
  const { app, db, counts } = await open();
  await app.key("3");
  await app.key("jj");
  const chosen = table(app.frame()).selected!;
  expect(chosen).toBe(table(app.frame()).keys[2]!);
  // The last group jumps to the top on the next read, so the chosen one moves down a row.
  const last = table(app.frame()).keys.at(-1)!;
  db.run("UPDATE requests SET output_tokens = output_tokens + 1000000000 WHERE project = ?", [last]);
  await app.key("r");
  expect(table(app.frame()).keys[0]).toBe(last);
  expect(table(app.frame()).selected).toBe(chosen);
  expect(table(app.frame()).keys.indexOf(chosen)).toBe(3);
  // Model and back: the read is reused, and project's selection is where it was.
  const reads = counts.breakdown;
  await app.key("l");
  await app.key("j");
  await app.key("h");
  expect(table(app.frame()).selected).toBe(chosen);
  await app.key("l");
  expect(table(app.frame()).selected).toBe(table(app.frame()).keys[1]);
  expect(counts.breakdown).toBe(reads + 1);
});

test("Enter on a skill lists exactly that skill's sessions in the window, whole; Esc comes back to the row", async () => {
  const { app, db, deps } = await open();
  const seen = scopes(deps);
  await app.key("3");
  await app.key(steps("skill"));
  await app.key("j");
  const key = table(app.frame()).selected!;
  expect(key).toBe(readBreakdown(db, "skill", { since: MONTH }).rows[1]!.key);
  await app.key("\r");
  const scope = { since: MONTH, by: "skill" as const, key };
  expect(seen.at(-1)!.scope).toEqual(scope);
  const listed = sessionPage(db, { scope });
  expect(listed.total).toBeGreaterThan(0);
  expect(app.frame()).toContain(`Sessions · skill ${key} · last 30 days`);
  expect(app.frame()).toContain(`${listed.total} matching`);
  // Whole-session totals: each session's own tokens, not the part that used the skill.
  const group = readBreakdown(db, "skill", { since: MONTH }).rows[1]!;
  expect(listed.rows.reduce((n, r) => n + r.total_tokens, 0)).toBeGreaterThan(group.total_tokens);
  for (const r of listed.rows) expect(app.frame()).toContain((r.slug ?? r.session_id).slice(0, 12));
  await app.key("\u001b");
  expect(app.frame()).toContain("skill · last 30 days");
  expect(table(app.frame()).selected).toBe(key);
});

test("an (unknown) group drills with key null", async () => {
  const { app, db, deps } = await open();
  const seen = scopes(deps);
  await app.key("3");
  await app.key(steps("entrypoint"));
  const at = table(app.frame()).keys.indexOf("(unknown)");
  expect(at).toBeGreaterThan(0);
  await app.key("j".repeat(at));
  await app.key("\r");
  expect(seen.at(-1)!.scope).toEqual({ since: MONTH, by: "entrypoint", key: null });
  const listed = sessionPage(db, { scope: { since: MONTH, by: "entrypoint", key: null } });
  expect(listed.total).toBeGreaterThan(0);
  expect(app.frame()).toContain(`${listed.total} matching`);
});

test("↓ then Enter in one chunk drills into the second row", async () => {
  const { app, db, deps } = await open(80, 24);
  const seen = scopes(deps);
  await app.key("3");
  await app.key("\u001b[B\r");
  const second = readBreakdown(db, "project", { since: MONTH }).rows[1]!.key;
  expect(seen.at(-1)!.scope).toEqual({ since: MONTH, by: "project", key: second });
  expect(app.frame()).toContain(`Sessions · project ${second}`);
});
