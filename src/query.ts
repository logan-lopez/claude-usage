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
  // No request count here: `requests`, inherited from TokenTotals, already is
  // one, counted live over the same rows. sessions.request_count is the cached
  // copy that exists so `WHERE request_count > 0` can skip the join; surfacing
  // both would put two fields with the same meaning in one --json object and
  // invite a consumer to pick the one that can lag.
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
  apiBlockCount: number;
  subAgents: BreakdownRow[];
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
      .query("SELECT session_id FROM sessions WHERE request_count > 0 ORDER BY last_ts_ms DESC LIMIT 1")
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
         s.first_ts, s.last_ts, s.total_cost_usd,
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
    apiBlockCount: (db.query("SELECT COUNT(DISTINCT api_block_index) n FROM requests WHERE session_id=?").get(sessionId) as { n: number }).n,
    subAgents: db.query(`SELECT COALESCE(agent_id, attribution_agent) key, ${TOTALS_SELECT} FROM requests
      WHERE session_id=? AND attribution_agent IS NOT NULL GROUP BY COALESCE(agent_id, attribution_agent) ORDER BY total_tokens DESC`).all(sessionId) as BreakdownRow[],
    main: half("is_sidechain = 0"),
    sidechain: half("is_sidechain = 1"),
    costModels,
    costBasis: session.total_cost_usd !== null ? "measured" : "estimated",
  };
}

export interface SessionsOptions extends RequestFilters {
  since?: number | null;
  by?: "project" | "model" | "entrypoint" | "branch" | null;
  limit?: number;
  project?: string | null;
}

