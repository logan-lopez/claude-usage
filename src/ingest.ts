import type { Database } from "bun:sqlite";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { paths } from "./paths.ts";

export interface IngestResult {
  filesSeen: number;
  filesRead: number;
  bytesRead: number;
  linesParsed: number;
  parseErrors: number;
  assistantRecords: number;
  costStateRecords: number;
  toolCalls: number;
  partialTail: number;
  rewound: number;
}

/** Every *.jsonl under the transcript root, including subagent transcripts,
 *  which live a further two levels down at <project>/<sessionId>/subagents/.
 *  A one-level glob silently misses ~10% of the corpus and all of the
 *  sub-agent attribution -- which is most of what this tool exists to show. */
export function findTranscripts(root: string = paths.transcripts): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  out.sort();
  return out;
}

const NEWLINE = 0x0a;

// The keep-max rule, in one atomic statement. A read-then-decide-then-write
// loop over 574 files degrades to "keep last" the moment it is interrupted,
// and "last" is the wrong answer: Claude Code writes intermediate streaming
// usage snapshots and overwrites them, so the final line of a stream is
// frequently the smallest one.
const UPSERT_REQUEST = `
INSERT INTO requests (
  message_id, request_id, session_id, ts, ts_ms, model, effort, entrypoint,
  session_kind, is_sidechain, agent_id, cwd, project, git_branch,
  api_block_index, cc_version, slug, service_tier, speed, stop_reason,
  attribution_agent, attribution_skill, attribution_plugin,
  attribution_mcp_server, attribution_mcp_tool,
  input_tokens, output_tokens, thinking_tokens, cache_creation_tokens,
  cache_read_tokens, ephemeral_5m, ephemeral_1h,
  web_search_requests, web_fetch_requests
) VALUES (
  $message_id, $request_id, $session_id, $ts, $ts_ms, $model, $effort, $entrypoint,
  $session_kind, $is_sidechain, $agent_id, $cwd, $project, $git_branch,
  $api_block_index, $cc_version, $slug, $service_tier, $speed, $stop_reason,
  $attribution_agent, $attribution_skill, $attribution_plugin,
  $attribution_mcp_server, $attribution_mcp_tool,
  $input_tokens, $output_tokens, $thinking_tokens, $cache_creation_tokens,
  $cache_read_tokens, $ephemeral_5m, $ephemeral_1h,
  $web_search_requests, $web_fetch_requests
)
ON CONFLICT (message_id, request_id, session_id) DO UPDATE SET
  ts = excluded.ts, ts_ms = excluded.ts_ms, model = excluded.model,
  effort = excluded.effort, entrypoint = excluded.entrypoint,
  session_kind = excluded.session_kind, is_sidechain = excluded.is_sidechain,
  agent_id = excluded.agent_id, cwd = excluded.cwd, project = excluded.project,
  git_branch = excluded.git_branch, api_block_index = excluded.api_block_index,
  cc_version = excluded.cc_version, slug = excluded.slug,
  service_tier = excluded.service_tier, speed = excluded.speed,
  stop_reason = excluded.stop_reason,
  attribution_agent = excluded.attribution_agent,
  attribution_skill = excluded.attribution_skill,
  attribution_plugin = excluded.attribution_plugin,
  attribution_mcp_server = excluded.attribution_mcp_server,
  attribution_mcp_tool = excluded.attribution_mcp_tool,
  input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
  thinking_tokens = excluded.thinking_tokens,
  cache_creation_tokens = excluded.cache_creation_tokens,
  cache_read_tokens = excluded.cache_read_tokens,
  ephemeral_5m = excluded.ephemeral_5m, ephemeral_1h = excluded.ephemeral_1h,
  web_search_requests = excluded.web_search_requests,
  web_fetch_requests = excluded.web_fetch_requests
WHERE
  -- keep-max on total tokens ...
  (excluded.input_tokens + excluded.output_tokens
     + excluded.cache_creation_tokens + excluded.cache_read_tokens)
  > (requests.input_tokens + requests.output_tokens
     + requests.cache_creation_tokens + requests.cache_read_tokens)
  -- ... then non-sidechain beats sidechain ...
  OR ((excluded.input_tokens + excluded.output_tokens
        + excluded.cache_creation_tokens + excluded.cache_read_tokens)
      = (requests.input_tokens + requests.output_tokens
        + requests.cache_creation_tokens + requests.cache_read_tokens)
      AND requests.is_sidechain = 1 AND excluded.is_sidechain = 0)
  -- ... then the record that carries usage.speed, which the intermediate
  -- streaming snapshots omit.
  OR ((excluded.input_tokens + excluded.output_tokens
        + excluded.cache_creation_tokens + excluded.cache_read_tokens)
      = (requests.input_tokens + requests.output_tokens
        + requests.cache_creation_tokens + requests.cache_read_tokens)
      AND requests.is_sidechain = excluded.is_sidechain
      AND requests.speed IS NULL AND excluded.speed IS NOT NULL)
`;

