/**
 * Every read query lives here. Data in, plain objects out.
 *
 * This module must never format anything, never print anything, and never read
 * process.argv. The CLI and the Ink TUI are both consumers of these functions;
 * the moment a query starts returning a padded string, the TUI has to reparse
 * it and the layering is gone.
 */
import type { Database } from "bun:sqlite";
// Type-only: the read layer names the sources it reconciles, it does not write
// them and must not reach the network module that produces one of them.
import type { LimitSource } from "./limits.ts";

export interface TokenTotals {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  ephemeral_5m: number;
  ephemeral_1h: number;
  total_tokens: number;
}

export interface SessionRow extends TokenTotals {
  session_id: string;
  slug: string | null;
  project: string | null;
  cwd: string | null;
  git_branch: string | null;
  entrypoint: string | null;
  first_ts: string | null;
  last_ts: string | null;
  message_count: number;
  total_cost_usd: number | null;
  total_duration_ms: number | null;
  total_api_duration_ms: number | null;
  total_tool_duration_ms: number | null;
  total_lines_added: number | null;
  total_lines_removed: number | null;
  models: string | null;
}

export interface GroupRow extends TokenTotals {
  key: string;
  sessions: number;
  /** Exact. Sums cost-state only for sessions that live entirely in this group. */
  cost_usd: number;
  /** Sessions that also appear in another group. Their cost is deliberately
   *  excluded rather than counted in every group they touch. */
  sessions_split: number;
  /** Sessions wholly in this group but with no cost-state record. */
  sessions_unpriced: number;
  /** cost_usd accounts for every session in the group. */
  cost_complete: boolean;
}

export interface BreakdownRow extends TokenTotals {
  key: string;
}

export interface SessionDetail {
  session: SessionRow;
  byModel: BreakdownRow[];
  byEffort: BreakdownRow[];
  byAgent: BreakdownRow[];
  bySkill: BreakdownRow[];
  byMcpServer: BreakdownRow[];
  byPlugin: BreakdownRow[];
  byTool: { key: string; calls: number }[];
  blocks: (TokenTotals & { api_block_index: number | null; first_ts: string | null; last_ts: string | null })[];
  main: TokenTotals;
  sidechain: TokenTotals;
  /** cost-state ground truth, per model. Empty when the session predates it. */
  costModels: {
    model: string; cost_usd: number; input_tokens: number; output_tokens: number;
    thinking_tokens: number; cache_read_input_tokens: number;
    cache_creation_input_tokens: number; web_search_requests: number;
  }[];
  /** 'measured' when cost-state exists for this session, else 'estimated'. */
  costBasis: "measured" | "estimated";
}

const TOTALS_SELECT = `
  COUNT(*) AS requests,
  COALESCE(SUM(input_tokens), 0)          AS input_tokens,
  COALESCE(SUM(output_tokens), 0)         AS output_tokens,
  COALESCE(SUM(thinking_tokens), 0)       AS thinking_tokens,
  COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
  COALESCE(SUM(cache_read_tokens), 0)     AS cache_read_tokens,
  COALESCE(SUM(ephemeral_5m), 0)          AS ephemeral_5m,
  COALESCE(SUM(ephemeral_1h), 0)          AS ephemeral_1h,
  COALESCE(SUM(total_tokens), 0)          AS total_tokens
`;

export function corpusTotals(db: Database, since: number | null = null): TokenTotals {
  return db
    .query(`SELECT ${TOTALS_SELECT} FROM requests WHERE ($since IS NULL OR ts_ms >= $since)`)
    .get({ $since: since }) as TokenTotals;
}

