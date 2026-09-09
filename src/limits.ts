import type { Database } from "bun:sqlite";
import { paths } from "./paths.ts";
import { getMeta, setMeta } from "./schema.ts";
import {
  DEFAULT_STALE_MS, DEFAULT_TIMEOUT_MS, MIN_REFRESH_MS, fetchUsage, readToken,
} from "./oauth.ts";

/**
 * Ordered by authority, freshest-wins ties broken in this order. 'glaze' is
 * last for a reason beyond age: its metric is inferred and its granularity is
 * a whole day, so it is archived but never reconciled from.
 */
export type LimitSource = "oauth-live" | "oauth-cache" | "desktop-history" | "glaze";

export interface LimitsResult {
  oauthInserted: number;
  desktopInserted: number;
  glazeInserted: number;
  /** Rows written to limit_scoped by this run. Was previously a table count. */
  scopedInserted: number;
  refresh: RefreshOutcome;
}

const INSERT_SAMPLE = `
INSERT INTO limit_samples (
  ts_ms, source, account_uuid, org, fetched_at_ms,
  five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at,
  extra_usage_pct, extra_usage_enabled, extra_usage_used_credits, extra_usage_monthly_limit,
  spend_used_minor, spend_limit_minor, spend_pct, spend_currency, raw_buckets
) VALUES (
  $ts_ms, $source, $account_uuid, $org, $fetched_at_ms,
  $fh, $fh_resets, $sd, $sd_resets,
  $xu_pct, $xu_enabled, $xu_used, $xu_limit,
  $spend_used, $spend_limit, $spend_pct, $spend_ccy, $raw
)
ON CONFLICT (ts_ms, source) DO UPDATE SET
  account_uuid = excluded.account_uuid, org = excluded.org,
  fetched_at_ms = excluded.fetched_at_ms,
  five_hour_pct = excluded.five_hour_pct,
  five_hour_resets_at = excluded.five_hour_resets_at,
  seven_day_pct = excluded.seven_day_pct,
  seven_day_resets_at = excluded.seven_day_resets_at,
  extra_usage_pct = excluded.extra_usage_pct,
  extra_usage_enabled = excluded.extra_usage_enabled,
  extra_usage_used_credits = excluded.extra_usage_used_credits,
  extra_usage_monthly_limit = excluded.extra_usage_monthly_limit,
  spend_used_minor = excluded.spend_used_minor,
  spend_limit_minor = excluded.spend_limit_minor,
  spend_pct = excluded.spend_pct, spend_currency = excluded.spend_currency,
  raw_buckets = excluded.raw_buckets
`;

const INSERT_SCOPED = `
INSERT INTO limit_scoped
  (ts_ms, source, kind, group_name, scope_model, percent, severity, resets_at, is_active)
VALUES ($ts_ms, $source, $kind, $group, $scope_model, $percent, $severity, $resets_at, $is_active)
ON CONFLICT (ts_ms, source, kind, group_name, scope_model) DO UPDATE SET
  percent = excluded.percent, severity = excluded.severity,
  resets_at = excluded.resets_at, is_active = excluded.is_active
`;

// Everything in utilization{} that is not a named field is a codename bucket
// (seven_day_opus, tangelo, nimbus_quill, ...). The server adds and removes
// them without notice, so they are archived as JSON rather than as columns.
const NAMED_BUCKETS = new Set([
  "five_hour", "seven_day", "extra_usage", "limits", "spend",
  "member_dashboard_available",
]);

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

/**
 * The `utilization` object is byte-identical whether it arrived over the wire
 * or was read out of `cachedUsageUtilization` -- the cache is literally the
 * response Claude Code stored. One writer for both, so the live source can
 * never drift from the cached one in what it records.
 *
 * Returns how many limit_scoped rows it wrote, which is the only count the
 * caller cannot derive.
 */
