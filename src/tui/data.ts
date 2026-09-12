/** Archive lifecycle and bounded page cache. No rendering and no SQL aggregation. */
import { Database } from "bun:sqlite";
import { SCHEMA_VERSION } from "../schema.ts";
import * as query from "../query.ts";
import { doctor } from "../doctor.ts";
import { refreshFromApi } from "../limits.ts";

export function openArchive(file: string, writable = false) {
  let db: Database | undefined;
  try {
    db = new Database(
      file,
      writable ? { readwrite: true } : { readonly: true },
    );
    const version = (
      db.query("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
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
export const activities = [
  "All",
  "Today UTC",
  "Last 7 days",
  "Last 30 days",
] as const;
export type Activity = (typeof activities)[number];
export function activitySince(activity: Activity, now: number) {
  return activity === "All"
    ? null
    : activity === "Today UTC"
      ? Math.floor(now / DAY) * DAY
      : now - (activity === "Last 7 days" ? 7 : 30) * DAY;
}
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
export interface TuiDependencies {
  now: () => number;
  overview: () => OverviewData;
  page: (
    opts: query.SessionPageOptions,
  ) => ReturnType<typeof query.sessionPage>;
  costs: (ids: string[]) => Record<string, query.CostRow>;
  detail: (id: string) => query.SessionDetail | null;
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

/** Pages are fetched on demand; identity lookup after reload doesn't price skipped pages. */
export class SessionBrowser {
  private pages = new Map<number, query.SessionRow[]>();
  costs: Record<string, query.CostRow> = {};
  total = 0;
  constructor(
    private deps: TuiDependencies,
    public options: query.SessionPageOptions = {},
  ) {}
  page(index: number) {
    const offset = Math.floor(index / 100) * 100;
    if (!this.pages.has(offset)) {
      const result = this.deps.page({ ...this.options, offset, pageSize: 100 });
      this.pages.set(offset, result.rows);
      this.total = result.total;
    }
    return this.pages.get(offset)!;
  }
  row(index: number) {
    return this.page(index)[index % 100];
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
  locate(id: string | undefined, fallback: number) {
    this.page(0);
    if (id)
      for (let offset = 0; offset < this.total; offset += 100) {
        const i = this.page(offset).findIndex((r) => r.session_id === id);
        if (i >= 0) return offset + i;
      }
    return Math.max(0, Math.min(fallback, this.total - 1));
  }
}
