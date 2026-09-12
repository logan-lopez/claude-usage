import React from "react";
import { afterEach, expect, test } from "bun:test";
import { render, cleanup } from "ink-testing-library";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { freshDb } from "./helpers.ts";
import { openDb } from "../src/schema.ts";
import { App } from "../src/tui/App.tsx";
import {
  readOverview,
  archiveDependencies,
  openArchive,
  dataVersion,
  SessionBrowser,
  activitySince,
  type TuiDependencies,
} from "../src/tui/data.ts";
import {
  sessionPage,
  sessionCosts,
  cost,
  limitsHistory,
  archiveStats,
  listSessions,
} from "../src/query.ts";
import { doctor } from "../src/doctor.ts";
import { costLabel, fit } from "../src/tui/components.tsx";
import type { RefreshOutcome } from "../src/limits.ts";
import stringWidth from "string-width";

const NOW = Date.UTC(2026, 8, 11, 16);
const outcome: RefreshOutcome = {
  mode: "force",
  attempted: false,
  ok: false,
  reason: "guard",
  ageMs: 0,
  waitMs: 180000,
  tsMs: NOW,
  tokenSource: null,
  httpStatus: null,
  error: null,
};
const closers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
});
function dependencies() {
  const db = freshDb();
  closers.push(() => db.close());
  const counts = { overview: 0, diagnostics: 0, refresh: 0, version: 0 };
  let version = 1;
  let now = NOW;
  const deps: TuiDependencies = {
    now: () => now,
    overview: () => {
      counts.overview++;
      return readOverview(db, now);
    },
    page: (opts) => sessionPage(db, opts),
    costs: (ids) => sessionCosts(db, ids),
    detail: (id) => importDetail(db, id),
    version: () => {
      counts.version++;
      return version;
    },
    pollMs: 40,
    diagnostics: async () => {
      counts.diagnostics++;
      return {
        checkedAt: now,
        build: {} as any,
        repo: "fixture",
        checks: [{ name: "integrity", level: "ok", detail: "ok" }],
        exitCode: 0,
      };
    },
    refresh: async () => {
      counts.refresh++;
      return outcome;
    },
  };
  return {
    db,
    deps,
    counts,
    change: () => version++,
    tick: (ms: number) => (now += ms),
  };
}
import { getSession as importDetail } from "../src/query.ts";
async function settle() {
  await new Promise((r) => setTimeout(r, 35));
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Timed out waiting for frame");
}
function mount(
  deps: TuiDependencies,
  width = 120,
  height = 40,
  onQuit?: () => void,
) {
  const app = render(
    <App
      deps={deps}
      mono
      dimensions={{ columns: width, rows: height }}
      onQuit={onQuit}
    />,
  );
  Object.defineProperty(app.stdout, "columns", {
    value: width,
    configurable: true,
  });
  const frame = () => app.lastFrame() ?? "";
  const key = async (s: string) => {
    app.stdin.write(s);
    await settle();
  };
  return {
    ...app,
    frame,
    key,
    resize: async (w: number, h: number) => {
      Object.defineProperty(app.stdout, "columns", {
        value: w,
        configurable: true,
      });
      app.rerender(
        <App
          deps={deps}
          mono
          dimensions={{ columns: w, rows: h }}
          onQuit={onQuit}
        />,
      );
      await settle();
    },
  };
}

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