const UPSERT_SESSION = `
INSERT INTO sessions (
  session_id, slug, project, cwd, git_branch, entrypoint,
  first_ts, last_ts, first_ts_ms, last_ts_ms
) VALUES ($session_id, $slug, $project, $cwd, $git_branch, $entrypoint,
          $ts, $ts, $ts_ms, $ts_ms)
ON CONFLICT (session_id) DO UPDATE SET
  slug       = COALESCE(excluded.slug,       sessions.slug),
  project    = COALESCE(excluded.project,    sessions.project),
  cwd        = COALESCE(excluded.cwd,        sessions.cwd),
  git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
  entrypoint = COALESCE(excluded.entrypoint, sessions.entrypoint),
  first_ts_ms = CASE WHEN excluded.first_ts_ms IS NOT NULL
                      AND (sessions.first_ts_ms IS NULL
                           OR excluded.first_ts_ms < sessions.first_ts_ms)
                     THEN excluded.first_ts_ms ELSE sessions.first_ts_ms END,
  first_ts    = CASE WHEN excluded.first_ts_ms IS NOT NULL
                      AND (sessions.first_ts_ms IS NULL
                           OR excluded.first_ts_ms < sessions.first_ts_ms)
                     THEN excluded.first_ts ELSE sessions.first_ts END,
  last_ts_ms  = CASE WHEN excluded.last_ts_ms IS NOT NULL
                      AND (sessions.last_ts_ms IS NULL
                           OR excluded.last_ts_ms > sessions.last_ts_ms)
                     THEN excluded.last_ts_ms ELSE sessions.last_ts_ms END,
  last_ts     = CASE WHEN excluded.last_ts_ms IS NOT NULL
                      AND (sessions.last_ts_ms IS NULL
                           OR excluded.last_ts_ms > sessions.last_ts_ms)
                     THEN excluded.last_ts ELSE sessions.last_ts END
`;

// cost-state records are cumulative and rewritten as a session progresses, so
// several exist per session. Keep the highest cost -- the latest snapshot of a
// monotonically growing total.
const UPSERT_COST_STATE = `
INSERT INTO sessions (
  session_id, total_cost_usd, total_api_duration_ms,
  total_api_duration_no_retry_ms, total_tool_duration_ms, total_lines_added,
  total_lines_removed, total_duration_ms, cost_start_time, has_unknown_model_cost
) VALUES (
  $session_id, $cost, $api_ms, $api_no_retry_ms, $tool_ms, $added, $removed,
  $duration_ms, $start_time, $unknown
)
ON CONFLICT (session_id) DO UPDATE SET
  total_cost_usd = excluded.total_cost_usd,
  total_api_duration_ms = excluded.total_api_duration_ms,
  total_api_duration_no_retry_ms = excluded.total_api_duration_no_retry_ms,
  total_tool_duration_ms = excluded.total_tool_duration_ms,
  total_lines_added = excluded.total_lines_added,
  total_lines_removed = excluded.total_lines_removed,
  total_duration_ms = excluded.total_duration_ms,
  cost_start_time = excluded.cost_start_time,
  has_unknown_model_cost = excluded.has_unknown_model_cost
WHERE excluded.total_cost_usd > COALESCE(sessions.total_cost_usd, -1)
`;

const UPSERT_COST_MODEL = `
INSERT INTO cost_state_models (
  session_id, model, input_tokens, output_tokens, thinking_tokens,
  cache_read_input_tokens, cache_creation_input_tokens, web_search_requests, cost_usd
) VALUES ($session_id, $model, $in, $out, $think, $cr, $cc, $web, $cost)
ON CONFLICT (session_id, model) DO UPDATE SET
  input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
  thinking_tokens = excluded.thinking_tokens,
  cache_read_input_tokens = excluded.cache_read_input_tokens,
  cache_creation_input_tokens = excluded.cache_creation_input_tokens,
  web_search_requests = excluded.web_search_requests,
  cost_usd = excluded.cost_usd
WHERE excluded.cost_usd > cost_state_models.cost_usd
`;

