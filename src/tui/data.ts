/**
 * Opening the archive, the query-backed dependencies the screens read through, and the session page
 * cache. No rendering and no SQL aggregation.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { SCHEMA_VERSION } from "../schema.ts";
import * as query from "../query.ts";
import { doctor } from "../doctor.ts";
import { refreshFromApi } from "../limits.ts";

/** Open and read user_version; the first read is where an unusable file fails. */
function probe(file: string, mode: "readonly" | "readwrite" | "query-only") {
  const db = new Database(
    file,
    mode === "readonly" ? { readonly: true } : { readwrite: true },
  );
  try {
    if (mode === "query-only") db.run("PRAGMA query_only = ON");
    const { user_version } = db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    return { db, version: user_version };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * A read-only connection cannot create the -wal/-shm files a WAL archive needs,
 * so a fresh copy or restored backup fails on first read. Fall back to a
 * read-write handle that still never creates the file and refuses every write.
 */
function connect(file: string, writable: boolean) {
  if (writable) return probe(file, "readwrite");
  try {
    return probe(file, "readonly");
  } catch (error) {
    if (!existsSync(file)) throw error;
    return probe(file, "query-only");
  }
}

export function openArchive(file: string, writable = false) {
  let db: Database | undefined;
  try {
    let version: number;
    ({ db, version } = connect(file, writable));
    if (version !== SCHEMA_VERSION)
      throw new Error(`schema ${version}, expected ${SCHEMA_VERSION}`);
    db.run("PRAGMA busy_timeout = 1000");
    return db;
  } catch (error) {
    db?.close();
    throw new Error(
      `Cannot browse archive. Run cusage sync --db ${file} with a compatible cusage version. ${error instanceof Error ? error.message : "Database unreadable"}`,
    );
  }
}
export const dataVersion = (db: Database) =>
  (db.query("PRAGMA data_version").get() as { data_version: number })
    .data_version;
export const DAY = 86_400_000;
export function readOverview(db: Database, now: number) {
  const today = Math.floor(now / DAY) * DAY;
  const hour = Math.floor(now / 3_600_000) * 3_600_000;
  return db.transaction(() => {
    const recent = query.sessionPage(db, { pageSize: 6 }).rows;
    return {
      inventory: query.archiveStats(db),
      limits: query.currentLimits(db, { nowMs: now }),
      history: query.limitsHistory(db, {
        since: hour - 71 * 3_600_000,
        until: now,
        bucketMs: 3_600_000,
        nowMs: now,
      }),
      daily: query.timeline(db, {
        since: today - 29 * DAY,
        until: Math.max(today + 1, now),
        bucket: "day",
      }).rows,
      recent,
      costs: query.sessionCosts(
        db,
        recent.map((s) => s.session_id),
      ),
    };
  })();
}
export type OverviewData = ReturnType<typeof readOverview>;

/** Breakdown's dimensions, in ←→ order. The first four come with sessions and exact-or-absent cost. */
export const BREAKDOWN_DIMENSIONS = [
  "project", "model", "skill", "agent", "mcp", "plugin", "tool", "effort", "entrypoint", "branch", "version",
] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];
const GROUPED = ["project", "model", "entrypoint", "branch"] as const;
type Grouped = (typeof GROUPED)[number];
const grouped = (by: BreakdownDimension): by is Grouped => (GROUPED as readonly string[]).includes(by);
/** One group: tokens always; sessions and cost for a grouped dimension; calls for tool. */
export type BreakdownGroup = query.BreakdownRow &
  Partial<Pick<query.GroupRow, "sessions" | "cost_usd" | "cost_complete">> & { calls?: number };
export interface BreakdownData {
  rows: BreakdownGroup[];
  coverage: query.Coverage;
  /** The window's total tokens, for each row's share. Tool rows overlap, so theirs can add past it. */
  tokens: number;
  overlapping: boolean;
  note: string | null;
  /** Rows carry sessions and measured cost. */
  priced: boolean;
}
/** Breakdown's one read: `sessionGroupsReport` for the grouped dimensions, `attribution` for the rest. */
export function readBreakdown(db: Database, by: BreakdownDimension, opts: { since: number | null }): BreakdownData {
  return db.transaction(() => {
    if (grouped(by)) {
      // Every request lands in exactly one group, so the rows add up to the window.
      const report = query.sessionGroupsReport(db, by, opts);
      return { rows: report.rows, coverage: report.coverage, tokens: report.rows.reduce((n, r) => n + r.total_tokens, 0),
        overlapping: false, note: null, priced: true };
    }
    const report = query.attribution(db, by, opts);
    return { rows: report.rows, coverage: report.coverage, tokens: query.corpusTotals(db, opts.since).total_tokens,
      overlapping: report.overlapping, note: report.note, priced: false };
  })();
}
/** Timeline's buckets and splits, in `b` and `g` order. */
export const TIMELINE_BUCKETS = ["day", "week", "month"] as const;
export type TimelineBucket = (typeof TIMELINE_BUCKETS)[number];
export const TIMELINE_SPLITS = [null, "model", "project", "effort"] as const;
export type TimelineSplit = (typeof TIMELINE_SPLITS)[number];
/** One bucket, `[tsMs, endMs)`: its totals, and its series with any requests, by output tokens. */
export interface TimelineSlot {
  tsMs: number;
  endMs: number;
  output: number;
  total: query.TokenTotals;
  rows: query.BreakdownRow[];
}
export interface TimelineData { buckets: TimelineSlot[] }
/** The bucket boundary after `ms`, a bucket start: what `timeline()` steps by. */
function nextBucket(ms: number, bucket: TimelineBucket) {
  if (bucket !== "month") return ms + (bucket === "week" ? 7 : 1) * DAY;
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}
const TOTAL_KEYS = [
  "requests", "input_tokens", "output_tokens", "thinking_tokens", "cache_creation_tokens",
  "cache_read_tokens", "ephemeral_5m", "ephemeral_1h", "total_tokens",
] as const satisfies readonly (keyof query.TokenTotals)[];
/**
 * Timeline's one read: every bucket from the first request to `now`. `timeline()` zero-fills every
 * series in every bucket (365 a day by project), so only series with requests are kept.
 */
export function readTimeline(db: Database, bucket: TimelineBucket, by: TimelineSplit, now: number): TimelineData {
  const rows = db.transaction(() => query.timeline(db, { bucket, by: by ?? undefined, until: now }).rows)();
  const buckets: TimelineSlot[] = [];
  for (const r of rows) {
    let slot = buckets.at(-1);
    if (slot?.tsMs !== r.tsMs) {
      const total = Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0])) as unknown as query.TokenTotals;
      buckets.push((slot = { tsMs: r.tsMs, endMs: nextBucket(r.tsMs, bucket), output: 0, total, rows: [] }));
    }
    for (const k of TOTAL_KEYS) slot.total[k] += r[k];
    slot.output = slot.total.output_tokens;
    if (r.requests) slot.rows.push(r);
  }
  for (const slot of buckets) slot.rows.sort((a, b) => b.output_tokens - a.output_tokens || a.key.localeCompare(b.key));
  return { buckets };
}

