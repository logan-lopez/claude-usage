import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../../src/schema.ts";
import {
  readOverview,
  archiveDependencies,
  openArchive,
  dataVersion,
  readTimeline,
  TIMELINE_BUCKETS,
  TIMELINE_SPLITS,
} from "../../src/tui/data.ts";
import { activitySince } from "../../src/tui/sessions.tsx";
import {
  sessionPage,
  sessionCosts,
  cost,
  limitsHistory,
  archiveStats,
  listSessions,
  timeline,
} from "../../src/query.ts";
import { doctor } from "../../src/doctor.ts";
import { costLabel } from "../../src/tui/text.ts";
import { NOW, closers, dependencies, teardown } from "./helpers.tsx";

afterEach(teardown);

test("session pages preserve CLI defaults, whole totals, literal search, filters and stable sort ties", () => {
  const { db } = dependencies();
  const all = sessionPage(db).rows;
  const s = all[0]!;
  const result = sessionPage(db, {
    search: s.session_id.toUpperCase(),
    model: s.models!.split(", ")[0],
    project: s.project?.slice(0, 3),
    since: Date.parse(s.last_ts!),
  });
  expect(result.total).toBe(1);
  expect(result.rows[0]!.total_tokens).toBe(s.total_tokens);
  expect(sessionPage(db, { search: "%" }).total).toBe(0);
  for (const sort of ["tokens", "requests", "activity"] as const) {
    const rows = sessionPage(db, { sort }).rows;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!,
        b = rows[i]!;
      const value = (r: typeof a) =>
        sort === "tokens"
          ? r.total_tokens
          : sort === "requests"
            ? r.requests
            : Date.parse(r.last_ts!);
      expect(value(a)).toBeGreaterThanOrEqual(value(b));
      if (value(a) === value(b)) expect(a.session_id < b.session_id).toBe(true);
    }
  }
  expect(listSessions(db).length).toBe(Math.min(30, all.length));
  expect(archiveStats(db).projects).toBeGreaterThan(0);
});

test("batch costs agree with existing provenance and distinguish partial from wholly unpriced", () => {
  const { db } = dependencies();
  const ids = sessionPage(db).rows.map((r) => r.session_id);
  const batch = sessionCosts(db, ids);
  for (const row of cost(db, { by: "session" }).rows) {
    expect(batch[row.key]!.cost_usd).toBeCloseTo(row.cost_usd, 8);
    expect(batch[row.key]!.basis).toBe(row.basis);
    expect(batch[row.key]!.unpriced_requests).toBe(row.unpriced_requests);
  }
  expect(sessionCosts(db, [])).toEqual({});
  expect(Object.keys(sessionCosts(db, [ids[0]!]))).toEqual([ids[0]!]);
  const estimated = Object.values(batch).find(
    (r) => r.basis === "estimated" && r.priced_requests > 0,
  )!;
  expect(costLabel(estimated)).toStartWith("~$");
  expect(costLabel({ ...estimated, cost_complete: false })).toEndWith("+");
  expect(costLabel({ ...estimated, priced_requests: 0 })).toBe("unavailable");
  expect(costLabel({ ...estimated, basis: "measured" })).toStartWith("$");
});

test("scoped history selects one exact model, preserves gaps and does not relabel other peaks", () => {
  const db = openDb(":memory:");
  closers.push(() => db.close());
  const insert = db.query(
    "INSERT INTO limit_scoped(ts_ms,source,kind,group_name,scope_model,percent,is_active) VALUES(?,'oauth-live','weekly_scoped','model',?,?,?)",
  );
  db.query(
    "INSERT INTO limit_samples(ts_ms,source,five_hour_pct) VALUES(?,'oauth-live',4)",
  ).run(NOW);
  insert.run(NOW, "Alpha", 20, 1);
  insert.run(NOW, "Beta", 99, 0);
  const h = limitsHistory(db, {
    since: NOW - 3600000,
    until: NOW,
    bucketMs: 3600000,
    nowMs: NOW,
  });
  expect(h.scopedModel).toBe("Alpha");
  expect(h.buckets.map((b) => b.scopedPct)).toEqual([null, 20]);
  expect(
    limitsHistory(db, {
      since: NOW,
      until: NOW,
      nowMs: NOW,
      scopedModel: "Beta",
    }).buckets[0]!.scopedPct,
  ).toBe(99);
});

