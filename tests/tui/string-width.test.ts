import { expect, test } from "bun:test";

test("string-width is one patched copy shared with Ink, so its per-cluster cache covers every frame", async () => {
  const pkg = await Bun.file("package.json").json();
  const installed = (await Bun.file("node_modules/string-width/package.json").json()).version;
  // patchedDependencies is keyed by exact version: a bump silently drops the patch.
  expect(Object.keys(pkg.patchedDependencies)).toEqual([`string-width@${installed}`]);
  expect(pkg.dependencies["string-width"]).toBe(installed);
  const root = Bun.resolveSync("string-width", process.cwd());
  for (const dependent of ["ink", "cli-truncate", "widest-line", "wrap-ansi"])
    expect(Bun.resolveSync("string-width", `${process.cwd()}/node_modules/${dependent}`)).toBe(root);
  expect(await Bun.file(root).text()).toContain("clusterWidthCache");
});