/** Limits' one read for a zoom: the meter history and the five-hour cycles since `since`. */
export function readLimits(db: Database, since: number, bucketMs: number, now: number) {
  return db.transaction(() => ({
    history: query.limitsHistory(db, { since, until: now, bucketMs, nowMs: now }),
    cycles: query.blocks(db, { since, until: now }),
  }))();
}
export type LimitsData = ReturnType<typeof readLimits>;
export type Diagnostics = Awaited<ReturnType<typeof doctor>>;
export interface TuiDependencies {
  now: () => number;
  overview: () => OverviewData;
  page: (
    opts: query.SessionPageOptions,
  ) => ReturnType<typeof query.sessionPage>;
  costs: (ids: string[]) => Record<string, query.CostRow>;
  detail: (id: string) => query.SessionDetail | null;
  breakdown: (by: BreakdownDimension, opts: { since: number | null }) => BreakdownData;
  timeline: (bucket: TimelineBucket, by: TimelineSplit) => TimelineData;
  limits: (since: number, bucketMs: number) => LimitsData;
  version: () => number;
  diagnostics: () => ReturnType<typeof doctor>;
  refresh: () => ReturnType<typeof refreshFromApi>;
  pollMs: number;
  cancelPending?: () => void;
}
export function archiveDependencies(
  db: Database,
  file: string,
): TuiDependencies {
  let pending: AbortController | null = null;
  return {
    cancelPending: () => pending?.abort(),
    now: Date.now,
    overview: () => readOverview(db, Date.now()),
    page: (opts) => query.sessionPage(db, opts),
    costs: (ids) => query.sessionCosts(db, ids),
    detail: (id) => query.getSession(db, id),
    breakdown: (by, opts) => readBreakdown(db, by, opts),
    timeline: (bucket, by) => readTimeline(db, bucket, by, Date.now()),
    limits: (since, bucketMs) => readLimits(db, since, bucketMs, Date.now()),
    version: () => dataVersion(db),
    diagnostics: () => doctor(db, file, { archiveOnly: true }),
    pollMs: 5000,
    refresh: async () => {
      if (process.env.CUSAGE_REFRESH === "off")
        return refreshFromApi(db, { mode: "off" });
      // No migration or creation, including on the explicitly writable path.
      const writable = openArchive(file, true);
      pending = new AbortController();
      try {
        return await refreshFromApi(writable, {
          mode: "force",
          signal: pending.signal,
        });
      } finally {
        writable.close();
        pending = null;
      }
    },
  };
}