export function recordUtilization(
  db: Database,
  u: any,
  meta: { source: LimitSource; tsMs: number; accountUuid?: string | null },
): number {
  const buckets: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(u)) {
    if (!NAMED_BUCKETS.has(k)) buckets[k] = v;
  }
  const xu = u.extra_usage ?? {};
  const spend = u.spend ?? {};
  let scopedRows = 0;

  db.transaction(() => {
    db.prepare(INSERT_SAMPLE).run({
      $ts_ms: meta.tsMs, $source: meta.source,
      $account_uuid: str(meta.accountUuid), $org: null,
      $fetched_at_ms: meta.tsMs,
      $fh: num(u.five_hour?.utilization),
      $fh_resets: str(u.five_hour?.resets_at),
      $sd: num(u.seven_day?.utilization),
      $sd_resets: str(u.seven_day?.resets_at),
      $xu_pct: num(xu.utilization),
      $xu_enabled: xu.is_enabled ? 1 : 0,
      $xu_used: num(xu.used_credits),
      $xu_limit: num(xu.monthly_limit),
      $spend_used: num(spend.used?.amount_minor),
      $spend_limit: num(spend.limit?.amount_minor),
      $spend_pct: num(spend.percent),
      $spend_ccy: str(spend.used?.currency),
      $raw: JSON.stringify(buckets),
    });

    const scoped = db.prepare(INSERT_SCOPED);
    for (const l of Array.isArray(u.limits) ? u.limits : []) {
      scoped.run({
        $ts_ms: meta.tsMs, $source: meta.source,
        $kind: str(l?.kind) ?? "", $group: str(l?.group) ?? "",
        // '' rather than NULL for the same reason request_id is: this is a
        // primary key column and NULLs would never collide.
        $scope_model: str(l?.scope?.model?.display_name) ?? "",
        $percent: num(l?.percent), $severity: str(l?.severity),
        $resets_at: str(l?.resets_at), $is_active: l?.is_active ? 1 : 0,
      });
      scopedRows++;
    }
  })();

  return scopedRows;
}

/**
 * Source 3. Reads the cached OAuth response out of ~/.claude.json. Zero
 * network calls -- Claude Code already fetched it. Keyed on fetchedAtMs, so
 * polling every 15 minutes against an unchanged cache is a no-op rather than a
 * duplicate row.
 *
 * Still worth keeping now that we fetch our own: it is the only source of
 * limit data for the hours before this tool existed, and it costs nothing.
 * What it cannot be is the *current* number -- observed refresh interval on a
 * heavy day was 27 hours, one distinct snapshot.
 *
 * Reads exactly one key. oauthAccount, userID, machineID and
 * referral_code_details are never touched.
 */
export async function snapshotOauthCache(
  db: Database,
  file: string = paths.claudeJson,
): Promise<number> {
  const f = Bun.file(file);
  if (!(await f.exists())) return 0;
  const cached = (await f.json())?.cachedUsageUtilization;
  const u = cached?.utilization;
  if (!u) return 0;

  recordUtilization(db, u, {
    source: "oauth-cache",
    tsMs: num(cached.fetchedAtMs) ?? Date.now(),
    accountUuid: str(cached.accountUuid),
  });
  return 1;
}

/* --------------------------------------------------------------- refresh -- */

export type RefreshMode = "off" | "stale" | "force";

/** Persisted so the floor holds across processes, not just within one. */
const LAST_ATTEMPT_KEY = "oauth_live_last_attempt_ms";

export interface RefreshOutcome {
  mode: RefreshMode;
  attempted: boolean;
  ok: boolean;
  /** Why nothing was fetched, or 'ok'. 'guard'/'fresh' are normal, not errors. */
  reason: "disabled" | "fresh" | "guard" | "no-token" | "failed" | "ok";
  /** Age of the newest oauth-live sample when the decision was taken. */
  ageMs: number | null;
  /** Milliseconds until the guard lifts, when reason is 'guard'. */
  waitMs: number | null;
  tsMs: number | null;
  tokenSource: "keychain" | "file" | null;
  httpStatus: number | null;
  error: string | null;
}

function newestLiveMs(db: Database): number | null {
  const row = db
    .query("SELECT MAX(ts_ms) m FROM limit_samples WHERE source = 'oauth-live'")
    .get() as { m: number | null } | null;
  return row?.m ?? null;
}

