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