/** `--last` resolves to the most recently active session, not the newest row. */
export function resolveSessionId(db: Database, ref: string | null): string | null {
  if (!ref || ref === "--last" || ref === "last") {
    const row = db
      .query("SELECT session_id FROM sessions WHERE message_count > 0 ORDER BY last_ts_ms DESC LIMIT 1")
      .get() as { session_id: string } | null;
    return row?.session_id ?? null;
  }
  const exact = db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(ref) as
    | { session_id: string } | null;
  if (exact) return exact.session_id;
  // Accept an unambiguous prefix, and a slug.
  const like = db
    .query(
      `SELECT session_id FROM sessions
       WHERE session_id LIKE ?1 || '%' OR slug = ?1
       ORDER BY last_ts_ms DESC LIMIT 2`,
    )
    .all(ref) as { session_id: string }[];
  if (like.length === 1) return like[0]!.session_id;
  if (like.length > 1) throw new Error(`ambiguous session reference: ${ref}`);
  return null;
}

const SESSION_SELECT = `
  SELECT s.session_id, s.slug, s.project, s.cwd, s.git_branch, s.entrypoint,
         s.first_ts, s.last_ts, s.message_count, s.total_cost_usd,
         s.total_duration_ms, s.total_api_duration_ms, s.total_tool_duration_ms,
         s.total_lines_added, s.total_lines_removed,
         (SELECT GROUP_CONCAT(m, ', ') FROM
            (SELECT DISTINCT model AS m FROM requests WHERE session_id = s.session_id
              AND model IS NOT NULL ORDER BY model)) AS models,
         COALESCE(r.requests, 0) AS requests,
         COALESCE(r.input_tokens, 0) AS input_tokens,
         COALESCE(r.output_tokens, 0) AS output_tokens,
         COALESCE(r.thinking_tokens, 0) AS thinking_tokens,
         COALESCE(r.cache_creation_tokens, 0) AS cache_creation_tokens,
         COALESCE(r.cache_read_tokens, 0) AS cache_read_tokens,
         COALESCE(r.ephemeral_5m, 0) AS ephemeral_5m,
         COALESCE(r.ephemeral_1h, 0) AS ephemeral_1h,
         COALESCE(r.total_tokens, 0) AS total_tokens
    FROM sessions s
    LEFT JOIN (SELECT session_id, ${TOTALS_SELECT} FROM requests GROUP BY session_id) r
      ON r.session_id = s.session_id
`;

function breakdown(db: Database, sessionId: string, column: string): BreakdownRow[] {
  return db
    .query(
      `SELECT COALESCE(${column}, '(none)') AS key, ${TOTALS_SELECT}
         FROM requests WHERE session_id = ?
        GROUP BY COALESCE(${column}, '(none)')
        ORDER BY total_tokens DESC`,
    )
    .all(sessionId) as BreakdownRow[];
}

export function getSession(db: Database, sessionId: string): SessionDetail | null {
  const session = db
    .query(`${SESSION_SELECT} WHERE s.session_id = ?`)
    .get(sessionId) as SessionRow | null;
  if (!session) return null;

  const half = (where: string) =>
    db
      .query(`SELECT ${TOTALS_SELECT} FROM requests WHERE session_id = ? AND ${where}`)
      .get(sessionId) as TokenTotals;

  const costModels = db
    .query(
      `SELECT model, cost_usd, input_tokens, output_tokens, thinking_tokens,
              cache_read_input_tokens, cache_creation_input_tokens, web_search_requests
         FROM cost_state_models WHERE session_id = ? ORDER BY cost_usd DESC`,
    )
    .all(sessionId) as SessionDetail["costModels"];

  return {
    session,
    byModel: breakdown(db, sessionId, "model"),
    byEffort: breakdown(db, sessionId, "effort"),
    byAgent: breakdown(db, sessionId, "attribution_agent"),
    bySkill: breakdown(db, sessionId, "attribution_skill"),
    byMcpServer: breakdown(db, sessionId, "attribution_mcp_server"),
    byPlugin: breakdown(db, sessionId, "attribution_plugin"),
    byTool: db
      .query(
        `SELECT tool_name AS key, COUNT(*) AS calls FROM tool_calls
          WHERE session_id = ? AND tool_name IS NOT NULL
          GROUP BY tool_name ORDER BY calls DESC`,
      )
      .all(sessionId) as { key: string; calls: number }[],
    blocks: db
      .query(
        `SELECT api_block_index, MIN(ts) AS first_ts, MAX(ts) AS last_ts, ${TOTALS_SELECT}
           FROM requests WHERE session_id = ?
          GROUP BY api_block_index ORDER BY api_block_index`,
      )
      .all(sessionId) as SessionDetail["blocks"],
    main: half("is_sidechain = 0"),
    sidechain: half("is_sidechain = 1"),
    costModels,
    costBasis: session.total_cost_usd !== null ? "measured" : "estimated",
  };
}

