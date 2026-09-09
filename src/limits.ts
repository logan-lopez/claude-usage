import type { Database } from "bun:sqlite";
import { paths } from "./paths.ts";

export type LimitSource = "oauth-cache" | "desktop-history" | "glaze";

export interface LimitsResult {
  oauthInserted: number;
  desktopInserted: number;
  glazeInserted: number;
  scopedInserted: number;
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
 * Source 3. Reads the cached OAuth response out of ~/.claude.json. Zero
 * network calls -- Claude Code already fetched it. Keyed on fetchedAtMs, so
 * polling every 15 minutes against an unchanged cache is a no-op rather than a
 * duplicate row.
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

  const fetchedAt = num(cached.fetchedAtMs) ?? Date.now();
  const buckets: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(u)) {
    if (!NAMED_BUCKETS.has(k)) buckets[k] = v;
  }

  const xu = u.extra_usage ?? {};
  const spend = u.spend ?? {};

  db.transaction(() => {
    db.prepare(INSERT_SAMPLE).run({
      $ts_ms: fetchedAt, $source: "oauth-cache" satisfies LimitSource,
      $account_uuid: str(cached.accountUuid), $org: null,
      $fetched_at_ms: fetchedAt,
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
        $ts_ms: fetchedAt, $source: "oauth-cache",
        $kind: str(l?.kind) ?? "", $group: str(l?.group) ?? "",
        // '' rather than NULL for the same reason request_id is: this is a
        // primary key column and NULLs would never collide.
        $scope_model: str(l?.scope?.model?.display_name) ?? "",
        $percent: num(l?.percent), $severity: str(l?.severity),
        $resets_at: str(l?.resets_at), $is_active: l?.is_active ? 1 : 0,
      });
    }
  })();

  return 1;
}

/**
 * Source 4. The desktop app's 15-minute series, {t, org, u:{fh, sd, xu}}.
 * Rolling 30-day cap and only written while Claude.app runs, which is why it
 * gets copied into the archive instead of being read live.
 */
export async function backfillDesktopHistory(
  db: Database,
  file: string = paths.desktopHistory,
): Promise<number> {
  const f = Bun.file(file);
  if (!(await f.exists())) return 0;
  const samples = (await f.json())?.samples;
  if (!Array.isArray(samples)) return 0;

  const stmt = db.prepare(INSERT_SAMPLE);
  let n = 0;
  db.transaction(() => {
    for (const s of samples) {
      const t = num(s?.t);
      if (t === null) continue;
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
 * high-water mark rather than a reading at midnight.
 */
export async function backfillGlazeHistory(
  db: Database,
  file: string = paths.glazeHistory,
): Promise<number> {
  const f = Bun.file(file);
  if (!(await f.exists())) return 0;
  const map = await f.json();
  if (!map || typeof map !== "object") return 0;

  const stmt = db.prepare(INSERT_SAMPLE);
  let n = 0;
  db.transaction(() => {
    for (const [day, pct] of Object.entries<unknown>(map)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const v = num(pct);
      if (v === null) continue;
      stmt.run({
        $ts_ms: Date.parse(`${day}T23:59:59.999Z`), $source: "glaze" satisfies LimitSource,
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
  opts: { backfill?: boolean } = {},
): Promise<LimitsResult> {
  const oauthInserted = await snapshotOauthCache(db);
  let desktopInserted = 0;
  let glazeInserted = 0;
  if (opts.backfill !== false) {
    desktopInserted = await backfillDesktopHistory(db);
    glazeInserted = await backfillGlazeHistory(db);
  }
  const scopedInserted = (
    db.query("SELECT COUNT(*) c FROM limit_scoped").get() as { c: number }
  ).c;
  return { oauthInserted, desktopInserted, glazeInserted, scopedInserted };
}