test("Overview → Detail → back, full layout and compact resize preserve selected identity", async () => {
  const { deps } = dependencies();
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  for (const name of [
    "Server limits",
    "Archive",
    "Meters",
    "Daily output tokens",
    "Recent sessions",
  ])
    expect(app.frame()).toContain(name);
  expect(app.frame().split("\n").length).toBeLessThanOrEqual(40);
  expect(app.frame()).toContain("q quit");
  await app.key("j");
  await app.key("\r");
  expect(app.frame()).toContain("Session Detail");
  const identity = app.frame().match(/session_id: (.*)/)?.[1];
  expect(identity).toBeTruthy();
  await app.key("\u001b");
  expect(app.frame()).toContain("Recent sessions");
  await app.resize(80, 24);
  expect(app.frame()).toContain("Panel 5/5");
  await app.key("\r");
  expect(app.frame()).toContain(identity!);
  await app.key("\u001b");
  await app.key("\t");
  expect(app.frame()).toContain("Panel 1/5");
  await app.resize(120, 40);
  await app.resize(80, 24);
  expect(app.frame()).toContain("Panel 1/5");
  await app.resize(60, 18);
  expect(app.frame()).toContain("Resize to at least 80×24");
  await app.resize(80, 24);
  expect(app.frame()).toContain("Panel 1/5");
});

test("Sessions editing and overlays own input; filters and sorting survive Detail return", async () => {
  let quits = 0;
  const { deps } = dependencies();
  const app = mount(deps, 120, 40, () => quits++);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("2");
  await app.key("/");
  await app.key("q12");
  expect(quits).toBe(0);
  expect(app.frame()).toContain("search:");
  await app.key("\r");
  expect(app.frame()).toContain("No matching sessions");
  await app.key("f");
  await app.key("q1R");
  expect(quits).toBe(0);
  expect(app.frame()).toContain("Clear all");
  await app.key("\u001b[B");
  await app.key("\u001b[B");
  await app.key("\u001b[B");
  await app.key("\r");
  expect(app.frame()).toContain("matching");
  await app.key("s");
  await app.key("\u001b[B");
  await app.key("\r");
  expect(app.frame()).toContain("sort tokens");
  await app.key("j");
  await app.key("\r");
  expect(app.frame()).toContain("Session Detail");
  await app.key("\u001b");
  expect(app.frame()).toContain("sort tokens");
  await app.key("/");
  await app.key("discard");
  await app.key("\u001b");
  expect(app.frame()).toContain("Search: —");
});

test("page navigation exceeds 100 rows and reload preserves selection by ID", async () => {
  const { db, deps, change } = dependencies();
  for (let i = 0; i < 215; i++) {
    const id = `extra-${String(i).padStart(3, "0")}`;
    db.query(
      "INSERT INTO sessions(session_id,slug,last_ts_ms,last_ts,request_count) VALUES(?,?,?,?,1)",
    ).run(id, id, NOW - i, new Date(NOW - i).toISOString());
    db.query(
      "INSERT INTO requests(message_id,request_id,session_id,input_tokens) VALUES(?,'',?,1)",
    ).run(id, id);
  }
  const b = new SessionBrowser(deps);
  expect(b.page(0).length).toBe(100);
  expect(b.row(214)?.session_id).toBe("extra-214");
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("2");
  await app.key("\u001b[F");
  expect(app.frame()).toContain(`${sessionPage(db).total} matching`);
  await app.key("\r");
  const id = app.frame().match(/session_id: (.*)/)?.[1];
  expect(id).toBeTruthy();
  await app.key("\u001b");
  db.query("UPDATE sessions SET last_ts_ms=? WHERE session_id=?").run(
    NOW + 10000,
    id!,
  );
  change();
  await until(() => app.frame().includes("1–"));
  await app.key("\r");
  expect(app.frame()).toContain(id!);
});