export interface SessionsOptions {
  since?: number | null;
  by?: "project" | "model" | "entrypoint" | "branch" | null;
  limit?: number;
  project?: string | null;
}

export function listSessions(db: Database, opts: SessionsOptions = {}): SessionRow[] {
  const { since = null, limit = 30, project = null } = opts;
  return db
    .query(
      `${SESSION_SELECT}
        WHERE COALESCE(r.requests, 0) > 0
          AND ($since IS NULL OR s.last_ts_ms >= $since)
          AND ($project IS NULL OR s.project = $project)
        ORDER BY s.last_ts_ms DESC
        LIMIT $limit`,
    )
    .all({ $since: since, $project: project, $limit: limit }) as SessionRow[];
}

/**
 * Grouped roll-up.
 *
 * Cost here is exact or it is absent -- there is no third option. cost-state is
 * recorded per *session*, and a session's requests can land in several groups
 * (a single chat that ran sub-agents across three worktrees is one session and
 * three projects). Summing that session's total into each group it touched
 * inflates the corpus: on the test fixture it turned $90 of real spend into
 * $226. So a session that straddles groups is counted in `sessions_split` and
 * its cost is left out, and the renderer marks the column.
 *
 * Apportioning a split session's cost across groups needs per-token prices,
 * which is phase 3. `cusage cost` is where that belongs.
 */
export function groupSessions(
  db: Database,
  by: NonNullable<SessionsOptions["by"]>,
  opts: SessionsOptions = {},
): GroupRow[] {
  const { since = null } = opts;
  const column = {
    project: "project",
    model: "model",
    entrypoint: "entrypoint",
    branch: "git_branch",
  }[by];

  const KEYED = `
    keyed AS (
      SELECT *, COALESCE(${column}, '(unknown)') AS gkey FROM requests
       WHERE ($since IS NULL OR ts_ms >= $since)
    )`;

  const totals = db
    .query(
      `WITH ${KEYED}
       SELECT gkey AS key, COUNT(DISTINCT session_id) AS sessions, ${TOTALS_SELECT}
         FROM keyed GROUP BY gkey ORDER BY total_tokens DESC`,
    )
    .all({ $since: since }) as (GroupRow & { key: string })[];

  const costs = db
    .query(
      `WITH ${KEYED},
        sess_groups AS (SELECT session_id, COUNT(DISTINCT gkey) AS ngroups FROM keyed GROUP BY session_id),
        sess_key    AS (SELECT DISTINCT session_id, gkey FROM keyed)
       SELECT sk.gkey AS key,
              COALESCE(SUM(CASE WHEN sg.ngroups = 1 AND s.total_cost_usd IS NOT NULL
                                THEN s.total_cost_usd ELSE 0 END), 0) AS cost_usd,
              SUM(CASE WHEN sg.ngroups > 1 THEN 1 ELSE 0 END) AS sessions_split,
              SUM(CASE WHEN sg.ngroups = 1 AND s.total_cost_usd IS NULL THEN 1 ELSE 0 END) AS sessions_unpriced
         FROM sess_key sk
         JOIN sess_groups sg ON sg.session_id = sk.session_id
         LEFT JOIN sessions s ON s.session_id = sk.session_id
        GROUP BY sk.gkey`,
    )
    .all({ $since: since }) as {
      key: string; cost_usd: number; sessions_split: number; sessions_unpriced: number;
    }[];

  const byKey = new Map(costs.map((c) => [c.key, c]));
  return totals.map((t) => {
    const c = byKey.get(t.key);
    const split = c?.sessions_split ?? 0;
    const unpriced = c?.sessions_unpriced ?? 0;
    return {
      ...t,
      cost_usd: c?.cost_usd ?? 0,
      sessions_split: split,
      sessions_unpriced: unpriced,
      cost_complete: split === 0 && unpriced === 0,
    };
  });
}

