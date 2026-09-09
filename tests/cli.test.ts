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
  // The suite is offline, deliberately and permanently. `limits` and `sync`
  // now refresh over the network by default, so every spawned CLI here pins
  // that off -- a test that quietly depended on the endpoint being up, or on
  // this machine holding a valid token, would be worthless.
  CUSAGE_REFRESH: "off",
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

// A boolean flag used to swallow the next token, so `cusage --json status` set
// json="status", found no command, printed the help and exited 0 -- a silent
// wrong answer to a reasonable invocation. Only registered value flags consume
// an argument now.
test("a global flag before the command does not eat the command", () => {
  expect(parseArgs(["--json", "status"])).toEqual({
    command: "status", positional: [], flags: { json: true },
  });
  expect(parseArgs(["--no-color", "sessions", "--limit", "5"])).toEqual({
    command: "sessions", positional: [], flags: { "no-color": true, limit: "5" },
  });
  expect(parseArgs(["limits", "--refresh"]).flags).toEqual({ refresh: true });
  // An unregistered flag stays boolean and its argument becomes positional --
  // visible, rather than silently absorbed.
  expect(parseArgs(["limits", "--bogus", "x"])).toEqual({
    command: "limits", positional: ["x"], flags: { bogus: true },
  });
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

test("a flag before the command reaches the command, end to end", async () => {
  await withDb(async (db) => {
    await run(["sync", "--limits-only"], db);
    const r = await run(["--json", "status"], db);
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stdout).not.toContain("cusage — Claude");
  });
});

test("limits --history renders a series and survives an empty archive", async () => {
  // Window derived from the fixture rather than written as `30d`: the fixture
  // is frozen and the clock is not, so a relative window would start passing
  // vacuously the month after it was recorded.
  const samples = (await Bun.file(`${FIXTURES}/plan-usage-history.json`).json()).samples;
  const since = new Date(samples[0].t - 60_000).toISOString();

  await withDb(async (db) => {
    await run(["sync", "--limits-only"], db);

    const text = await run(["limits", "--history", "--since", since], db);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("Limit history");
    expect(text.stdout).toContain("seven_day");

    const json = await run(["limits", "--history", "--since", since, "--json"], db);
    const h = JSON.parse(json.stdout);
    expect(h.buckets.length).toBeGreaterThan(10);
    // The whole desktop series plus the one oauth-cache snapshot. Glaze days
    // fall inside this window too and are excluded, which is the point of
    // checking the source list rather than only the count.
    expect(h.totalSamples).toBe(samples.length + 1);
    expect(h.sources.map((s: { source: string }) => s.source).sort())
      .toEqual(["desktop-history", "oauth-cache"]);
    expect(json.stdout).not.toContain("\x1b[");
  });

  // No samples at all must render rather than divide by zero on an empty set.
  await withDb(async (db) => {
    const empty = await run(["limits", "--history"], db);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("Limit history");
  });
});

test("bad input is a message and exit 2, not a stack trace", async () => {
  await withDb(async (db) => {
    await run(["sync", "--limits-only"], db);
    for (const args of [["sessions", "--since", "7dd"], ["limits", "--history", "--bucket", "banana"]]) {
      const r = await run(args, db);
      expect(`${args[1]}:${r.code}`).toBe(`${args[1]}:2`);
      expect(r.stderr).not.toContain("at <anonymous>");
      expect(r.stderr.split("\n").filter(Boolean).length).toBeLessThan(3);
    }
  });
});

test("--no-refresh and $CUSAGE_REFRESH=off keep limits entirely local", async () => {
  await withDb(async (db) => {
    // env() already pins CUSAGE_REFRESH=off; --no-refresh is the explicit form
    // and must not need it. Both must produce a usable view from the archive.
    await run(["sync", "--limits-only"], db);
    const r = await run(["limits", "--no-refresh", "--json"], db);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.refresh.attempted).toBe(false);
    expect(out.refresh.reason).toBe("disabled");
    expect(out.scoped.length).toBeGreaterThan(0);
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
