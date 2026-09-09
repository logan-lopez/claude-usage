/**
 * The network policy, tested offline.
 *
 * `cusage` fetches /api/oauth/usage, because `weekly_scoped` — the limit that
 * actually binds — exists in no local file. That is a deliberate loosening of
 * the original "no automatic network calls, ever" rule, and what replaced it
 * is a hard floor between attempts. A rule that only holds when someone
 * remembers it is not a rule, so it is tested here.
 *
 * Nothing in this file contacts a remote host. The one test that exercises a
 * real request points at 127.0.0.1:1, which refuses instantly: that is enough
 * to prove the attempt was recorded, the failure was soft, and the next call
 * was refused by the guard.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb, getMeta, setMeta } from "../src/schema.ts";
import { refreshFromApi, syncLimits } from "../src/limits.ts";
import { MIN_REFRESH_MS, pickToken, redact } from "../src/oauth.ts";

const BUN = process.execPath;
const SRC = `${import.meta.dir}/../src`;
const LAST_ATTEMPT = "oauth_live_last_attempt_ms";

/** A credentials file that is real in shape and fake in content. Written to a
 *  temp dir, never to fixtures/, so the leak test has nothing to find. */
async function withFakeCredentials<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(`${tmpdir()}/cusage-creds-`);
  try {
    const file = `${dir}/.credentials.json`;
    await Bun.write(
      file,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-not-a-real-token",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    );
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the request guard is a floor that configuration can raise but not lower", async () => {
  expect(MIN_REFRESH_MS).toBeGreaterThanOrEqual(180_000);

  const read = async (value: string) => {
    const p = Bun.spawn(
      [BUN, "-e", `console.log((await import(${JSON.stringify(`${SRC}/oauth.ts`)})).MIN_REFRESH_MS)`],
      { env: { ...process.env, CUSAGE_MIN_REFRESH_MS: value }, stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(p.stdout).text();
    await p.exited;
    return Number(out.trim());
  };

  // The whole point of Math.max rather than ??. Someone will try this.
  expect(await read("1000")).toBe(180_000);
  expect(await read("600000")).toBe(600_000);
});

test("a bearer token never survives into an error string", () => {
  const leaked = 'HTTP 401 {"error":"bad token sk-ant-oat01-AbC_123-xyz"}';
  expect(redact(leaked)).toBe('HTTP 401 {"error":"bad token sk-ant-***"}');
  expect(redact(leaked)).not.toContain("AbC_123");
});

test("an unexpired token beats a fresher store holding an expired one", () => {
  const now = 1_000_000;
  const stale = { accessToken: "a", expiresAt: now - 1, source: "keychain" as const };
  const live = { accessToken: "b", expiresAt: now + 1, source: "file" as const };
  expect(pickToken([stale, live], now)!.source).toBe("file");
  // Store order decides only among equals.
  const bothLive = { ...stale, expiresAt: now + 5 };
  expect(pickToken([bothLive, live], now)!.source).toBe("keychain");
  // Everything expired: return something and let the 401 say so, rather than
  // silently reporting "no credentials" to someone who is clearly logged in.
  expect(pickToken([stale, { ...live, expiresAt: now - 2 }], now)!.source).toBe("keychain");
  expect(pickToken([null, null], now)).toBeNull();
});

test("refresh off means no attempt at all", async () => {
  const db = openDb(":memory:");
  const r = await refreshFromApi(db, { mode: "off" });
  expect(r.attempted).toBe(false);
  expect(r.reason).toBe("disabled");
  expect(getMeta(db, LAST_ATTEMPT)).toBeNull();
});

test("refresh stale skips the network when the archive is recent enough", async () => {
  const db = openDb(":memory:");
  const nowMs = Date.parse("2026-09-09T21:00:00Z");
  db.query("INSERT INTO limit_samples (ts_ms, source, seven_day_pct) VALUES (?, 'oauth-live', 54)")
    .run(nowMs - 60_000);

  const fresh = await refreshFromApi(db, { mode: "stale", nowMs });
  expect(fresh.attempted).toBe(false);
  expect(fresh.reason).toBe("fresh");
  expect(fresh.ageMs).toBe(60_000);
  expect(getMeta(db, LAST_ATTEMPT)).toBeNull();
});

test("force skips the staleness check but not the guard", async () => {
  const db = openDb(":memory:");
  const nowMs = Date.parse("2026-09-09T21:00:00Z");
  setMeta(db, LAST_ATTEMPT, String(nowMs - 60_000));

  const r = await refreshFromApi(db, { mode: "force", nowMs });
  expect(r.attempted).toBe(false);
  expect(r.reason).toBe("guard");
  expect(r.waitMs).toBe(MIN_REFRESH_MS - 60_000);
  // The blocked call must not push the window out; otherwise a caller in a
  // loop keeps the guard permanently closed and it never refreshes at all.
  expect(getMeta(db, LAST_ATTEMPT)).toBe(String(nowMs - 60_000));
});

test("syncLimits reports the refresh it did not make", async () => {
  const db = openDb(":memory:");
  const r = await syncLimits(db, { backfill: false, refresh: "off" });
  expect(r.refresh.reason).toBe("disabled");
  const live = db
    .query("SELECT COUNT(*) c FROM limit_samples WHERE source = 'oauth-live'")
    .get() as { c: number };
  expect(live.c).toBe(0);
});

// End to end against a refused connection: real code path, no remote host.
test("a failed fetch is soft, consumes the guard, and is not retried", async () => {
  await withFakeCredentials(async (creds) => {
    const dir = mkdtempSync(`${tmpdir()}/cusage-refresh-`);
    try {
      const env = {
        ...process.env,
        CUSAGE_DB: `${dir}/usage.db`,
        CUSAGE_CREDENTIALS: creds,
        CUSAGE_NO_KEYCHAIN: "1",
        CUSAGE_OAUTH_USAGE_URL: "http://127.0.0.1:1/api/oauth/usage",
        CUSAGE_REFRESH_TIMEOUT_MS: "2000",
      };
      const run = async () => {
        const p = Bun.spawn([BUN, "run", `${SRC}/cli.ts`, "limits", "--refresh", "--json"], {
          env, stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
        ]);
        return { code: await p.exited, stdout, stderr };
      };

      const first = await run();
      // Soft: an unreachable endpoint is not a crash, it is a footnote.
      expect(first.code).toBe(0);
      const a = JSON.parse(first.stdout);
      expect(a.refresh.attempted).toBe(true);
      expect(a.refresh.ok).toBe(false);
      expect(a.refresh.reason).toBe("failed");
      expect(a.refresh.tokenSource).toBe("file");
      expect(first.stderr).toContain("could not refresh");
      expect(first.stderr).not.toContain("sk-ant");

      // Immediately again: the floor holds across processes, which is the only
      // form of it that matters when launchd and a statusline both exist.
      const second = await run();
      const b = JSON.parse(second.stdout);
      expect(b.refresh.attempted).toBe(false);
      expect(b.refresh.reason).toBe("guard");
      expect(b.refresh.waitMs).toBeGreaterThan(150_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