const PAGE = 100;

/**
 * Pages are fetched on demand; identity lookup after reload doesn't price skipped pages. Pages and
 * costs are never evicted: a browser lives until the next filter change or reload replaces it, which
 * bounds it at the archive's session count (hundreds to low thousands).
 */
export class SessionBrowser {
  private pages = new Map<number, query.SessionRow[]>();
  costs: Record<string, query.CostRow> = {};
  total = 0;
  constructor(
    private deps: TuiDependencies,
    public options: query.SessionPageOptions = {},
  ) {}
  page(index: number) {
    const offset = Math.floor(index / PAGE) * PAGE;
    let rows = this.pages.get(offset);
    if (!rows) {
      const result = this.deps.page({ ...this.options, offset, pageSize: PAGE });
      rows = result.rows;
      this.pages.set(offset, rows);
      this.total = result.total;
    }
    return rows;
  }
  row(index: number) {
    return this.page(index)[index % PAGE];
  }
  visible(start: number, count: number) {
    this.page(start);
    const rows: query.SessionRow[] = [];
    for (let i = start; i < Math.min(this.total, start + count); i++) {
      const row = this.row(i);
      if (row) rows.push(row);
    }
    const missing = rows
      .map((r) => r.session_id)
      .filter((id) => !this.costs[id]);
    if (missing.length) Object.assign(this.costs, this.deps.costs(missing));
    return rows;
  }
  /**
   * Index of `id`, else `fallback` clamped. A reload rarely moves the selection
   * far, so the page around the old position is searched first; the rest are
   * read only if the session moved across pages.
   */
  locate(id: string | undefined, fallback: number) {
    this.page(0);
    const last = Math.max(0, this.total - 1);
    const near = Math.floor(Math.min(Math.max(0, fallback), last) / PAGE) * PAGE;
    if (id)
      for (const offset of [
        near,
        ...Array.from({ length: Math.ceil(this.total / PAGE) }, (_, i) => i * PAGE),
      ]) {
        const i = this.page(offset).findIndex((r) => r.session_id === id);
        if (i >= 0) return offset + i;
      }
    return Math.max(0, Math.min(fallback, last));
  }
}