test("daily data has thirty UTC buckets, zeros, and a partial current day", () => {
  const { db } = dependencies();
  const overview = readOverview(db, NOW);
  expect(overview.daily.length).toBe(30);
  expect(overview.daily.at(-1)!.tsMs).toBe(Date.UTC(2026, 8, 11));
  expect(overview.daily.some((r) => r.output_tokens === 0)).toBe(true);
  expect(overview.history.buckets.length).toBe(72);
  expect(activitySince("All", NOW)).toBeNull();
  expect(activitySince("Today UTC", NOW)).toBe(Date.UTC(2026, 8, 11));
});

test("archive open is read-only, does not create or migrate; existing connection detects external writes", () => {
  const dir = mkdtempSync(`${tmpdir()}/cusage-tui-`);
  closers.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = `${dir}/archive.db`;
  expect(() => openArchive(file)).toThrow("cusage sync");
  expect(existsSync(file)).toBe(false);
  expect(() => openArchive(file, true)).toThrow("cusage sync");
  expect(existsSync(file)).toBe(false);
  const writer = openDb(file);
  const reader = openArchive(file);
  const before = dataVersion(reader);
  expect(() => reader.run("INSERT INTO meta VALUES('x','y')")).toThrow();
  writer.run("INSERT INTO meta VALUES('x','y')");
  expect(dataVersion(reader)).not.toBe(before);
  reader.close();
  writer.run("PRAGMA user_version=1");
  expect(() => openArchive(file)).toThrow("schema");
  expect((writer.query("PRAGMA user_version").get() as any).user_version).toBe(
    1,
  );
  writer.close();
});

test("archive diagnostics never probe credentials and default doctor still does", async () => {
  const { db } = dependencies();
  let probes = 0;
  const deps = {
    launch: async () => ({ loaded: true, lastExit: 0 }),
    credential: async () => {
      probes++;
      return true;
    },
    head: () => null,
    size: () => 0,
    exists: () => true,
    transcriptPresent: () => true,
  };
  const archived = await doctor(db, "fixture", { archiveOnly: true, deps });
  expect(probes).toBe(0);
  expect(archived.checks.some((c) => c.name === "credential")).toBe(false);
  await doctor(db, "fixture", { deps });
  expect(probes).toBe(1);
});

test("disabled refresh never opens a writable connection", async () => {
  const { db } = dependencies();
  const previous = process.env.CUSAGE_REFRESH;
  process.env.CUSAGE_REFRESH = "off";
  try {
    const result = await archiveDependencies(
      db,
      "/does-not-exist/archive.db",
    ).refresh();
    expect(result.reason).toBe("disabled");
    expect(result.attempted).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.CUSAGE_REFRESH;
    else process.env.CUSAGE_REFRESH = previous;
  }
});

test("a WAL archive without -wal/-shm files still opens read-only and refuses writes", () => {
  const dir = mkdtempSync(`${tmpdir()}/cusage-tui-`);
  closers.push(() => rmSync(dir, { recursive: true, force: true }));
  // A copied or restored archive: checkpointed WAL-mode main file, no sidecars.
  const source = openDb(`${dir}/source.db`);
  source.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const file = `${dir}/archive.db`;
  copyFileSync(`${dir}/source.db`, file);
  source.close();
  expect(existsSync(`${file}-wal`)).toBe(false);
  const reader = openArchive(file);
  expect(dataVersion(reader)).toBeGreaterThan(0);
  expect(() => reader.run("INSERT INTO meta VALUES('x','y')")).toThrow();
  reader.close();
});

