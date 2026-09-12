import { mkdirSync } from "node:fs";
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode) throw new Error("git metadata unavailable");
  return r.stdout.toString().trim();
};
const define = {
  "process.env.CUSAGE_BUILD_SHA": JSON.stringify(git("rev-parse", "HEAD")),
  "process.env.CUSAGE_BUILD_TIME": JSON.stringify(new Date().toISOString()),
  "process.env.CUSAGE_BUILD_REPO": JSON.stringify(process.cwd()),
  "process.env.CUSAGE_BUILD_DIRTY": JSON.stringify(
    git("status", "--porcelain") ? "true" : "false",
  ),
};
mkdirSync("dist", { recursive: true });
for (const [entry, outfile] of [
  ["src/cli.ts", "dist/cusage"],
  ["src/tui.ts", "dist/cusage-tui"],
] as const) {
  const result = await Bun.build({
    entrypoints: [entry],
    compile: { outfile },
    minify: true,
    jsx: { development: false },
    define: {
      ...define,
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.DEV": JSON.stringify("false"),
    },
  });
  if (!result.success)
    throw new AggregateError(result.logs, `failed to compile ${entry}`);
  console.log(outfile);
}
