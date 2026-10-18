import { afterEach, expect, test } from "bun:test";
import stringWidth from "string-width";
import { limitsHistory } from "../../src/query.ts";
import { fit } from "../../src/tui/text.ts";
import { NOW, dependencies, mount, teardown, until } from "./helpers.tsx";

afterEach(teardown);

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

test("PageDown in a small Overview panel moves by that panel's visible rows", async () => {
  const { deps } = dependencies();
  const checks = Array.from({ length: 30 }, (_, i) => ({
    name: `check-${i}`,
    level: "ok" as const,
    detail: "ok",
  }));
  const diagnose = deps.diagnostics;
  deps.diagnostics = async () => ({ ...(await diagnose()), checks });
  const app = mount(deps);
  await until(() => app.frame().includes("check-0"));
  await app.key("\t");
  await app.key("\t");
  // Full dashboard at 120×40: the Archive panel is 11 rows, one of them its title, and its
  // viewport's last row is the position indicator, so a page is 9 rows.
  await app.key("\u001b[6~");
  expect(app.frame()).toContain("↑↓ 10–18 /");
  await app.key("\u001b[5~");
  expect(app.frame()).toContain("↑↓ 1–9 /");
  // Compact at 80×24: one 18-row panel, so a page is 16 rows.
  await app.resize(80, 24);
  expect(app.frame()).toContain("Panel 2/5");
  await app.key("\u001b[6~");
  expect(app.frame()).toContain("↑↓ 17–32 /");
});
