/**
 * The only file in this tool that touches the network.
 *
 * `weekly_scoped` -- the limit that actually binds, "Fable 74%" -- exists
 * nowhere on disk. It is not in `plan-usage-history.json` (which carries only
 * `{fh, sd, xu}`), not in the desktop app's leveldb, and not in Session
 * Storage; the app holds it in memory. `~/.claude.json ->
 * cachedUsageUtilization` has it, but Claude Code refreshes that key on no
 * schedule you can rely on: a full day of heavy use produced exactly one
 * distinct snapshot, 27 hours stale. So the only route to the real number is
 * the request Claude Code itself makes.
 *
 * Rules this module exists to enforce, and which must not be quietly relaxed:
 *
 * - One endpoint. GET only. No other host is ever contacted.
 * - A hard floor of MIN_REFRESH_MS between *attempts*, successful or not,
 *   persisted in `meta` so it survives across processes. `CUSAGE_MIN_REFRESH_MS`
 *   can raise that floor and cannot lower it.
 *   That is what makes a statusline polling `--json` every two seconds safe.
 * - The token is read, used to sign one request, and dropped. It is never
 *   written to the archive, never logged, and never included in an error
 *   string -- `redact()` is applied to everything that leaves here.
 * - Every failure is soft. A refusal, an expired token, a timeout or an
 *   offline machine returns an outcome object; nothing throws into a caller
 *   whose real job is reading a local database.
 */
import { paths } from "./paths.ts";

export const USAGE_ENDPOINT =
  process.env.CUSAGE_OAUTH_USAGE_URL ?? "https://api.anthropic.com/api/oauth/usage";

/** The keychain item Claude Code writes on macOS. */
const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Hard floor between network attempts. Env may raise it, never lower it --
 * `Math.max`, not `??`, is the whole point of this line.
 */
export const MIN_REFRESH_MS = Math.max(
  180_000,
  Number(process.env.CUSAGE_MIN_REFRESH_MS) || 0,
);

/** Default "how old is too old" for `refresh: "stale"`. Matches the desktop
 *  series cadence and the limits agent's StartInterval. */
export const DEFAULT_STALE_MS = Number(process.env.CUSAGE_REFRESH_STALE_MS) || 900_000;

export const DEFAULT_TIMEOUT_MS = Number(process.env.CUSAGE_REFRESH_TIMEOUT_MS) || 10_000;

/** Never let a bearer token reach a log, an error string or the archive. */
export function redact(s: string): string {
  return s.replace(/sk-ant-[A-Za-z0-9_\-]+/g, "sk-ant-***");
}

export interface Token {
  accessToken: string;
  /** Epoch ms, or null when the store does not say. */
  expiresAt: number | null;
  source: "keychain" | "file";
}

function parseCredentials(text: string, source: Token["source"]): Token | null {
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  const a = o?.claudeAiOauth;
  const accessToken = typeof a?.accessToken === "string" ? a.accessToken : null;
  if (!accessToken) return null;
  const expiresAt = typeof a.expiresAt === "number" ? a.expiresAt : null;
  return { accessToken, expiresAt, source };
}

/**
 * `security` normally answers without prompting, because Claude Code creates
 * the item with an ACL that allows it. Normally. If the ACL is ever different
 * the command blocks on a GUI dialog forever, which under launchd means a job
 * that never exits -- hence the kill.
 */
export async function fromKeychain(timeoutMs = 5_000): Promise<Token | null> {
  if (process.platform !== "darwin") return null;
  // Lets a test pin the credential source, so a machine that happens to be
  // logged in cannot make a token-handling test pass for the wrong reason.
  if (process.env.CUSAGE_NO_KEYCHAIN) return null;
  try {
    const p = Bun.spawn(
      ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    );
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    if ((await p.exited) !== 0) return null;
    return parseCredentials(out, "keychain");
  } catch {
    return null;
  }
}

export async function fromFile(file = paths.credentials): Promise<Token | null> {
  try {
    const f = Bun.file(file);
    if (!(await f.exists())) return null;
    return parseCredentials(await f.text(), "file");
  } catch {
    return null;
  }
}

/**
 * Order of preference, given the stores in order of authority: an unexpired
 * token beats an expired one, and only then does store order decide. On this
 * machine `.credentials.json` is three weeks stale while the keychain is
 * current; the reverse is perfectly possible on a box where Claude Code has
 * not run lately, and picking the wrong one costs a pointless 401.
 *
 * Pure, so the choice is testable without a keychain or a token on disk.
 */
export function pickToken(candidates: (Token | null)[], nowMs: number): Token | null {
  const found = candidates.filter((t): t is Token => t !== null);
  if (found.length === 0) return null;
  const live = found.filter((t) => t.expiresAt === null || t.expiresAt > nowMs);
  return (live[0] ?? found[0])!;
}

export async function readToken(
  opts: { nowMs?: number; file?: string; keychain?: boolean } = {},
): Promise<Token | null> {
  const nowMs = opts.nowMs ?? Date.now();
  return pickToken(
    [
      opts.keychain === false ? null : await fromKeychain(),
      await fromFile(opts.file),
    ],
    nowMs,
  );
}

export interface FetchResult {
  ok: boolean;
  status: number | null;
  /** Same shape as `cachedUsageUtilization.utilization`: the endpoint response
   *  *is* what Claude Code caches under that key. */
  utilization: Record<string, unknown> | null;
  error: string | null;
}

export async function fetchUsage(
  token: Token,
  opts: { url?: string; timeoutMs?: number } = {},
): Promise<FetchResult> {
  const url = opts.url ?? USAGE_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        // The header Claude Code sends. Without it the endpoint 401s an
        // otherwise valid subscription token.
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json",
        "user-agent": "cusage (github.com/loganpowell/claude-usage)",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = redact((await res.text()).slice(0, 200));
      return { ok: false, status: res.status, utilization: null, error: `HTTP ${res.status} ${body}`.trim() };
    }
    const utilization = (await res.json()) as Record<string, unknown>;
    if (!utilization || typeof utilization !== "object") {
      return { ok: false, status: res.status, utilization: null, error: "response was not an object" };
    }
    return { ok: true, status: res.status, utilization, error: null };
  } catch (e) {
    return {
      ok: false,
      status: null,
      utilization: null,
      error: redact(e instanceof Error ? e.message : String(e)),
    };
  }
}
