import { afterEach, expect, test } from "bun:test";
import { openDb } from "../../src/schema.ts";
import { readOverview } from "../../src/tui/data.ts";
import { sessionPage } from "../../src/query.ts";
import type { RefreshOutcome } from "../../src/limits.ts";
import { TABS } from "../../src/tui/screen.ts";
import {
  NOW,
  closers,
  dependencies,
  mount,
  outcome,
  settle,
  teardown,
  until,
} from "./helpers.tsx";

afterEach(teardown);

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

test("keys delivered in one chunk compose, and Detail scrolls back from End in one step", async () => {
  const { db, deps } = dependencies();
  const target = sessionPage(db).rows[3]!;
  const app = mount(deps, 80, 24);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("2");
  await app.key("jjj");
  await app.key("\r");
  expect(app.frame()).toContain(`ID: ${target.session_id}`);
  await app.key("\u001b[F");
  const end = app.frame().match(/↑↓ (\d+)–/)?.[1];
  expect(end).toBeTruthy();
  await app.key("k");
  expect(app.frame().match(/↑↓ (\d+)–/)?.[1]).toBe(String(Number(end) - 1));
});

test("the tab bar and digit keys come from TABS", async () => {
  const { deps } = dependencies();
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  const tabRow = () => app.frame().split("\n")[2]!;
  for (const t of TABS) expect(tabRow()).toContain(` ${t.key} `);
  for (const t of [...TABS].reverse()) {
    await app.key(t.key);
    expect(tabRow()).toContain(`▸ ${t.key} `);
    expect(tabRow().split("▸").length).toBe(2);
  }
  // A digit with no tab does nothing.
  const before = app.frame();
  await app.key(String(TABS.length + 1));
  expect(app.frame()).toBe(before);
});

/** Counts each screen's reads: a Sessions reload is one page read on the fixture's 20 sessions. */
function counted(deps: ReturnType<typeof dependencies>["deps"]) {
  const calls = { page: 0, detail: 0 };
  const page = deps.page;
  const detail = deps.detail;
  deps.page = (opts) => (calls.page++, page(opts));
  deps.detail = (id) => (calls.detail++, detail(id));
  return calls;
}

test("only the screen that's showing reloads; a stale one reloads once when it's shown", async () => {
  const { deps, counts, change } = dependencies();
  const calls = counted(deps);
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  // Startup loads Overview only.
  expect(calls).toEqual({ page: 0, detail: 0 });
  // Open Detail from Overview, then go back: Sessions and Detail are both off screen.
  await app.key("\r");
  expect(app.frame()).toContain("Session Detail");
  await app.key("\u001b");
  expect(app.frame()).toContain("Recent sessions");
  const before = { ...calls };
  const reads = counts.overview;
  change();
  await until(() => counts.overview > reads);
  await settle();
  expect(calls).toEqual(before);
  // Sessions shows its first page when first shown, from one reload.
  await app.key("2");
  expect(calls.page).toBe(before.page + 1);
  expect(app.frame()).toContain("20 matching");
  await app.key("1");
  await app.key("2");
  expect(calls.page).toBe(before.page + 1);
  // Detail was passed by too; opening it loads it fresh, with no reload on top.
  await app.key("\r");
  expect(calls.detail).toBe(before.detail + 1);
});

test("an archive change reloads the screen that's showing", async () => {
  const { deps, counts, change } = dependencies();
  const calls = counted(deps);
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("2");
  const before = calls.page;
  const reads = counts.overview;
  change();
  await until(() => counts.overview > reads);
  await settle();
  expect(calls.page).toBe(before + 1);
});

test("help shows the screen's own lines, then the shell's, with its own footer", async () => {
  const { deps } = dependencies();
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  const screens = [
    ["", "Overview · Recent sessions help", "highest reading in each hour"],
    ["2", "Sessions help", "whole-session totals"],
    ["\r", "Session Detail help", "Tools counts calls"],
  ] as const;
  for (const [key, heading, line] of screens) {
    if (key) await app.key(key);
    await app.key("?");
    expect(app.frame()).toContain(heading);
    expect(app.frame()).toContain(line);
    expect(app.frame()).toContain("1 Overview · 2 Sessions switch screens");
    expect(app.frame()).toContain("↑↓ scroll · Esc close · Ctrl+C quit");
    expect(app.frame()).not.toContain("Enter apply");
    await app.key("\u001b");
    expect(app.frame()).not.toContain(heading);
  }
  // A Sessions editor keeps its own hint.
  await app.key("\u001b");
  await app.key("/");
  expect(app.frame()).toContain("Enter apply · Esc close/cancel");
});

test("notices clear ten seconds after they appear; guarded refresh says when to retry", async () => {
  const { deps, tick } = dependencies();
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("R");
  await until(() => app.frame().includes("Refresh guarded; retry in 3m"));
  tick(9_000);
  await new Promise((r) => setTimeout(r, 1100));
  expect(app.frame()).toContain("Refresh guarded");
  tick(1_000);
  await new Promise((r) => setTimeout(r, 1100));
  expect(app.frame()).not.toContain("Refresh guarded");
  expect(app.frame()).toContain("Archive browser");
});

test("the header says it's reading until the first read lands, not zero totals", async () => {
  const { deps } = dependencies();
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  expect(app.frames[0]).toContain("Reading archive…");
  expect(app.frames[0]).not.toContain("0 tokens");
  expect(app.frame()).not.toContain("cusage ▸ Reading archive");
});

test("keys in one chunk see each other on Overview, and none reach a screen that's gone", async () => {
  const { db, deps } = dependencies();
  const second = sessionPage(db, { pageSize: 6 }).rows[1]!;
  const app = mount(deps, 80, 24);
  await until(() => app.frame().includes("Recent sessions"));
  // ↓ then Enter: Enter opens the session ↓ just moved to.
  await app.key("\u001b[B\r");
  expect(app.frame()).toContain(`ID: ${second.session_id}`);
  await app.key("\u001b");
  // Tab then ↓: the ↓ scrolls the newly focused panel, and Recent sessions keeps its selection.
  await app.key("\t\u001b[B");
  expect(app.frame()).toContain("Panel 1/5");
  await app.key("\u001b[Z");
  await app.key("\r");
  expect(app.frame()).toContain(`ID: ${second.session_id}`);
});