test("a session scope finds sessions with one request matching all of it, with whole-session totals", () => {
  const { db } = dependencies();
  type Req = { session_id: string; message_id: string; ts_ms: number; project: string | null; attribution_skill: string | null };
  const requests = db.query("SELECT session_id, message_id, ts_ms, project, attribution_skill FROM requests").all() as Req[];
  const calls = db.query("SELECT session_id, message_id, tool_name FROM tool_calls").all() as { session_id: string; message_id: string; tool_name: string | null }[];
  const all = sessionPage(db).rows;
  const ids = (opts: Parameters<typeof sessionPage>[1]) => sessionPage(db, opts).rows.map((r) => r.session_id).sort();
  /** The scope worked out in plain JS from the raw rows, sharing no SQL with `sessionPage`. */
  const expected = (match: (r: Req) => boolean) =>
    all.map((s) => s.session_id).filter((id) => requests.some((r) => r.session_id === id && match(r))).sort();

  // A range finds a session with a request in it that ended later, which since/until miss.
  const session = all.find((s) => s.session_id.startsWith("00000012"))!;
  const own = requests.filter((r) => r.session_id === session.session_id).sort((a, b) => a.ts_ms - b.ts_ms);
  const first = { since: own[0]!.ts_ms, until: own[0]!.ts_ms + 1 };
  expect(ids({ scope: first })).toContain(session.session_id);
  expect(ids({ scope: first })).toEqual(expected((r) => r.ts_ms >= first.since && r.ts_ms < first.until));
  expect(ids(first)).not.toContain(session.session_id);

  // Project is exact and on each request's column, not a substring of the session's own.
  expect(ids({ scope: { by: "project", key: "proj-1" } })).toEqual([]);
  expect(ids({ project: "proj-1" }).length).toBeGreaterThan(0);
  expect(session.project).toBe("proj-15");
  expect(ids({ scope: { by: "project", key: "proj-08" } })).toContain(session.session_id);
  expect(ids({ project: "proj-08" })).not.toContain(session.session_id);
  for (const key of ["proj-08", "proj-15", "proj-06"])
    expect(ids({ scope: { by: "project", key } })).toEqual(expected((r) => r.project === key));

  // A skill with a range needs one request with both: a request inside the range that used another
  // skill, or none, doesn't count.
  const skill = own.find((r) => r.attribution_skill)!.attribution_skill!;
  const other = own.find((r) => r.attribution_skill !== skill)!;
  const range = { since: other.ts_ms, until: other.ts_ms + 1 };
  expect(own.some((r) => r.ts_ms >= range.since && r.ts_ms < range.until && r.attribution_skill === skill)).toBe(false);
  expect(ids({ scope: { by: "skill", key: skill } })).toContain(session.session_id);
  expect(ids({ scope: range })).toContain(session.session_id);
  expect(ids({ scope: { ...range, by: "skill", key: skill } })).not.toContain(session.session_id);

  // A tool matches through tool_calls.
  const tool = calls.find((c) => c.tool_name === "EnterWorktree")!;
  const viaCalls = (name: string) => (r: Req) =>
    calls.some((c) => c.session_id === r.session_id && c.message_id === r.message_id && c.tool_name === name);
  expect(ids({ scope: { by: "tool", key: "EnterWorktree" } })).toEqual([tool.session_id]);
  expect(ids({ scope: { by: "tool", key: "Bash" } })).toEqual(expected(viaCalls("Bash")));

  // key: null matches NULL, not every session.
  expect(ids({ scope: { by: "skill", key: null } })).toEqual(expected((r) => r.attribution_skill === null));
  expect(ids({ scope: { by: "skill", key: "superpowers:writing-plans" } })).toEqual([session.session_id]);

  // Amounts stay whole-session, and the other filters still apply alongside the scope.
  const scoped = sessionPage(db, { scope: first }).rows.find((r) => r.session_id === session.session_id)!;
  expect(scoped).toEqual(session);
  expect(ids({ scope: { by: "project", key: "proj-08" }, search: "nothing-matches" })).toEqual([]);
  expect(() => sessionPage(db, { scope: { by: "nope" as "skill", key: "x" } })).toThrow("invalid scope dimension");
});

test("readTimeline: each bucket's totals are the unsplit timeline's, its rows the split's non-zero series", () => {
  const { db } = dependencies();
  for (const bucket of TIMELINE_BUCKETS) {
    const all = timeline(db, { bucket, until: NOW }).rows;
    for (const by of TIMELINE_SPLITS) {
      const { buckets } = readTimeline(db, bucket, by, NOW);
      expect(buckets.map((b) => b.tsMs)).toEqual(all.map((r) => r.tsMs));
      expect(buckets.map((b) => b.output)).toEqual(all.map((r) => r.output_tokens));
      for (const [i, b] of buckets.entries()) {
        const { key: _, tsMs: __, ...totals } = all[i]!;
        expect(b.total).toEqual(totals);
        // Contiguous: each bucket ends where the next begins, and the last past `until`.
        expect(b.endMs).toBe(buckets[i + 1]?.tsMs ?? b.endMs);
        expect(b.rows.every((r) => r.requests > 0)).toBe(true);
        expect(b.rows.reduce((n, r) => n + r.total_tokens, 0)).toBe(b.total.total_tokens);
        const output = b.rows.map((r) => r.output_tokens);
        expect(output).toEqual([...output].sort((x, y) => y - x));
      }
      expect(buckets.at(-1)!.endMs).toBeGreaterThan(NOW);
      if (by) expect(buckets.some((b) => b.rows.length > 1)).toBe(true);
    }
  }
  const months = readTimeline(db, "month", null, NOW).buckets;
  expect(new Date(months.at(-1)!.endMs).toISOString()).toBe("2026-10-01T00:00:00.000Z");
});
