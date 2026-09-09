/**
 * Every read query lives here. Data in, plain objects out.
 *
 * This module must never format anything, never print anything, and never read
 * process.argv. The CLI and the Ink TUI are both consumers of these functions;
 * the moment a query starts returning a padded string, the TUI has to reparse
 * it and the layering is gone.
 */
import type { Database } from "bun:sqlite";

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

export interface LimitsNow {
  fetchedAt: string | null;
  fiveHourPct: number | null;
  fiveHourResetsAt: string | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: string | null;
  scoped: {
    kind: string; group: string; scope_model: string; percent: number | null;
    severity: string | null; resets_at: string | null; is_active: boolean;
  }[];
  extraUsagePct: number | null;
  spendPct: number | null;
  buckets: Record<string, unknown>;
}

export function currentLimits(db: Database): LimitsNow | null {
  const s = db
    .query(
      `SELECT * FROM limit_samples WHERE source = 'oauth-cache' ORDER BY ts_ms DESC LIMIT 1`,
    )
    .get() as any;
  if (!s) return null;
  const scoped = db
    .query(
      `SELECT kind, group_name AS "group", scope_model, percent, severity, resets_at, is_active
         FROM limit_scoped WHERE ts_ms = ? AND source = 'oauth-cache'
        ORDER BY is_active DESC, percent DESC`,
    )
    .all(s.ts_ms) as any[];
  return {
    fetchedAt: new Date(s.ts_ms).toISOString(),
    fiveHourPct: s.five_hour_pct,
    fiveHourResetsAt: s.five_hour_resets_at,
    sevenDayPct: s.seven_day_pct,
    sevenDayResetsAt: s.seven_day_resets_at,
    scoped: scoped.map((r) => ({ ...r, is_active: !!r.is_active })),
    extraUsagePct: s.extra_usage_pct,
    spendPct: s.spend_pct,
    buckets: s.raw_buckets ? JSON.parse(s.raw_buckets) : {},
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