test("polling, manual diagnostics, guarded and failed refresh; repeated keys do not queue; quit pending", async () => {
  const { deps, counts, change } = dependencies();
  let release!: (r: RefreshOutcome) => void;
  deps.refresh = () => {
    counts.refresh++;
    return new Promise((r) => (release = r));
  };
  let quits = 0;
  const app = mount(deps, 120, 40, () => quits++);
  await until(() => counts.diagnostics === 1);
  await settle();
  const before = counts.overview;
  change();
  await until(() => counts.overview > before);
  expect(counts.diagnostics).toBe(1);
  await app.key("r");
  expect(counts.diagnostics).toBe(2);
  expect(counts.refresh).toBe(0);
  await app.key("R");
  await app.key("R");
  expect(counts.refresh).toBe(1);
  expect(app.frame()).toContain("Fetching limits");
  release(outcome);
  await until(() => app.frame().includes("guarded"));
  await app.key("R");
  release({ ...outcome, reason: "failed", error: "offline" });
  await until(() => app.frame().includes("offline"));
  expect(app.frame()).toContain("Recent sessions");
  await app.key("R");
  await app.key("q");
  expect(quits).toBe(1);
  release({ ...outcome, ok: true, reason: "ok" });
  await settle();
  expect(counts.refresh).toBe(3);
});

test("recoverable reads retain the last successful data; ages tick without expensive rereads", async () => {
  const { deps, counts, tick } = dependencies();
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  const before = counts.overview;
  tick(60000);
  await new Promise((r) => setTimeout(r, 1100));
  expect(counts.overview).toBe(before);
  deps.overview = () => {
    throw new Error("offline");
  };
  await app.key("r");
  expect(app.frame()).toContain("outdated");
  expect(app.frame()).toContain("Recent sessions");
});

