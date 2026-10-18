import { afterEach, expect, test } from "bun:test";
import { dependencies, mount, teardown, until } from "./helpers.tsx";

afterEach(teardown);

test("Detail pages by its viewport's visible rows", async () => {
  const { deps } = dependencies();
  const detail = deps.detail;
  deps.detail = (id) => {
    const d = detail(id);
    return d && { ...d, byTool: Array.from({ length: 40 }, (_, i) => ({ key: `tool-${i}`, calls: 1 })) };
  };
  const app = mount(deps, 80, 24);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("\r");
  for (let i = 0; i < 3; i++) await app.key("\t");
  expect(app.frame()).toContain("tool-0 ");
  // 19 content rows less three header rows is a 16-row viewport showing 15.
  await app.key("\u001b[6~");
  expect(app.frame()).toContain("↑↓ 16–30 / 41");
});

test("Summary reads in plain words, durations and UTC minutes", async () => {
  const { db, deps } = dependencies();
  db.run(
    "UPDATE sessions SET total_duration_ms = 5123456, total_api_duration_ms = 61000, first_ts = '2026-09-11T09:05:07.123Z'",
  );
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("\r");
  expect(app.frame()).toContain("Duration: 1h 25m");
  expect(app.frame()).toContain("API time: 1m 1s");
  expect(app.frame()).toContain("First: 2026-09-11 09:05");
  expect(app.frame()).not.toContain("total_duration_ms");
  expect(app.frame()).not.toContain("T09:05:07");
});

test("a session that disappears loses its totals row, and comes back on a later reread", async () => {
  const { deps, change } = dependencies();
  const detail = deps.detail;
  let gone = false;
  deps.detail = (id) => (gone ? null : detail(id));
  const app = mount(deps);
  await until(() => app.frame().includes("Recent sessions"));
  await app.key("\r");
  const id = app.frame().match(/ID: (.*)/)?.[1]?.trim();
  expect(app.frame()).toContain("requests ·");
  gone = true;
  change();
  await until(() => app.frame().includes("Session no longer available"));
  expect(app.frame()).not.toContain("0 requests");
  expect(app.frame()).toContain(`Session: ${id}`);
  gone = false;
  change();
  await until(() => app.frame().includes(`ID: ${id}`));
});