const INSERT_TOOL_CALL = `
INSERT OR IGNORE INTO tool_calls
  (session_id, tool_use_id, message_id, ts, ts_ms, tool_name, mcp_server, is_sidechain, agent_id)
VALUES ($session_id, $tool_use_id, $message_id, $ts, $ts_ms, $tool_name, $mcp_server, $is_sidechain, $agent_id)
`;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function toMs(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/** mcp__<server>__<tool> -- server attribution is free from the tool name. */
export function mcpServerOf(toolName: string | null): string | null {
  if (!toolName || !toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice(5);
  const i = rest.indexOf("__");
  return i > 0 ? rest.slice(0, i) : null;
}

export function ingestTranscripts(
  db: Database,
  root: string = paths.transcripts,
): IngestResult {
  const files = findTranscripts(root);
  const res: IngestResult = {
    filesSeen: files.length, filesRead: 0, bytesRead: 0, linesParsed: 0,
    parseErrors: 0, assistantRecords: 0, costStateRecords: 0, toolCalls: 0,
    partialTail: 0, rewound: 0,
  };

  const upsertRequest = db.prepare(UPSERT_REQUEST);
  const upsertSession = db.prepare(UPSERT_SESSION);
  const upsertCostState = db.prepare(UPSERT_COST_STATE);
  const upsertCostModel = db.prepare(UPSERT_COST_MODEL);
  const insertToolCall = db.prepare(INSERT_TOOL_CALL);
  const getState = db.prepare(
    "SELECT inode, size, mtime_ms, offset FROM ingest_state WHERE path = ?",
  );
  const putState = db.prepare(`
    INSERT INTO ingest_state (path, inode, size, mtime_ms, offset, updated_ms)
    VALUES ($path, $inode, $size, $mtime_ms, $offset, $updated_ms)
    ON CONFLICT (path) DO UPDATE SET
      inode = excluded.inode, size = excluded.size, mtime_ms = excluded.mtime_ms,
      offset = excluded.offset, updated_ms = excluded.updated_ms
  `);

  // One transaction per file, not per run. The first ingest is 335 MB cold
  // under launchd; a killed run must resume, not restart.
  const commitFile = db.transaction(
    (lines: string[], meta: { path: string; inode: number; size: number; mtimeMs: number; offset: number }) => {
      for (const line of lines) {
        if (!line) continue;
        res.linesParsed++;
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          res.parseErrors++;
          continue;
        }
        applyRecord(rec);
      }
      putState.run({
        $path: meta.path, $inode: meta.inode, $size: meta.size,
        $mtime_ms: meta.mtimeMs, $offset: meta.offset, $updated_ms: Date.now(),
      });
    },
  );

  function applyRecord(rec: any): void {
    const sessionId = str(rec.sessionId) ?? str(rec.session_id);
    if (!sessionId) return;
    const tsMs = toMs(rec.timestamp);

    if (rec.type === "cost-state") {
      res.costStateRecords++;
      upsertCostState.run({
        $session_id: sessionId,
        $cost: num(rec.totalCostUSD),
        $api_ms: num(rec.totalAPIDuration),
        $api_no_retry_ms: num(rec.totalAPIDurationWithoutRetries),
        $tool_ms: num(rec.totalToolDuration),
        $added: num(rec.totalLinesAdded),
        $removed: num(rec.totalLinesRemoved),
        $duration_ms: num(rec.totalDuration),
        $start_time: str(rec.startTime),
        $unknown: rec.hasUnknownModelCost ? 1 : 0,
      });
      for (const [model, u] of Object.entries<any>(rec.modelUsage ?? {})) {
        upsertCostModel.run({
          $session_id: sessionId, $model: model,
          $in: num(u?.inputTokens), $out: num(u?.outputTokens),
          $think: num(u?.thinkingTokens), $cr: num(u?.cacheReadInputTokens),
          $cc: num(u?.cacheCreationInputTokens), $web: num(u?.webSearchRequests),
          $cost: num(u?.costUSD),
        });
      }
      return;
    }

    const cwd = str(rec.cwd);
    const project = cwd ? basename(cwd) : null;

    // Every record type that carries an envelope contributes to the session's
    // time bounds and metadata, not just assistant turns.
    if (tsMs !== null || cwd) {
      upsertSession.run({
        $session_id: sessionId, $slug: str(rec.slug), $project: project,
        $cwd: cwd, $git_branch: str(rec.gitBranch), $entrypoint: str(rec.entrypoint),
        $ts: str(rec.timestamp), $ts_ms: tsMs,
      });
    }

    if (rec.type !== "assistant") return;
    const msg = rec.message;
    const usage = msg?.usage;
    if (!usage) return;
    res.assistantRecords++;

    const messageId = str(msg.id) ?? "";
    const isSidechain = rec.isSidechain ? 1 : 0;
    const agentId = str(rec.agentId);

    upsertRequest.run({
      $message_id: messageId,
      // '' rather than NULL. See the schema comment; this is the whole reason
      // the table is WITHOUT ROWID.
      $request_id: str(rec.requestId) ?? "",
      $session_id: sessionId,
      $ts: str(rec.timestamp), $ts_ms: tsMs,
      $model: str(msg.model), $effort: str(rec.effort),
      $entrypoint: str(rec.entrypoint), $session_kind: str(rec.sessionKind),
      $is_sidechain: isSidechain, $agent_id: agentId,
      $cwd: cwd, $project: project, $git_branch: str(rec.gitBranch),
      $api_block_index: typeof rec.apiBlockIndex === "number" ? rec.apiBlockIndex : null,
      $cc_version: str(rec.version), $slug: str(rec.slug),
      $service_tier: str(usage.service_tier), $speed: str(usage.speed),
      $stop_reason: str(msg.stop_reason),
      $attribution_agent: str(rec.attributionAgent),
      $attribution_skill: str(rec.attributionSkill),
      $attribution_plugin: str(rec.attributionPlugin),
      $attribution_mcp_server: str(rec.attributionMcpServer),
      $attribution_mcp_tool: str(rec.attributionMcpTool),
      $input_tokens: num(usage.input_tokens),
      $output_tokens: num(usage.output_tokens),
      $thinking_tokens: num(usage.output_tokens_details?.thinking_tokens),
      $cache_creation_tokens: num(usage.cache_creation_input_tokens),
      $cache_read_tokens: num(usage.cache_read_input_tokens),
      $ephemeral_5m: num(usage.cache_creation?.ephemeral_5m_input_tokens),
      $ephemeral_1h: num(usage.cache_creation?.ephemeral_1h_input_tokens),
      $web_search_requests: num(usage.server_tool_use?.web_search_requests),
      $web_fetch_requests: num(usage.server_tool_use?.web_fetch_requests),
    });

    // Tool *names* only. Never the input, never the result.
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type !== "tool_use") continue;
        const toolUseId = str(block.id);
        if (!toolUseId) continue;
        const toolName = str(block.name);
        insertToolCall.run({
          $session_id: sessionId, $tool_use_id: toolUseId,
          $message_id: messageId, $ts: str(rec.timestamp), $ts_ms: tsMs,
          $tool_name: toolName, $mcp_server: mcpServerOf(toolName),
          $is_sidechain: isSidechain, $agent_id: agentId,
        });
        res.toolCalls++;
      }
    }
  }

  const decoder = new TextDecoder();

  for (const path of files) {
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const prev = getState.get(path) as
      | { inode: number; size: number; mtime_ms: number; offset: number }
      | null;

    let offset = prev?.offset ?? 0;
    // Truncation or rotation makes a stored offset meaningless -- it would
    // point into the middle of different bytes. Re-read from zero; the
    // upserts make that harmless.
    if (prev && (st.size < prev.size || st.ino !== prev.inode)) {
      offset = 0;
      res.rewound++;
    }
    if (offset > st.size) offset = 0;
    if (offset === st.size) continue;

    const size = st.size; // snapshot: the file may be appended to while we read
    const bytes = readRange(path, offset, size);

    // Transcripts are appended live, so the tail may be a half-written JSON
    // object. Cut at the last complete newline and leave the remainder for the
    // next run -- persisting an offset inside a partial record loses it.
    const lastNl = bytes.lastIndexOf(NEWLINE);
    if (lastNl < 0) {
      res.partialTail++;
      continue; // nothing complete yet; do not advance the offset
    }
    if (lastNl + 1 < bytes.length) res.partialTail++;

    const text = decoder.decode(bytes.subarray(0, lastNl + 1));
    const newOffset = offset + lastNl + 1;

    commitFile(text.split("\n"), {
      path, inode: st.ino, size, mtimeMs: st.mtimeMs, offset: newOffset,
    });
    res.filesRead++;
    res.bytesRead += lastNl + 1;
  }

  rollupSessions(db);
  return res;
}

/** Read a byte range synchronously. Byte offsets, not character offsets: the
 *  resume point has to survive multi-byte UTF-8, and cutting at an 0x0A byte
 *  is always safe because 0x0A never occurs inside a multi-byte sequence. */
function readRange(path: string, start: number, end: number): Uint8Array {
  const len = end - start;
  if (len <= 0) return new Uint8Array(0);
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, read);
  } finally {
    closeSync(fd);
  }
}

/** message_count is recomputed rather than incremented: incremental ingest
 *  only ever sees new lines, and a counter would double-count a re-read. */
export function rollupSessions(db: Database): void {
  db.run(`
    UPDATE sessions SET message_count = COALESCE((
      SELECT COUNT(*) FROM requests r WHERE r.session_id = sessions.session_id
    ), 0)
  `);
}