test("long Unicode names stay bounded and monochrome retains markers", async () => {
  const { db, deps } = dependencies();
  db.run(
    "UPDATE sessions SET slug='界界界界界界界界界界界界界界界界界界 👩‍💻 q12'",
  );
  const app = mount(deps, 80, 24);
  await until(() => app.frame().includes("Recent sessions"));
  expect(app.frame()).toContain("▸");
  expect(app.frame()).not.toMatch(/\u001b\[[\d;]*m/);
  for (const row of app.frame().split("\n"))
    expect(stringWidth(row)).toBeLessThanOrEqual(80);
  expect(stringWidth(fit("👩‍💻界界界", 6, true))).toBe(6);
});

test("filter combinations and nonempty search preserve identity through Detail and reload", async () => {
  const { db, deps, change } = dependencies();
  const first = sessionPage(db).rows[0]!;
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("2");
  await app.key("/");
  await app.key(first.session_id);
  await app.key("\r");
  expect(app.frame()).toContain("1 matching");
  await app.key("f");
  await app.key("\r");
  await app.key(first.project ?? "");
  await app.key("\r");
  expect(app.frame()).toContain("1 matching");
  await app.key("f");
  await app.key("\u001b[B");
  await app.key("\r");
  await app.key(first.models!.split(", ")[0]!);
  await app.key("\r");
  expect(app.frame()).toContain("1 matching");
  await app.key("\r");
  expect(app.frame()).toContain(first.session_id);
  change();
  await settle();
  await app.key("\u001b");
  expect(app.frame()).toContain("1 matching");
  await app.key("\r");
  expect(app.frame()).toContain(first.session_id);
  await app.key("\t");
  expect(app.frame()).toContain("measured model cost");
  await app.key("\t");
  expect(app.frame()).toContain("unattributed requests");
  await app.key("\u001b[C");
  expect(app.frame()).toContain("Agent");
  await app.key("\t");
  expect(app.frame()).toMatch(/Call counts only|No tool calls/);
  await app.key("\t");
  expect(app.frame()).toContain("NOT server five-hour windows");
});

test("stale and disagreeing limits keep source labels, and newest model fallback is exact", async () => {
  const { db, deps, tick } = dependencies();
  db.query(
    "INSERT INTO limit_samples(ts_ms,source,five_hour_pct,seven_day_pct) VALUES(?,'oauth-live',10,20)",
  ).run(NOW);
  db.query(
    "INSERT INTO limit_samples(ts_ms,source,five_hour_pct,seven_day_pct) VALUES(?,'desktop-history',40,50)",
  ).run(NOW - 100);
  db.query(
    "INSERT INTO limit_scoped(ts_ms,source,kind,group_name,scope_model,percent,is_active) VALUES(?,'oauth-cache','weekly_scoped','model','Old model',90,0)",
  ).run(NOW - 1000);
  db.query(
    "INSERT INTO limit_scoped(ts_ms,source,kind,group_name,scope_model,percent,is_active) VALUES(?,'oauth-cache','weekly_scoped','model','New model',12,0)",
  ).run(NOW);
  expect(limitsHistory(db, { nowMs: NOW }).scopedModel).toBe("New model");
  const app = mount(deps, 80, 24);
  await until(() => app.frame().includes("Panel 5/5"));
  await app.key("\t");
  expect(app.frame()).toContain("disagreement");
  expect(app.frame()).toContain("desktop-history");
  tick(1_000_000);
  await new Promise((r) => setTimeout(r, 1100));
  expect(app.frame()).toContain("STALE");
  expect(app.frame()).not.toContain("disagreement");
  await app.key("\t");
  await app.key("\u001b[F");
  expect(app.frame()).toContain("integrity");
  await app.key("k");
  expect(app.frame()).toContain("Diagnostics checked");
});

test("empty archive, unavailable limits, no-color help, undersize quit and Ctrl+C in inputs", async () => {
  const { deps } = dependencies();
  const db = openDb(":memory:");
  closers.push(() => db.close());
  deps.overview = () => readOverview(db, NOW);
  deps.page = (opts) => sessionPage(db, opts);
  let quits = 0;
  const app = mount(deps, 80, 24, () => quits++);
  await until(() => app.frame().includes("Archive is empty"));
  expect(app.frame()).toContain("Binding limit unavailable");
  await app.key("2");
  expect(app.frame()).toContain("0 matching");
  await app.key("?");
  expect(app.frame()).toContain("Sessions help");
  await app.key("q");
  expect(quits).toBe(0);
  await app.key("\u001b");
  await app.key("/");
  await app.key("\u0003");
  expect(quits).toBe(1);
  const small = mount(deps, 60, 18, () => quits++);
  await settle();
  await small.key("q");
  expect(quits).toBe(2);
});

test("entrypoint help is available without a TTY or database, malformed options exit 2", async () => {
  for (const [args, code, text] of [
    [["--help", "--db", "/missing/archive"], 0, "Usage: cusage-tui"],
    [["--unknown"], 2, "Use cusage-tui --help"],
    [["--db"], 2, "Use cusage-tui --help"],
  ] as const) {
    const child = Bun.spawn([process.execPath, "src/tui.ts", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out =
      (await new Response(child.stdout).text()) +
      (await new Response(child.stderr).text());
    expect(await child.exited).toBe(code);
    expect(out).toContain(text);
  }
});

test("refresh completion uses current browsing state and cancellation is invoked on quit", async () => {
  const { db, deps } = dependencies();
  let release!: (r: RefreshOutcome) => void;
  let cancelled = 0;
  deps.refresh = () => new Promise((r) => (release = r));
  deps.cancelPending = () => cancelled++;
  const first = sessionPage(db).rows[0]!;
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("R");
  await app.key("2");
  await app.key("/");
  await app.key(first.session_id);
  await app.key("\r");
  expect(app.frame()).toContain("1 matching");
  release({ ...outcome, ok: true, reason: "ok" });
  await until(() => app.frame().includes("Limits refreshed"));
  expect(app.frame()).toContain("1 matching");
  await app.key("\r");
  expect(app.frame()).toContain(first.session_id);
  await app.key("q");
  expect(cancelled).toBeGreaterThan(0);
});

test("data version is sampled before rereading so a concurrent change is not lost", async () => {
  const { deps, counts, change } = dependencies();
  const original = deps.overview;
  let first = true;
  deps.overview = () => {
    const result = original();
    if (first) {
      first = false;
      change();
    }
    return result;
  };
  const app = mount(deps);
  await until(() => counts.overview >= 2);
  expect(app.frame()).toContain("Recent sessions");
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
