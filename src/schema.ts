import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./paths.ts";

export const SCHEMA_VERSION = 3;

/**
 * Migrations are append-only. Index N runs when user_version < N + 1.
 * Never edit a shipped entry -- add a new one.
 *
 * Exported so the migration test can build a genuine v1 archive from
 * `MIGRATIONS[0]` rather than rewinding a current one by hand. A hand-rewound
 * archive needs a fresh undo written for every migration added, and gets it
 * wrong silently when someone forgets.
 */
export const MIGRATIONS: string[] = [
  /* ---------------------------------------------------------------- v1 -- */ `
CREATE TABLE requests (
  -- Key. request_id is '' (never NULL) when the transcript omits it: 228
  -- records corpus-wide do. NULLs never compare equal, so on a rowid table
  -- those would insert a fresh duplicate on every single sync and an
  -- idempotency test would still pass. WITHOUT ROWID makes the key columns
  -- genuinely NOT NULL and makes the documented fallback key exact.
  message_id            TEXT    NOT NULL,
  request_id            TEXT    NOT NULL,
  session_id            TEXT    NOT NULL,

  ts                    TEXT,
  ts_ms                 INTEGER,

  model                 TEXT,
  effort                TEXT,
  entrypoint            TEXT,
  session_kind          TEXT,
  is_sidechain          INTEGER NOT NULL DEFAULT 0,
  agent_id              TEXT,

  cwd                   TEXT,
  project               TEXT,
  git_branch            TEXT,

  api_block_index       INTEGER,
  cc_version            TEXT,
  slug                  TEXT,
  service_tier          TEXT,
  speed                 TEXT,
  stop_reason           TEXT,

  attribution_agent      TEXT,
  attribution_skill      TEXT,
  attribution_plugin     TEXT,
  attribution_mcp_server TEXT,
  attribution_mcp_tool   TEXT,

  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  thinking_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  ephemeral_5m          INTEGER NOT NULL DEFAULT 0,
  ephemeral_1h          INTEGER NOT NULL DEFAULT 0,
  web_search_requests   INTEGER NOT NULL DEFAULT 0,
  web_fetch_requests    INTEGER NOT NULL DEFAULT 0,

  -- The quantity the keep-max dedup rule compares. Virtual: computed on read,
  -- costs no storage. The UPSERT spells the arithmetic out explicitly anyway
  -- rather than leaning on excluded.total_tokens.
  total_tokens INTEGER GENERATED ALWAYS AS
    (input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) VIRTUAL,

  PRIMARY KEY (message_id, request_id, session_id)
) WITHOUT ROWID;

CREATE INDEX requests_ts        ON requests (ts_ms);
CREATE INDEX requests_session   ON requests (session_id, ts_ms);
CREATE INDEX requests_project   ON requests (project, ts_ms);
CREATE INDEX requests_model     ON requests (model, ts_ms);
CREATE INDEX requests_block     ON requests (session_id, api_block_index);
CREATE INDEX requests_agent     ON requests (attribution_agent) WHERE attribution_agent IS NOT NULL;
CREATE INDEX requests_skill     ON requests (attribution_skill) WHERE attribution_skill IS NOT NULL;
CREATE INDEX requests_mcp       ON requests (attribution_mcp_server) WHERE attribution_mcp_server IS NOT NULL;
CREATE INDEX requests_plugin    ON requests (attribution_plugin) WHERE attribution_plugin IS NOT NULL;

CREATE TABLE sessions (
  session_id      TEXT PRIMARY KEY,
  slug            TEXT,
  project         TEXT,
  cwd             TEXT,
  git_branch      TEXT,
  entrypoint      TEXT,
  first_ts        TEXT,
  last_ts         TEXT,
  first_ts_ms     INTEGER,
  last_ts_ms      INTEGER,
  -- Renamed to request_count in v2; it never counted messages. Shipped
  -- migrations are never edited, so the misnomer stays here and nowhere else.
  message_count   INTEGER NOT NULL DEFAULT 0,

  -- cost-state roll-up. Present for roughly a third of sessions; the rest are
  -- priced from pricing-snapshot.json and flagged 'estimated'.
  total_cost_usd                REAL,
  total_api_duration_ms         INTEGER,
  total_api_duration_no_retry_ms INTEGER,
  total_tool_duration_ms        INTEGER,
  total_lines_added             INTEGER,
  total_lines_removed           INTEGER,
  total_duration_ms             INTEGER,
  cost_start_time               TEXT,
  has_unknown_model_cost        INTEGER
);

CREATE INDEX sessions_last ON sessions (last_ts_ms DESC);
CREATE INDEX sessions_project ON sessions (project, last_ts_ms DESC);

-- The only place claude-opus-5[1m] is distinguishable from claude-opus-5.
-- Join here before pricing anything.
CREATE TABLE cost_state_models (
  session_id                TEXT NOT NULL,
  model                     TEXT NOT NULL,
  input_tokens              INTEGER NOT NULL DEFAULT 0,
  output_tokens             INTEGER NOT NULL DEFAULT 0,
  thinking_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  web_search_requests       INTEGER NOT NULL DEFAULT 0,
  cost_usd                  REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, model)
) WITHOUT ROWID;

CREATE TABLE tool_calls (
  -- tool_use blocks carry their own id and are replayed verbatim inside the
  -- duplicate streaming snapshots, so the id is what makes this idempotent.
  session_id  TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  message_id  TEXT,
  ts          TEXT,
  ts_ms       INTEGER,
  tool_name   TEXT,
  mcp_server  TEXT,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  agent_id    TEXT,
  PRIMARY KEY (session_id, tool_use_id)
) WITHOUT ROWID;

CREATE INDEX tool_calls_name ON tool_calls (tool_name, ts_ms);
CREATE INDEX tool_calls_mcp  ON tool_calls (mcp_server) WHERE mcp_server IS NOT NULL;

CREATE TABLE limit_samples (
  ts_ms          INTEGER NOT NULL,
  -- 'oauth-cache' = server truth from ~/.claude.json (Source 3)
  -- 'desktop-history' = Claude.app 15-minute series (Source 4)
  -- 'glaze' = Glaze wrapper daily map (Source 4b); five_hour, day granularity
  source         TEXT NOT NULL,
  account_uuid   TEXT,
  org            TEXT,
  fetched_at_ms  INTEGER,

  five_hour_pct        REAL,
  five_hour_resets_at  TEXT,
  seven_day_pct        REAL,
  seven_day_resets_at  TEXT,

  extra_usage_pct           REAL,
  extra_usage_enabled       INTEGER,
  extra_usage_used_credits  REAL,
  extra_usage_monthly_limit REAL,

  spend_used_minor  INTEGER,
  spend_limit_minor INTEGER,
  spend_pct         REAL,
  spend_currency    TEXT,

  -- The codename buckets (seven_day_opus, tangelo, nimbus_quill, ...) are an
  -- open set that the server changes without notice. Columns would rot; JSON
  -- does not. Anything that graduates to load-bearing gets promoted later.
  raw_buckets TEXT,

  PRIMARY KEY (ts_ms, source)
) WITHOUT ROWID;

CREATE INDEX limit_samples_src ON limit_samples (source, ts_ms);

CREATE TABLE limit_scoped (
  ts_ms       INTEGER NOT NULL,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- session | weekly_all | weekly_scoped
  group_name  TEXT NOT NULL,
  scope_model TEXT NOT NULL,   -- '' when scope is null
  percent     REAL,
  severity    TEXT,
  resets_at   TEXT,
  is_active   INTEGER,
  PRIMARY KEY (ts_ms, source, kind, group_name, scope_model)
) WITHOUT ROWID;

CREATE INDEX limit_scoped_kind ON limit_scoped (kind, ts_ms);

CREATE TABLE ingest_state (
  path       TEXT PRIMARY KEY,
  inode      INTEGER,
  size       INTEGER,
  mtime_ms   INTEGER,
  offset     INTEGER NOT NULL DEFAULT 0,
  updated_ms INTEGER
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`,
  /* ---------------------------------------------------------------- v2 -- */ `
-- message_count has never counted messages. It counts rows in 'requests',
-- which are deduped assistant API requests: one user-visible reply can span
-- several of them, streaming snapshots collapse into one, and user turns are
-- not counted at all. On a session with 40 exchanges it reads ~120, which
-- invites exactly the wrong conclusion in a tool whose entire job is to be
-- believed about numbers. Rename rather than keep explaining it.
--
-- RENAME COLUMN rewrites the schema only, so every existing value carries
-- over untouched and nothing has to be recomputed.
ALTER TABLE sessions RENAME COLUMN message_count TO request_count;
`,
  /* ---------------------------------------------------------------- v3 -- */ `
-- Tool attribution joins tool_calls to requests on (session_id, message_id).
-- Neither side could seek that: tool_calls' key is (session_id, tool_use_id)
-- and requests' key leads with message_id, so the join scanned one table in
-- full per row of the other. Measured, 'attribution --by tool' took 5.5s on
-- 8.9K requests against 11.7K tool calls, while every other view ran in under
-- 100ms. Both indexes are needed -- one for each direction the planner may
-- choose -- and neither duplicates an existing key prefix.
CREATE INDEX tool_calls_message ON tool_calls (session_id, message_id);
CREATE INDEX requests_message   ON requests (session_id, message_id);
`,
];

export function openDb(file: string = paths.db): Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 10000");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  const current = (
    db.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.run(MIGRATIONS[i]!);
      db.run(`PRAGMA user_version = ${i + 1}`);
    })();
  }
}

// `limit_samples.source` and `limit_scoped.source` gained a fourth value,
// 'oauth-live', after v1 shipped. No migration: source is a TEXT column, not
// an enum, precisely so a new source costs nothing. The v1 comment inside
// MIGRATIONS[0] still lists only the original three because shipped migrations
// are never edited -- `LimitSource` in src/limits.ts is the current list.

/**
 * `meta` holds state about the *archiver* rather than about usage. It is
 * deliberately not a module-level variable: the guard on network refreshes has
 * to hold across separate `cusage` processes -- a launchd agent and a
 * statusline poll are not the same process and must still share one clock.
 */
export function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string } | null;
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2",
  ).run(key, value);
}