/* ---------------------------------------------------------------- limits -- */

/**
 * Anything older than this is shown with its age spelled out rather than as a
 * bare number. Matches the limits agent's interval, so a healthy machine never
 * trips it. Not imported from oauth.ts on purpose: this module does no I/O and
 * has no business knowing that a network exists.
 */
export const FRESH_MS = 900_000;

/** Ties go to the more authoritative source. Glaze never wins because it never
 *  competes -- see RECONCILABLE. */
const SOURCE_RANK: Record<LimitSource, number> = {
  "oauth-live": 3,
  "oauth-cache": 2,
  "desktop-history": 1,
  glaze: 0,
};

/**
 * Glaze is excluded from reconciliation, and not because it is stale. Its
 * metric is inferred rather than labelled, and it is a daily high-water mark,
 * so "the value right now" is not a thing it can answer.
 */
const RECONCILABLE: LimitSource[] = ["oauth-live", "oauth-cache", "desktop-history"];

export interface LimitReading {
  source: LimitSource;
  tsMs: number;
  ageMs: number;
  percent: number | null;
  resetsAt: string | null;
}

export interface SourceStatus {
  source: LimitSource;
  tsMs: number;
  ageMs: number;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  reconcilable: boolean;
}

export interface ScopedLimit {
  kind: string;
  group: string;
  scope_model: string;
  percent: number | null;
  severity: string | null;
  resets_at: string | null;
  is_active: boolean;
  source: LimitSource;
  tsMs: number;
  ageMs: number;
}

/** Two sources that are both current and disagree. Reported, never averaged. */
export interface Disagreement {
  metric: "five_hour" | "seven_day";
  chosen: LimitReading;
  other: LimitReading;
  deltaPoints: number;
}

export interface LimitsNow {
  nowMs: number;
  freshMs: number;

  /** Freshest usable reading per meter, whichever source it came from. */
  fiveHour: LimitReading | null;
  sevenDay: LimitReading | null;

  /** Flat mirrors of the reconciled readings, for callers that want a number. */
  fiveHourPct: number | null;
  fiveHourResetsAt: string | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: string | null;
  /** ISO time of the freshest reading actually used. Not "when we looked". */
  fetchedAt: string | null;

  scoped: ScopedLimit[];
  scopedSource: LimitSource | null;
  scopedTsMs: number | null;
  scopedAgeMs: number | null;
  scopedStale: boolean;
  /** The limit that actually gates you, or null when nothing is marked active. */
  binding: ScopedLimit | null;

  disagreements: Disagreement[];
  sources: SourceStatus[];

  extraUsagePct: number | null;
  spendPct: number | null;
  buckets: Record<string, unknown>;
}

type MeterColumns = { pct: string; resets: string };
const METERS: Record<"five_hour" | "seven_day", MeterColumns> = {
  five_hour: { pct: "five_hour_pct", resets: "five_hour_resets_at" },
  seven_day: { pct: "seven_day_pct", resets: "seven_day_resets_at" },
};

/** Newest row per source that actually carries this meter. A desktop sample
 *  with a null `sd` must not shadow an older one that has it. */
function readings(
  db: Database,
  meter: "five_hour" | "seven_day",
  nowMs: number,
): LimitReading[] {
  const { pct, resets } = METERS[meter];
  const out: LimitReading[] = [];
  for (const source of RECONCILABLE) {
    const row = db
      .query(
        `SELECT ts_ms, ${pct} AS pct, ${resets} AS resets
           FROM limit_samples
          WHERE source = ? AND ${pct} IS NOT NULL
          ORDER BY ts_ms DESC LIMIT 1`,
      )
      .get(source) as { ts_ms: number; pct: number; resets: string | null } | null;
    if (!row) continue;
    out.push({
      source,
      tsMs: row.ts_ms,
      ageMs: nowMs - row.ts_ms,
      percent: row.pct,
      resetsAt: row.resets,
    });
  }
  return out;
}

