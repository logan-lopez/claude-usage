import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "../src/cli.ts";
import { FIXTURES, FIXTURE_TRANSCRIPTS } from "./helpers.ts";

const SRC = `${import.meta.dir}/../src`;
const BUN = process.execPath;

const env = (db: string) => ({
  ...process.env,
  CUSAGE_DB: db,
  CUSAGE_TRANSCRIPTS: FIXTURE_TRANSCRIPTS,
  CUSAGE_CLAUDE_JSON: `${FIXTURES}/claude.json`,
  CUSAGE_DESKTOP_HISTORY: `${FIXTURES}/plan-usage-history.json`,
  CUSAGE_GLAZE_HISTORY: `${FIXTURES}/glaze-usage-history.json`,
});

async function run(args: string[], db: string) {
  const p = Bun.spawn([BUN, "run", `${SRC}/cli.ts`, ...args], {
    env: env(db), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

function withDb<T>(fn: (db: string) => T): T {
  const dir = mkdtempSync(`${tmpdir()}/cusage-cli-`);
  try {
    return fn(`${dir}/usage.db`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseArgs handles --flag value, --flag=value and bare flags", () => {
  expect(parseArgs(["sessions", "--since", "7d", "--by=project", "--json"])).toEqual({
    command: "sessions",
    positional: [],
    flags: { since: "7d", by: "project", json: true },
  });
  expect(parseArgs([]).command).toBe("help");
  expect(parseArgs(["session", "abc123"]).positional).toEqual(["abc123"]);
});

// Verification #10. The archiver runs hourly under launchd and the statusline
// may poll --json several times a minute; neither may pay React's startup
// cost. A refactor that folds the TUI into cli.ts quietly breaks this, which
// is exactly why it is a test and not a comment.
test("the CLI import graph never reaches react or ink", () => {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/g)]
      .map((m) => m[1]!)
      .concat([...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!));
    for (const spec of specs) {
      if (spec.startsWith(".")) {
        visit(resolve(dirname(file), spec));
      } else if (/^(react|ink)(\/|$)/.test(spec)) {
        offenders.push(`${file} -> ${spec}`);
      }
    }
  };
  visit(`${SRC}/cli.ts`);
  expect(offenders).toEqual([]);
  expect(seen.has(resolve(`${SRC}/tui.ts`))).toBe(false);
  // Sanity: the walker really did traverse the project.
  expect(seen.size).toBeGreaterThan(4);
});

test("sync is idempotent through the CLI and reports it", async () => {
  await withDb(async (db) => {
    const first = await run(["sync"], db);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("files read");

    const second = await run(["sync"], db);
    expect(second.code).toBe(0);
    // Nothing appended, so nothing re-read.
    expect(second.stdout).toContain("0/24 files read");

    const a = await run(["status", "--json"], db);
    const b = await run(["status", "--json"], db);
    expect(JSON.parse(a.stdout).requests).toBe(JSON.parse(b.stdout).requests);
  });
});

test("--json is machine-readable and carries no formatting", async () => {
  await withDb(async (db) => {
    await run(["sync"], db);
    for (const args of [["sessions", "--json"], ["limits", "--json"], ["status", "--json"], ["session", "--last", "--json"]]) {
      const r = await run(args, db);
      expect(`${args[0]}:${r.code}`).toBe(`${args[0]}:0`);
      expect(() => JSON.parse(r.stdout)).not.toThrow();
      // No ANSI, no padding, no table borders: --json must never route
      // through format.ts.
      expect(r.stdout).not.toContain("\x1b[");
    }
  });
});

test("unimplemented phase 3-4 commands fail loudly rather than printing zero", async () => {
  await withDb(async (db) => {
    await run(["sync"], db);
    for (const cmd of ["cost", "blocks", "attribution", "daily", "export", "pricing"]) {
      const r = await run([cmd], db);
      expect(`${cmd}:${r.code}`).toBe(`${cmd}:2`);
      expect(r.stderr).toContain("not implemented");
      expect(r.stdout).toBe("");
    }
  });
});

test("the TUI entrypoint is a separate bin that exits cleanly", async () => {
  const p = Bun.spawn([BUN, "run", `${SRC}/tui.ts`], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(p.stderr).text();
  expect(await p.exited).toBe(2);
  expect(stderr).toContain("phase 5");
});

test("unknown commands exit non-zero with usage", async () => {
  await withDb(async (db) => {
    const r = await run(["frobnicate"], db);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command");
  });
});

test("sync --limits-only does not touch transcripts", async () => {
  await withDb(async (db) => {
    const r = await run(["sync", "--limits-only", "--json"], db);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ingest).toBeNull();
    expect(out.limits.oauthInserted).toBe(1);
    const st = JSON.parse((await run(["status", "--json"], db)).stdout);
    expect(st.requests).toBe(0);
    expect(st.limitSamples).toBeGreaterThan(1500);
  });
});