/**
 * Source 3a. One authenticated GET, then the same insert path as the cache.
 *
 * Two independent brakes, and they are not the same brake:
 *
 * - `staleMs` is the *policy*: don't bother if what we have is recent enough.
 *   Callers set it, and `force` skips it.
 * - `MIN_REFRESH_MS` is the *floor*: nothing gets through it, including
 *   `force`, including a statusline in a loop. It is keyed on attempts rather
 *   than successes so that a 401 or a dead network cannot be retried faster
 *   than a success can.
 *
 * Never throws. A caller asking for limits has a perfectly good local archive
 * to fall back on and should print it.
 */
export async function refreshFromApi(
  db: Database,
  opts: {
    mode?: RefreshMode;
    staleMs?: number;
    timeoutMs?: number;
    nowMs?: number;
  } = {},
): Promise<RefreshOutcome> {
  const mode = opts.mode ?? "stale";
  const now = opts.nowMs ?? Date.now();
  const newest = newestLiveMs(db);
  const ageMs = newest === null ? null : now - newest;
  const base: RefreshOutcome = {
    mode, attempted: false, ok: false, reason: "ok", ageMs, waitMs: null,
    tsMs: newest, tokenSource: null, httpStatus: null, error: null,
  };

  if (mode === "off") return { ...base, reason: "disabled" };

  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  if (mode === "stale" && ageMs !== null && ageMs < staleMs) {
    return { ...base, reason: "fresh" };
  }

  const lastAttempt = Number(getMeta(db, LAST_ATTEMPT_KEY)) || 0;
  const sinceAttempt = now - lastAttempt;
  if (sinceAttempt < MIN_REFRESH_MS) {
    return { ...base, reason: "guard", waitMs: MIN_REFRESH_MS - sinceAttempt };
  }

  // Recorded before the request, not after: a hung fetch must still consume
  // the interval, or a slow endpoint turns into a retry storm.
  setMeta(db, LAST_ATTEMPT_KEY, String(now));

  const token = await readToken({ nowMs: now });
  if (!token) {
    return {
      ...base, attempted: true, reason: "no-token",
      error: "no usable credentials in the login keychain or ~/.claude/.credentials.json",
    };
  }

  const res = await fetchUsage(token, { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  if (!res.ok || !res.utilization) {
    return {
      ...base, attempted: true, reason: "failed",
      tokenSource: token.source, httpStatus: res.status, error: res.error,
    };
  }

  // The response has no timestamp of its own, so ours is the receipt time.
  const tsMs = Date.now();
  recordUtilization(db, res.utilization, { source: "oauth-live", tsMs });
  return {
    ...base, attempted: true, ok: true, reason: "ok",
    tsMs, tokenSource: token.source, httpStatus: res.status,
  };
}

/**
 * Source 4. The desktop app's 15-minute series, {t, org, u:{fh, sd, xu}}.
 * Rolling 30-day cap and only written while Claude.app runs, which is why it
 * gets copied into the archive instead of being read live.
 */
export async function backfillDesktopHistory(
  db: Database,
  file: string = paths.desktopHistory,
  opts: { full?: boolean } = {},
): Promise<number> {
  const f = Bun.file(file);
  if (!(await f.exists())) return 0;
  const samples = (await f.json())?.samples;
  if (!Array.isArray(samples)) return 0;

  // "Backfill" is a misnomer inherited from the first version: this is a
  // continuous mirror that runs every 15 minutes. Rewriting all ~2,000 rows
  // each time was cheap but pointless, so only the tail is considered. The
  // one-hour overlap is not paranoia about clocks -- it covers the app
  // rewriting the last few samples of the file, which it does.
  const newest = (
    db
      .query("SELECT MAX(ts_ms) m FROM limit_samples WHERE source = 'desktop-history'")
      .get() as { m: number | null } | null
  )?.m ?? null;
  const floor = opts.full || newest === null ? -Infinity : newest - 3_600_000;

  const stmt = db.prepare(INSERT_SAMPLE);
  let n = 0;
  db.transaction(() => {
    for (const s of samples) {
      const t = num(s?.t);
      if (t === null || t <= floor) continue;
      stmt.run({
        $ts_ms: t, $source: "desktop-history" satisfies LimitSource,
        $account_uuid: null, $org: str(s.org), $fetched_at_ms: t,
        $fh: num(s.u?.fh), $fh_resets: null,
        $sd: num(s.u?.sd), $sd_resets: null,
        $xu_pct: num(s.u?.xu), $xu_enabled: null, $xu_used: null, $xu_limit: null,
        $spend_used: null, $spend_limit: null, $spend_pct: null, $spend_ccy: null,
        $raw: null,
      });
      n++;
    }
  })();
  return n;
}

/**
 * Source 4b. Glaze stores a flat {"YYYY-MM-DD": percent} map -- one value per
 * day, no metric label. Which meter it is was settled by correlation against
 * Source 4 on the overlapping days rather than assumed: it lands within one
 * point of that day's five_hour maximum every time (56/56, 24/23, 19/18,
 * 13/12), and nowhere near seven_day. So it is archived as five_hour at day
 * granularity, tagged source='glaze' so every query can exclude it, and the
 * README says it is inferred.
 *
 * Timestamp is the UTC end of the named day, since the value is that day's
 * high-water mark rather than a reading at midnight -- except for the current
 * day, which would otherwise sit in the future. A future-dated row is not a
 * cosmetic problem: "newest limit sample across all sources" is exactly the
 * query a status header wants, and it would return today's glaze row every
 * time. Today's row is clamped to now and the stale copy at the old timestamp
 * is deleted, so there is still exactly one row per day and the write stays
 * idempotent.
 */
export async function backfillGlazeHistory(
  db: Database,
  file: string = paths.glazeHistory,
  nowMs: number = Date.now(),
): Promise<number> {
  const f = Bun.file(file);
  if (!(await f.exists())) return 0;
  const map = await f.json();
  if (!map || typeof map !== "object") return 0;

  const stmt = db.prepare(INSERT_SAMPLE);
  const dedupe = db.prepare(
    `DELETE FROM limit_samples
      WHERE source = 'glaze' AND ts_ms >= $lo AND ts_ms <= $hi AND ts_ms <> $keep`,
  );
  let n = 0;
  db.transaction(() => {
    for (const [day, pct] of Object.entries<unknown>(map)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const v = num(pct);
      if (v === null) continue;
      const dayStart = Date.parse(`${day}T00:00:00.000Z`);
      const dayEnd = Date.parse(`${day}T23:59:59.999Z`);
      const ts = Math.min(dayEnd, nowMs);
      dedupe.run({ $lo: dayStart, $hi: dayEnd, $keep: ts });
      stmt.run({
        $ts_ms: ts, $source: "glaze" satisfies LimitSource,
        $account_uuid: null, $org: null, $fetched_at_ms: null,
        $fh: v, $fh_resets: null, $sd: null, $sd_resets: null,
        $xu_pct: null, $xu_enabled: null, $xu_used: null, $xu_limit: null,
        $spend_used: null, $spend_limit: null, $spend_pct: null, $spend_ccy: null,
        $raw: JSON.stringify({ glaze_daily_percent: v, metric: "five_hour (inferred)" }),
      });
      n++;
    }
  })();
  return n;
}

export async function syncLimits(
  db: Database,
  opts: { backfill?: boolean; refresh?: RefreshMode; staleMs?: number } = {},
): Promise<LimitsResult> {
  const before = (
    db.query("SELECT COUNT(*) c FROM limit_scoped").get() as { c: number }
  ).c;

  const refresh = await refreshFromApi(db, {
    mode: opts.refresh ?? "stale",
    staleMs: opts.staleMs,
  });

  const oauthInserted = await snapshotOauthCache(db);
  let desktopInserted = 0;
  let glazeInserted = 0;
  if (opts.backfill !== false) {
    desktopInserted = await backfillDesktopHistory(db);
    glazeInserted = await backfillGlazeHistory(db);
  }

  const after = (
    db.query("SELECT COUNT(*) c FROM limit_scoped").get() as { c: number }
  ).c;
  return {
    oauthInserted, desktopInserted, glazeInserted,
    scopedInserted: after - before,
    refresh,
  };
}