const freshest = (rs: LimitReading[]): LimitReading | null =>
  rs.reduce<LimitReading | null>(
    (best, r) =>
      best === null ||
      r.tsMs > best.tsMs ||
      (r.tsMs === best.tsMs && SOURCE_RANK[r.source] > SOURCE_RANK[best.source])
        ? r
        : best,
    null,
  );

/**
 * The current picture, reconciled across sources instead of taken from one.
 *
 * The previous version read `source = 'oauth-cache'` and nothing else, which
 * is how `cusage limits` came to report a confident 37% weekly while the
 * desktop series in the same database -- and the app on screen -- said 54%.
 * The cache had not been refreshed in 27 hours. Both numbers were archived
 * correctly; the query picked the wrong one and printed it without an age.
 *
 * So: every meter takes the freshest source that carries it, each reading
 * keeps its provenance and age, and two current sources that disagree produce
 * a `disagreements` entry rather than a silent winner. Nothing is averaged and
 * nothing is interpolated -- every number here is a reading some source
 * actually returned.
 */
export function currentLimits(
  db: Database,
  opts: { nowMs?: number; freshMs?: number } = {},
): LimitsNow | null {
  const nowMs = opts.nowMs ?? Date.now();
  const freshMs = opts.freshMs ?? FRESH_MS;

  const sources = (
    db
      .query(
        `SELECT source, MAX(ts_ms) AS ts_ms FROM limit_samples GROUP BY source`,
      )
      .all() as { source: LimitSource; ts_ms: number }[]
  )
    .map((r) => {
      const row = db
        .query(
          `SELECT five_hour_pct, seven_day_pct FROM limit_samples
            WHERE source = ? AND ts_ms = ?`,
        )
        .get(r.source, r.ts_ms) as
        | { five_hour_pct: number | null; seven_day_pct: number | null }
        | null;
      return {
        source: r.source,
        tsMs: r.ts_ms,
        ageMs: nowMs - r.ts_ms,
        fiveHourPct: row?.five_hour_pct ?? null,
        sevenDayPct: row?.seven_day_pct ?? null,
        reconcilable: RECONCILABLE.includes(r.source),
      };
    })
    .sort((a, b) => b.tsMs - a.tsMs);

  if (sources.length === 0) return null;

  const fh = readings(db, "five_hour", nowMs);
  const sd = readings(db, "seven_day", nowMs);
  const fiveHour = freshest(fh);
  const sevenDay = freshest(sd);

  // Only current-vs-current counts. A 27-hour-old cache differing from a
  // 4-minute-old reading is not a contradiction, it is just old, and the
  // sources table already says so.
  const disagreements: Disagreement[] = [];
  for (const [metric, all, chosen] of [
    ["five_hour", fh, fiveHour],
    ["seven_day", sd, sevenDay],
  ] as const) {
    if (!chosen || chosen.percent === null || chosen.ageMs > freshMs) continue;
    for (const other of all) {
      if (other.source === chosen.source || other.percent === null) continue;
      if (other.ageMs > freshMs) continue;
      const delta = Math.abs(other.percent - chosen.percent);
      if (delta > 2) disagreements.push({ metric, chosen, other, deltaPoints: delta });
    }
  }

  // limits[] only ever comes from an OAuth response; the desktop series has no
  // scoped breakdown at all, which is the entire reason the live fetch exists.
  const head = db
    .query(
      `SELECT ts_ms, source FROM limit_scoped
        WHERE source IN ('oauth-live', 'oauth-cache')
        ORDER BY ts_ms DESC,
                 CASE source WHEN 'oauth-live' THEN 1 ELSE 0 END DESC
        LIMIT 1`,
    )
    .get() as { ts_ms: number; source: LimitSource } | null;

  const scoped: ScopedLimit[] = head
    ? (
        db
          .query(
            `SELECT kind, group_name AS "group", scope_model, percent, severity,
                    resets_at, is_active
               FROM limit_scoped WHERE ts_ms = ? AND source = ?
              ORDER BY is_active DESC, percent DESC`,
          )
          .all(head.ts_ms, head.source) as any[]
      ).map((r) => ({
        ...r,
        is_active: !!r.is_active,
        source: head.source,
        tsMs: head.ts_ms,
        ageMs: nowMs - head.ts_ms,
      }))
    : [];

  // The sample carrying spend and the codename buckets. Desktop has neither.
  const rich = db
    .query(
      `SELECT * FROM limit_samples
        WHERE source IN ('oauth-live', 'oauth-cache')
        ORDER BY ts_ms DESC LIMIT 1`,
    )
    .get() as any;

  return {
    nowMs,
    freshMs,
    fiveHour,
    sevenDay,
    fiveHourPct: fiveHour?.percent ?? null,
    fiveHourResetsAt: fiveHour?.resetsAt ?? null,
    sevenDayPct: sevenDay?.percent ?? null,
    sevenDayResetsAt: sevenDay?.resetsAt ?? null,
    fetchedAt: (() => {
      const ts = [fiveHour?.tsMs, sevenDay?.tsMs].filter((n): n is number => n !== undefined);
      return ts.length ? new Date(Math.max(...ts)).toISOString() : null;
    })(),
    scoped,
    scopedSource: head?.source ?? null,
    scopedTsMs: head?.ts_ms ?? null,
    scopedAgeMs: head ? nowMs - head.ts_ms : null,
    scopedStale: head ? nowMs - head.ts_ms > freshMs : false,
    binding: scoped.find((r) => r.is_active) ?? null,
    disagreements,
    sources,
    extraUsagePct: rich?.extra_usage_pct ?? null,
    spendPct: rich?.spend_pct ?? null,
    buckets: rich?.raw_buckets ? JSON.parse(rich.raw_buckets) : {},
  };
}

