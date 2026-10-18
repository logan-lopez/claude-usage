import { afterEach, expect, test } from "bun:test";
import { SessionBrowser } from "../../src/tui/data.ts";
import { sessionPage } from "../../src/query.ts";
import { NOW, dependencies, mount, settle, teardown, until } from "./helpers.tsx";

afterEach(teardown);

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
  const id = app.frame().match(/ID: (.*)/)?.[1];
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

test("the Sessions table at 80×24 has no blank body row", async () => {
  const { deps } = dependencies();
  const app = mount(deps, 80, 24);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("2");
  // 19 content rows: three above the table, its header, and 15 sessions.
  expect(app.frame()).toContain("1–15 visible");
  const lines = app.frame().split("\n");
  const header = lines.findIndex((l) => l.includes("Name / project"));
  const body = lines.slice(header + 1, header + 16);
  expect(body.every((l) => /\d/.test(l))).toBe(true);
  expect(lines[header + 16]).toContain("Archive browser");
});

test("the Activity and Sort selects have a heading row", async () => {
  const { deps } = dependencies();
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("2");
  await app.key("s");
  expect(app.frame()).toContain("sort: order of the list · Enter applies · Esc cancels");
  await app.key("\u001b");
  await app.key("f");
  await app.key("\u001b[B");
  await app.key("\u001b[B");
  await app.key("\r");
  expect(app.frame()).toContain("activity: sessions active in this window");
});