export function listSessions(db: Database, opts: SessionsOptions = {}): SessionRow[] {
  const { since = null, until = null, limit = 30, project = null, model = null } = opts;
  return db
    .query(
      `${SESSION_SELECT}
        WHERE COALESCE(r.requests, 0) > 0
          AND ($since IS NULL OR s.last_ts_ms >= $since)
          AND ($until IS NULL OR s.last_ts_ms < $until)
          AND ($project IS NULL OR instr(lower(COALESCE(s.project,'')), lower($project)) > 0)
          AND ($model IS NULL OR EXISTS (SELECT 1 FROM requests mr WHERE mr.session_id=s.session_id AND instr(lower(COALESCE(mr.model,'')), lower($model)) > 0))
        ORDER BY s.last_ts_ms DESC
        LIMIT $limit`,
    )
    .all({ $since: since, $until: until, $project: project, $model: model, $limit: limit }) as SessionRow[];
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
  const column = { project: "project", model: "model", entrypoint: "entrypoint", branch: "git_branch" }[by];
  if (!column) throw new Error("invalid session grouping");
  const w = requestWhere(opts);
  const totals = db.query(`SELECT COALESCE(${column}, '(unknown)') key, COUNT(DISTINCT session_id) sessions,
    ${TOTALS_SELECT} FROM requests WHERE ${w.sql} GROUP BY ${column} ORDER BY total_tokens DESC`).all(w.params) as GroupRow[];
  const memberships = db.query(`SELECT DISTINCT session_id, COALESCE(${column}, '(unknown)') key FROM requests WHERE ${w.sql}`).all(w.params) as { session_id: string; key: string }[];
  const costs = new Map<string, ReturnType<typeof exactSessionCost>>();
  for (const id of new Set(memberships.map(r => r.session_id))) {
    const all = db.query(`SELECT COUNT(*) n, COUNT(DISTINCT COALESCE(${column}, '(unknown)')) groups FROM requests WHERE session_id=$id`).get({ $id: id }) as { n: number; groups: number };
    const selected = db.query(`SELECT COUNT(*) n FROM requests WHERE session_id=$id AND ${w.sql}`).get({ ...w.params, $id: id }) as { n: number };
    const cost = db.query("SELECT total_cost_usd FROM sessions WHERE session_id=?").get(id) as { total_cost_usd: number | null } | null;
    costs.set(id, exactSessionCost(cost?.total_cost_usd ?? null, all.groups, all.n === selected.n));
  }
  return totals.map(t => {
    const parts = memberships.filter(r => r.key === t.key).map(r => costs.get(r.session_id)!);
    return { ...t, cost_usd: parts.reduce((n, r) => n + r.cost_usd, 0),
      sessions_split: parts.reduce((n, r) => n + r.sessions_split, 0),
      sessions_unpriced: parts.reduce((n, r) => n + r.sessions_unpriced, 0), cost_complete: parts.every(r => r.cost_complete) };
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

/* ------------------------------------------ shared filtered CLI reports -- */
export interface RequestFilters {
  since?: number | null;
  until?: number | null;
  project?: string | null;
  model?: string | null;
  limit?: number;
}
function requestWhere(opts: RequestFilters, alias = "") {
  const p = alias ? `${alias}.` : "";
  return {
    sql: `($since IS NULL OR ${p}ts_ms >= $since) AND ($until IS NULL OR ${p}ts_ms < $until)
      AND ($project IS NULL OR instr(lower(COALESCE(${p}project,'')), lower($project)) > 0)
      AND ($model IS NULL OR instr(lower(COALESCE(${p}model,'')), lower($model)) > 0)`,
    params: { $since: opts.since ?? null, $until: opts.until ?? null,
      $project: opts.project ?? null, $model: opts.model ?? null },
  };
}
export interface Coverage { total: number; attributed: number; unattributed: number; percent: number; }
export function coverage(total: number, attributed: number): Coverage {
  return { total, attributed, unattributed: total - attributed, percent: total ? attributed / total * 100 : 0 };
}
function reportMeta(db: Database, opts: RequestFilters) {
  const w = requestWhere(opts);
  const r = db.query(`SELECT COUNT(*) total, MIN(ts_ms) firstTsMs, MAX(ts_ms) lastTsMs FROM requests WHERE ${w.sql}`)
    .get(w.params) as { total: number; firstTsMs: number | null; lastTsMs: number | null };
  return { source: "local transcripts" as const, since: opts.since ?? null, until: opts.until ?? null, ...r };
}
export const ATTRIBUTION_COLUMNS = {
  agent: "attribution_agent", skill: "attribution_skill", plugin: "attribution_plugin",
  mcp: "attribution_mcp_server", effort: "effort", entrypoint: "entrypoint",
  branch: "git_branch", version: "cc_version", model: "model",
} as const;
export type AttributionDimension = keyof typeof ATTRIBUTION_COLUMNS | "tool";
export function attribution(db: Database, by: AttributionDimension, opts: RequestFilters = {}) {
  const w = requestWhere(opts);
  const meta = reportMeta(db, opts);
  let rows: (BreakdownRow & { calls?: number })[];
  let attributed: number;
  if (by === "tool") {
    // One request may carry several calls of one tool and several tools. The
    // DISTINCT subquery keys on the full request primary key, so a request is
    // counted once per tool it used and its tokens are never multiplied by the
    // call count. Calls are counted separately because they are the one figure
    // that legitimately exceeds the request count.
    const pairs = `SELECT DISTINCT t.tool_name AS key, r.message_id, r.request_id, r.session_id,
        r.input_tokens, r.output_tokens, r.thinking_tokens, r.cache_creation_tokens,
        r.cache_read_tokens, r.ephemeral_5m, r.ephemeral_1h, r.total_tokens
      FROM tool_calls t JOIN requests r ON r.session_id = t.session_id AND r.message_id = t.message_id
      WHERE t.tool_name IS NOT NULL AND ${requestWhere(opts, "r").sql}`;
    const tokens = db.query(`SELECT key, ${TOTALS_SELECT} FROM (${pairs}) GROUP BY key`)
      .all(w.params) as BreakdownRow[];
    const calls = new Map((db.query(`SELECT t.tool_name AS key, COUNT(*) AS n FROM tool_calls t
      WHERE t.tool_name IS NOT NULL AND EXISTS (SELECT 1 FROM requests r
        WHERE r.session_id = t.session_id AND r.message_id = t.message_id AND ${requestWhere(opts, "r").sql})
      GROUP BY t.tool_name`).all(w.params) as { key: string; n: number }[]).map(r => [r.key, r.n]));
    rows = tokens.map(row => ({ ...row, calls: calls.get(row.key) ?? 0 }));
    // Requests reached by any tool at all: the sum of the rows above would
    // double-count a request that used more than one tool.
    attributed = (db.query(`SELECT COUNT(*) n FROM (SELECT DISTINCT r.message_id, r.request_id, r.session_id
      FROM tool_calls t JOIN requests r ON r.session_id = t.session_id AND r.message_id = t.message_id
      WHERE t.tool_name IS NOT NULL AND ${requestWhere(opts, "r").sql})`).get(w.params) as { n: number }).n;
  } else {
    const column = ATTRIBUTION_COLUMNS[by];
    if (!column) throw new Error("invalid attribution dimension");
    rows = db.query(`SELECT ${column} AS key, ${TOTALS_SELECT} FROM requests WHERE ${w.sql} AND ${column} IS NOT NULL
      GROUP BY ${column} ORDER BY total_tokens DESC, key`).all(w.params) as BreakdownRow[];
    attributed = rows.reduce((n, r) => n + r.requests, 0);
  }
  rows.sort((a, b) => b.total_tokens - a.total_tokens || a.key.localeCompare(b.key));
  return { ...meta, by, coverage: coverage(meta.total, attributed), groups: rows.length,
    overlapping: by === "tool", rows: rows.slice(0, opts.limit),
    note: by === "tool" ? "Tool groups overlap: request tokens are context, not per-tool consumption." : null };
}

export type TimelineBucket = "day" | "week" | "month" | "auto";
export function timeline(db: Database, opts: RequestFilters & { bucket?: TimelineBucket; by?: "model" | "project" | "effort" } = {}) {
  const meta = reportMeta(db, opts);
  const until = opts.until ?? Date.now();
  const since = opts.since ?? meta.firstTsMs ?? until;
  const bucket = opts.bucket ?? "day";
  const bucketMs = bucket === "auto" ? chooseBucket(until - since) : null;
  const start = (ms: number) => {
    if (bucketMs) return Math.floor(ms / bucketMs) * bucketMs;
    const d = new Date(ms); d.setUTCHours(0, 0, 0, 0);
    if (bucket === "month") d.setUTCDate(1);
    if (bucket === "week") d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    return d.getTime();
  };
  const next = (ms: number) => {
    if (bucketMs) return ms + bucketMs;
    if (bucket !== "month") return ms + (bucket === "week" ? 7 : 1) * 86_400_000;
    const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime();
  };
  const w = requestWhere({ ...opts, since, until });
  const expr = bucketMs ? `(ts_ms / ${bucketMs}) * ${bucketMs}` : bucket === "month"
    ? "CAST(strftime('%s', ts_ms/1000, 'unixepoch', 'start of month') AS INTEGER)*1000"
    : bucket === "week" ? "CAST(strftime('%s', ts_ms/1000, 'unixepoch', '-6 days', 'weekday 1', 'start of day') AS INTEGER)*1000"
    : "CAST(strftime('%s', ts_ms/1000, 'unixepoch', 'start of day') AS INTEGER)*1000";
  const column = opts.by && ["model", "project", "effort"].includes(opts.by) ? opts.by : null;
  const data = db.query(`SELECT ${expr} tsMs, ${column ? `COALESCE(${column}, '(unknown)')` : "'all'"} key,
    ${TOTALS_SELECT} FROM requests WHERE ${w.sql} GROUP BY tsMs, key ORDER BY tsMs, key`).all(w.params) as (BreakdownRow & { tsMs: number })[];
  const keys = [...new Set(data.map(r => r.key))];
  if (!keys.length) keys.push(column ? "(unknown)" : "all");
  const indexed = new Map(data.map(r => [`${r.tsMs}:${r.key}`, r]));
  const zero = db.query(`SELECT ${TOTALS_SELECT} FROM requests WHERE 0`).get() as TokenTotals;
  const rows: (BreakdownRow & { tsMs: number })[] = [];
  for (let t = start(since); t < until; t = next(t)) {
    for (const key of keys) rows.push(indexed.get(`${t}:${key}`) ?? { ...zero, tsMs: t, key });
    if (rows.length > 1_000_000) throw new Error("timeline exceeds one million rows; narrow --since/--until or use a coarser bucket");
  }
  const attributed = data.filter(r => r.key !== "(unknown)").reduce((n, r) => n + r.requests, 0);
  return { ...meta, since, until, timezone: "UTC", bucket, bucketMs, by: column,
    coverage: coverage(meta.total, attributed), buckets: rows.length, rows: rows.slice(0, opts.limit) };
}

export type ExportTable = "requests" | "sessions" | "tools" | "limits";
export function exportRows(db: Database, table: ExportTable, opts: RequestFilters = {}) {
  const name = { requests: "requests", sessions: "sessions", tools: "tool_calls", limits: "limit_samples" }[table];
  if (!name) throw new Error("invalid export table");
  const w = requestWhere(opts, "r");
  let sql: string;
  let params: Record<string, string | number | null> = w.params;
  if (table === "requests") sql = `SELECT r.* FROM requests r WHERE ${w.sql} ORDER BY ts_ms, session_id, message_id, request_id`;
  else if (table === "sessions") sql = `SELECT s.* FROM sessions s
    WHERE ($since IS NULL OR s.last_ts_ms >= $since) AND ($until IS NULL OR s.last_ts_ms < $until)
      AND ($project IS NULL OR instr(lower(COALESCE(s.project,'')), lower($project)) > 0)
      AND ($model IS NULL OR EXISTS (SELECT 1 FROM requests r WHERE r.session_id=s.session_id AND instr(lower(COALESCE(r.model,'')), lower($model)) > 0))
    ORDER BY last_ts_ms, session_id`;
  else if (table === "tools") sql = `SELECT t.* FROM tool_calls t
    WHERE ($since IS NULL OR t.ts_ms >= $since) AND ($until IS NULL OR t.ts_ms < $until)
      AND (($project IS NULL AND $model IS NULL) OR EXISTS (SELECT 1 FROM requests r
        WHERE r.session_id=t.session_id AND r.message_id=t.message_id
          AND ($project IS NULL OR instr(lower(COALESCE(r.project,'')), lower($project)) > 0)
          AND ($model IS NULL OR instr(lower(COALESCE(r.model,'')), lower($model)) > 0)))
    ORDER BY ts_ms, session_id, tool_use_id`;
  else {
    if (opts.project || opts.model) throw new Error("limit samples cannot be filtered by project or model");
    sql = "SELECT * FROM limit_samples WHERE ($since IS NULL OR ts_ms >= $since) AND ($until IS NULL OR ts_ms < $until) ORDER BY ts_ms, source";
    params = { $since: opts.since ?? null, $until: opts.until ?? null };
  }
  if (opts.limit) { sql += " LIMIT $limit"; params.$limit = opts.limit; }
  const columns = (db.query(`PRAGMA table_xinfo(${name})`).all() as { name: string }[]).map(r => r.name);
  return { columns, rows: db.query(sql).iterate(params) as Iterable<Record<string, unknown>> };
}

/** Database-only health evidence. OS checks live in doctor.ts. */
export function archiveHealth(db: Database) {
  const newest = (table: string) => (db.query(`SELECT MAX(ts_ms) ts FROM ${table}`).get() as { ts: number | null }).ts;
  return {
    integrity: (db.query("PRAGMA integrity_check").all() as Record<string, string>[]).flatMap(Object.values),
    newestRequest: newest("requests"), newestLimit: newest("limit_samples"),
    trackedFiles: (db.query("SELECT path FROM ingest_state").all() as { path: string }[]).map(r => r.path),
  };
}

/* ------------------------------------------------------- cost and cache -- */
import { estimateRequest, normalizeModel, pricingSnapshot, type PriceInput } from "./pricing.ts";

/** Shared exact-or-absent decision for all session-granularity cost views. */
export function exactSessionCost(cost: number | null, groups: number, completeSelection = true) {
  const split = groups > 1 || !completeSelection;
  return { cost_usd: !split && cost !== null ? cost : 0,
    sessions_split: split ? 1 : 0, sessions_unpriced: !split && cost === null ? 1 : 0,
    cost_complete: !split && cost !== null };
}
interface PricedRequest extends PriceInput {
  session_id: string; project: string | null; ts_ms: number | null;
}
function contextTiers(db: Database) {
  const tiers = db.query("SELECT session_id, model FROM cost_state_models WHERE model LIKE '%[1m]'").all() as { session_id: string; model: string }[];
  return new Set(tiers.map(r => `${r.session_id}:${normalizeModel(r.model).replace('[1m]', '')}`));
}
function withTier(row: PricedRequest, tiers: Set<string>): PricedRequest {
  return tiers.has(`${row.session_id}:${normalizeModel(row.model ?? '')}`) ? { ...row, model: `${row.model}[1m]` } : row;
}
export interface CostRow {
  key: string; basis: "measured" | "estimated"; source: string; sessions: number; requests: number;
  cost_usd: number; cost_complete: boolean; sessions_split: number; sessions_unpriced: number;
  priced_requests: number; unpriced_requests: number; unknown_tier_requests: number; reasons: string[];
}
export function cost(db: Database, opts: RequestFilters & { by?: "model" | "project" | "session" | "day"; basis?: "measured" | "estimated" } = {}) {
  const by = opts.by ?? "model";
  const meta = reportMeta(db, opts);
  const tiers = contextTiers(db);
  const w = requestWhere(opts);
  const selected = (db.query(`SELECT * FROM requests WHERE ${w.sql}`).all(w.params) as PricedRequest[]).map(r => withTier(r, tiers));
  const key = (row: PricedRequest) => by === "model" ? row.model ?? "(unknown)" : by === "project" ? row.project ?? "(unknown)" : by === "session" ? row.session_id : row.ts_ms === null ? "(unknown)" : new Date(row.ts_ms).toISOString().slice(0, 10);
  const sessions = new Map((db.query("SELECT session_id, total_cost_usd FROM sessions").all() as { session_id: string; total_cost_usd: number | null }[]).map(r => [r.session_id, r.total_cost_usd]));
  const selectedBySession = new Map<string, PricedRequest[]>();
  for (const row of selected) { const rs = selectedBySession.get(row.session_id) ?? []; rs.push(row); selectedBySession.set(row.session_id, rs); }
  const grouped = new Map<string, CostRow>();
  let measuredRequests = 0;
  const get = (group: string, basis: CostRow["basis"]) => {
    const id = `${basis}:${group}`;
    if (!grouped.has(id)) grouped.set(id, { key: group, basis, source: basis === "measured" ? "cumulative session cost-state (keep-max)" : "token estimate / committed pricing snapshot",
      sessions: 0, requests: 0, cost_usd: 0, cost_complete: true, sessions_split: 0, sessions_unpriced: 0,
      priced_requests: 0, unpriced_requests: 0, unknown_tier_requests: 0, reasons: [] });
    return grouped.get(id)!;
  };
  for (const [id, requests] of selectedBySession) {
    const measured = sessions.get(id) ?? null;
    if (measured !== null) measuredRequests += requests.length;
    const basis = measured !== null ? "measured" : "estimated";
    if (opts.basis && opts.basis !== basis) continue;
    const groups = new Set(requests.map(key));
    if (basis === "estimated") {
      for (const group of groups) get(group, basis).sessions++;
      for (const request of requests) {
        const row = get(key(request), basis); row.requests++; row.unknown_tier_requests++;
        const estimate = estimateRequest(request);
        if (estimate.usd === null) { row.unpriced_requests++; row.cost_complete = false; if (!row.reasons.includes(estimate.reason!)) row.reasons.push(estimate.reason!); }
        else { row.cost_usd += estimate.usd; row.priced_requests++; }
      }
    } else {
      // A cumulative measurement is not a spend-in-window value. Compare all
      // requests, not just filtered ones, before assigning a session total.
      const all = (db.query("SELECT * FROM requests WHERE session_id=?").all(id) as PricedRequest[]).map(r => withTier(r, tiers));
      const allGroups = new Set(all.map(key));
      const exact = exactSessionCost(measured, allGroups.size, all.length === requests.length);
      for (const group of groups) {
        const row = get(group, basis); row.sessions++;
        row.requests += requests.filter(r => key(r) === group).length;
        row.cost_usd += exact.cost_usd; row.sessions_split += exact.sessions_split;
        row.cost_complete &&= exact.cost_complete;
      }
    }
  }
  const rows = [...grouped.values()].sort((a, b) => a.basis.localeCompare(b.basis) || b.cost_usd - a.cost_usd || a.key.localeCompare(b.key));
  const totals = { measured: rows.filter(r => r.basis === "measured").reduce((n, r) => n + r.cost_usd, 0), estimated: rows.filter(r => r.basis === "estimated").reduce((n, r) => n + r.cost_usd, 0) };
  return { ...meta, by, coverage: coverage(meta.total, selected.filter(r => key(r) !== "(unknown)").length),
    measuredCoverage: coverage(meta.total, measuredRequests), pricing: pricingSnapshot,
    note: "Measured and estimated amounts are separate. + excludes split/partially selected sessions or unknown rates. Unmeasured sessions cannot distinguish [1m] tiers; cache creation assumes the supplied 5m rate.",
    totals, groups: rows.length, rows: rows.slice(0, opts.limit) };
}

/**
 * Offline estimator audit: partial known-rate subtotal, not a fitted model.
 *
 * The error distribution is reported over *fully priced* sessions only, and
 * that split is the whole point. A session whose every request is `[1m]` or an
 * unknown model estimates to $0 and scores a relative error of exactly 1.0 --
 * which is not a 100% estimation error, it is an absence being graded as a
 * wrong answer. Pooling the two put 37 sessions at exactly 1.0 and pinned p90
 * to 100%, a number that says nothing about the estimator and cannot move when
 * the estimator improves. `declined` carries those sessions and their measured
 * dollars so the hole stays visible rather than being smoothed into a quantile.
 */
export function estimatorAudit(db: Database) {
  const tiers = contextTiers(db);
  const sessions = db.query("SELECT session_id, total_cost_usd FROM sessions WHERE total_cost_usd IS NOT NULL ORDER BY session_id").all() as { session_id: string; total_cost_usd: number }[];
  const rows = sessions.map(session => {
    const requests = db.query("SELECT * FROM requests WHERE session_id=?").all(session.session_id) as PricedRequest[];
    let estimated = 0, unpriced = 0;
    for (const raw of requests) { const price = estimateRequest(withTier(raw, tiers)); if (price.usd === null) unpriced++; else estimated += price.usd; }
    return { session_id: session.session_id, measured: session.total_cost_usd, estimated,
      unpricedRequests: unpriced, requests: requests.length,
      absoluteError: Math.abs(estimated - session.total_cost_usd), relativeError: session.total_cost_usd > 0 ? Math.abs(estimated - session.total_cost_usd) / session.total_cost_usd : null };
  });
  const sum = (rs: typeof rows, key: "measured" | "estimated" | "requests" | "unpricedRequests") => rs.reduce((n, r) => n + r[key], 0);
  // A session with no ingested requests is vacuously "fully priced" at $0 and
  // scores 1.0 as well; six of them exist in the corpus. Same absence, same
  // exclusion.
  const priceable = (r: (typeof rows)[number]) => r.requests > 0 && r.unpricedRequests === 0;
  const scored = rows.filter(r => priceable(r) && r.relativeError !== null);
  const declined = rows.filter(r => !priceable(r));
  const errors = scored.map(r => r.relativeError!).sort((a, b) => a - b);
  const quantile = (p: number) => errors.length ? errors[Math.min(errors.length - 1, Math.ceil(p * errors.length) - 1)]! : null;
  return {
    sessions: rows.length,
    zeroCostSessions: rows.filter(r => r.relativeError === null).length,
    measured: sum(rows, "measured"), estimated: sum(rows, "estimated"),
    /** Every request priced and a positive measured total: the only sessions an error can be computed for. */
    priced: { sessions: scored.length, measured: sum(scored, "measured"), estimated: sum(scored, "estimated"),
      median: quantile(.5), p90: quantile(.9), worst: errors.at(-1) ?? null },
    /** Nothing to price, or a request the estimator refused to price. Not an error -- a gap. */
    declined: { sessions: declined.length, measured: sum(declined, "measured"),
      requests: sum(declined, "requests"), unpricedRequests: sum(declined, "unpricedRequests"),
      sessionsWithNoRequests: declined.filter(r => r.requests === 0).length },
    rows,
  };
}

export function cache(db: Database, opts: RequestFilters & { by?: "model" | "project" } = {}) {
  const by = opts.by ?? "model";
  const meta = reportMeta(db, opts), w = requestWhere(opts);
  const column = by === "project" ? "project" : "model";
  const rows = (db.query(`SELECT COALESCE(${column}, '(unknown)') key, ${TOTALS_SELECT} FROM requests WHERE ${w.sql}
    GROUP BY ${column} ORDER BY total_tokens DESC, key`).all(w.params) as BreakdownRow[]).map(row => ({ ...row,
      readCreationRatio: row.cache_creation_tokens ? row.cache_read_tokens / row.cache_creation_tokens : null,
      reconciliationGap: row.cache_creation_tokens - row.ephemeral_5m - row.ephemeral_1h,
    }));
  return { ...meta, by, coverage: coverage(meta.total, rows.filter(r => r.key !== "(unknown)").reduce((n, r) => n + r.requests, 0)),
    groups: rows.length, rows: rows.slice(0, opts.limit) };
}

/* ---------------------------------------- observed five-hour meter cycles -- */
export interface MeterCycle {
  kind: "cycle" | "gap";
  startMs: number; endMs: number;
  startReason: "observation" | "drop" | "gap";
  peakPct: number | null; peakAtMs: number | null; timeToPeakMs: number | null;
  resetAtMs: number | null; resetConfirmed: boolean;
  resetBetween: [number, number] | null;
  samples: number; local: TokenTotals | null;
}
/** Fixed-anchor clustering avoids both equality keys and transitive drift. */
export function clusterResets(times: number[], tolerance = 120_000): number[][] {
  const clusters: number[][] = [];
  for (const t of [...times].filter(Number.isFinite).sort((a, b) => a - b)) {
    const last = clusters.at(-1);
    if (last && t - last[0]! <= tolerance) last.push(t); else clusters.push([t]);
  }
  return clusters;
}
export function blocks(db: Database, opts: RequestFilters = {}) {
  const until = opts.until ?? Date.now();
  const earliest = (db.query("SELECT MIN(ts_ms) t FROM limit_samples WHERE source <> 'glaze'").get() as { t: number | null }).t;
  const since = opts.since ?? earliest ?? until;
  const samples = db.query(`SELECT ts_ms, source, five_hour_pct pct, five_hour_resets_at reset FROM limit_samples
    WHERE ts_ms >= $since AND ts_ms < $until AND source <> 'glaze' AND five_hour_pct IS NOT NULL ORDER BY ts_ms`)
    .all({ $since: since, $until: until }) as { ts_ms: number; source: string; pct: number; reset: string | null }[];
  // Do not turn disagreement between different sources into a meter drop.
  const source = samples.some(s => s.source === "desktop-history") ? "desktop-history"
    : samples.some(s => s.source === "oauth-live") ? "oauth-live" : "oauth-cache";
  const meter = samples.filter(s => s.source === source);
  // Mixing sources would turn a disagreement between them into a spurious
  // drop, so only one series drives the boundaries. The samples that lose are
  // still real observations, and some of the rendered gaps are them -- say so
  // rather than letting missing data and set-aside data look identical.
  const setAside = { samples: samples.length - meter.length,
    sources: [...new Set(samples.filter(s => s.source !== source).map(s => s.source))].sort() };
  const resets = clusterResets(samples.filter(s => s.source.startsWith("oauth") && s.reset).map(s => Date.parse(s.reset!)));
  const rows: MeterCycle[] = [];
  let active: MeterCycle | null = null;
  let previous: typeof meter[number] | undefined;
  const begin = (sample: typeof meter[number], reason: MeterCycle["startReason"]) => ({
    kind: "cycle" as const, startMs: sample.ts_ms, endMs: sample.ts_ms + 1, startReason: reason,
    peakPct: sample.pct, peakAtMs: sample.ts_ms, timeToPeakMs: 0,
    resetAtMs: null, resetConfirmed: false, resetBetween: null, samples: 0, local: null,
  });
  for (const sample of meter) {
    const gap = previous && sample.ts_ms - previous.ts_ms > 30 * 60_000;
    const drop = previous && !gap && previous.pct - sample.pct >= 5 && sample.pct <= previous.pct * .5;
    if (!active) active = begin(sample, "observation");
    else if (gap) {
      active.endMs = previous!.ts_ms + 1; rows.push(active);
      rows.push({ ...begin(sample, "gap"), kind: "gap", startMs: previous!.ts_ms + 1, endMs: sample.ts_ms,
        peakPct: null, peakAtMs: null, timeToPeakMs: null });
      active = begin(sample, "gap");
    } else if (drop) {
      active.endMs = sample.ts_ms;
      active.resetBetween = [previous!.ts_ms, sample.ts_ms];
      const confirmations = resets.filter(c => c[0]! >= previous!.ts_ms - 120_000 && c.at(-1)! <= sample.ts_ms + 120_000);
      if (confirmations.length === 1) {
        active.resetAtMs = confirmations[0]![Math.floor(confirmations[0]!.length / 2)]!;
        active.resetConfirmed = true;
      }
      rows.push(active); active = begin(sample, "drop");
    }
    active.samples++;
    active.endMs = sample.ts_ms + 1;
    if (sample.pct > (active.peakPct ?? -1)) {
      active.peakPct = sample.pct; active.peakAtMs = sample.ts_ms; active.timeToPeakMs = sample.ts_ms - active.startMs;
    }
    previous = sample;
  }
  if (active) rows.push(active);
  for (const row of rows) if (row.kind === "cycle") {
    const w = requestWhere({ ...opts, since: row.startMs, until: row.endMs });
    row.local = db.query(`SELECT ${TOTALS_SELECT} FROM requests WHERE ${w.sql}`).get(w.params) as TokenTotals;
  }
  const meta = reportMeta(db, opts);
  const covered = rows.reduce((n, r) => n + (r.local?.requests ?? 0), 0);
  return { since, until, source, setAside, lastSampleMs: meter.at(-1)?.ts_ms ?? null, samples: meter.length,
    coverage: coverage(meta.total, covered), resetToleranceMs: 120_000, gapThresholdMs: 1_800_000,
    dropRule: "drop of at least 5 percentage points and at least 50% between adjacent samples of one source",
    note: "Observed meter cycles, not inferred 5h token blocks. First/last cycles and gaps are partial. Time to peak is from first observation. Reset time is confirmed only by OAuth, otherwise bracketed by samples. Local activity is context, not explanation: historical r=0.69; 39% of intervals >=15% had no local activity.",
    cycles: rows.filter(r => r.kind === "cycle").length, rows: rows.slice(0, opts.limit) };
}

/**
 * Tokens, not cost, and deliberately.
 *
 * `cost --by day` is right to exclude any session whose requests straddle a
 * bucket boundary -- a cumulative cost-state total cannot be split across two
 * days. But the session you are sitting in almost always started before UTC
 * midnight, so the in-progress session is always excluded and "today" reads
 * $0.00 for most of the day. A statusline that shows $0.00 while you spend
 * money is the "never present a derived number as fact" failure wearing the
 * opposite mask. Tokens need no attribution and no pricing snapshot, so they
 * are exact. Cost lives in `cusage cost`, where the exclusions are visible.
 */
export function statusline(db: Database, nowMs = Date.now()) {
  const limits = currentLimits(db, { nowMs });
  const day = new Date(nowMs); day.setUTCHours(0, 0, 0, 0);
  const totals = corpusTotals(db, day.getTime());
  const latestRequestMs = (db.query("SELECT MAX(ts_ms) t FROM requests").get() as { t: number | null }).t;
  return { nowMs, limits, today: { timezone: "UTC", since: day.getTime(), ...totals, latestRequestMs } };
}

/** Preserve groupSessions' array API while adding full-selection CLI metadata. */
export function sessionGroupsReport(db: Database, by: NonNullable<SessionsOptions["by"]>, opts: RequestFilters = {}) {
  const rows = groupSessions(db, by, opts);
  const meta = reportMeta(db, opts);
  const attributed = rows.filter(r => r.key !== "(unknown)").reduce((n, r) => n + r.requests, 0);
  return { ...meta, by, coverage: coverage(meta.total, attributed), groups: rows.length, rows: rows.slice(0, opts.limit) };
}