/* -------------------------------------------------------- limits history -- */

export interface LimitBucket {
  tsMs: number;
  /** Peak within the bucket, not the mean. A limit you touched at 98% and
   *  backed off from is a fact about your week; the average hides it. */
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  scopedPct: number | null;
  samples: number;
}

export interface LimitsHistory {
  since: number;
  until: number;
  bucketMs: number;
  buckets: LimitBucket[];
  /** Which model the weekly_scoped series belongs to, when there is one. */
  scopedModel: string | null;
  scopedSamples: number;
  totalSamples: number;
  sources: { source: LimitSource; samples: number; firstTsMs: number; lastTsMs: number }[];
}

/** Bucket widths that read sensibly on a clock. */
const BUCKET_LADDER = [
  5 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000,
  3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000,
];

/** Keep the series renderable in a terminal: ~120 columns of history. */
export function chooseBucket(spanMs: number, target = 120): number {
  const ideal = Math.max(1, spanMs / target);
  return BUCKET_LADDER.find((b) => b >= ideal) ?? BUCKET_LADDER[BUCKET_LADDER.length - 1]!;
}

/**
 * The longitudinal view. `desktop-history` alone is ~2,000 samples at a
 * 15-minute cadence over a rolling 30 days, and until now nothing queried it.
 *
 * Empty buckets are emitted as nulls rather than skipped, so position in the
 * array is proportional to time. A sparkline that silently closes gaps turns
 * an outage into a smooth line.
 *
 * Glaze is excluded by default: one inferred value per day would otherwise
 * spike a five-hour series that is sampled every 15 minutes.
 */
export function limitsHistory(
  db: Database,
  opts: {
    since?: number | null;
    until?: number | null;
    bucketMs?: number | null;
    includeGlaze?: boolean;
    nowMs?: number;
  } = {},
): LimitsHistory {
  const nowMs = opts.nowMs ?? Date.now();
  const until = opts.until ?? nowMs;
  const since = opts.since ?? until - 7 * 86_400_000;
  const bucketMs = opts.bucketMs ?? chooseBucket(Math.max(until - since, 60_000));
  const glaze = opts.includeGlaze === true;

  const rows = db
    .query(
      `SELECT (ts_ms / $b) * $b AS bucket,
              MAX(five_hour_pct) AS fh,
              MAX(seven_day_pct) AS sd,
              COUNT(*) AS n
         FROM limit_samples
        WHERE ts_ms >= $since AND ts_ms <= $until
          AND ($glaze = 1 OR source <> 'glaze')
        GROUP BY bucket`,
    )
    .all({ $b: bucketMs, $since: since, $until: until, $glaze: glaze ? 1 : 0 }) as {
      bucket: number; fh: number | null; sd: number | null; n: number;
    }[];

  const scopedRows = db
    .query(
      `SELECT (ts_ms / $b) * $b AS bucket, MAX(percent) AS p
         FROM limit_scoped
        WHERE kind = 'weekly_scoped' AND ts_ms >= $since AND ts_ms <= $until
        GROUP BY bucket`,
    )
    .all({ $b: bucketMs, $since: since, $until: until }) as
      { bucket: number; p: number | null }[];

  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const scopedByBucket = new Map(scopedRows.map((r) => [r.bucket, r.p]));

  const first = Math.floor(since / bucketMs) * bucketMs;
  const last = Math.floor(until / bucketMs) * bucketMs;
  const buckets: LimitBucket[] = [];
  for (let t = first; t <= last; t += bucketMs) {
    const r = byBucket.get(t);
    buckets.push({
      tsMs: t,
      fiveHourPct: r?.fh ?? null,
      sevenDayPct: r?.sd ?? null,
      scopedPct: scopedByBucket.get(t) ?? null,
      samples: r?.n ?? 0,
    });
  }

  const scopedMeta = db
    .query(
      `SELECT scope_model, COUNT(*) AS n FROM limit_scoped
        WHERE kind = 'weekly_scoped' AND ts_ms >= $since AND ts_ms <= $until
        GROUP BY scope_model ORDER BY n DESC LIMIT 1`,
    )
    .get({ $since: since, $until: until }) as { scope_model: string; n: number } | null;

  const sources = db
    .query(
      `SELECT source, COUNT(*) AS samples, MIN(ts_ms) AS firstTsMs, MAX(ts_ms) AS lastTsMs
         FROM limit_samples
        WHERE ts_ms >= $since AND ts_ms <= $until
          AND ($glaze = 1 OR source <> 'glaze')
        GROUP BY source ORDER BY lastTsMs DESC`,
    )
    .all({ $since: since, $until: until, $glaze: glaze ? 1 : 0 }) as
      LimitsHistory["sources"];

  return {
    since, until, bucketMs, buckets,
    scopedModel: scopedMeta?.scope_model || null,
    scopedSamples: scopedMeta?.n ?? 0,
    totalSamples: rows.reduce((a, r) => a + r.n, 0),
    sources,
  };
}

export function archiveStats(db: Database) {
  const one = <T>(sql: string) => db.query(sql).get() as T;
  return {
    requests: one<{ c: number }>("SELECT COUNT(*) c FROM requests").c,
    sessions: one<{ c: number }>("SELECT COUNT(*) c FROM sessions").c,
    sessionsWithCost: one<{ c: number }>(
      "SELECT COUNT(*) c FROM sessions WHERE total_cost_usd IS NOT NULL",
    ).c,
    toolCalls: one<{ c: number }>("SELECT COUNT(*) c FROM tool_calls").c,
    limitSamples: one<{ c: number }>("SELECT COUNT(*) c FROM limit_samples").c,
    filesTracked: one<{ c: number }>("SELECT COUNT(*) c FROM ingest_state").c,
    firstTs: one<{ t: string | null }>("SELECT MIN(ts) t FROM requests").t,
    lastTs: one<{ t: string | null }>("SELECT MAX(ts) t FROM requests").t,
    totals: corpusTotals(db),
  };
}
