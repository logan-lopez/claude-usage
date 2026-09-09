/**
 * Build the committed test fixture from the live transcript corpus.
 *
 * Two things this must get right, because the output is committed to a public
 * repo and every numeric assertion in the test suite is pinned to it:
 *
 * 1. SCRUBBING IS AN ALLOWLIST. Every field that survives is named here.
 *    Anything not named is dropped -- including whole record types. A denylist
 *    would leak the first time Claude Code adds a field.
 *
 * 2. STRUCTURE IS PRESERVED EXACTLY. Duplicate streaming snapshots, absent
 *    requestIds, sidechains, resumed sessions spanning files: all of that is
 *    what the fixture exists to test, so ids are remapped consistently rather
 *    than randomised, and usage objects are copied verbatim.
 *
 * Regenerate with:  bun run tools/make-fixture.ts
 * The output is deterministic given the same input corpus.
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { findTranscripts } from "../src/ingest.ts";
import { paths } from "../src/paths.ts";

const OUT = `${import.meta.dir}/../fixtures`;
const MAX_FILES = 40;
const MAX_FILE_BYTES = 3_000_000; // skip giant transcripts unless a trait needs them

/* ------------------------------------------------------------------ ids -- */

class IdMap {
  #maps = new Map<string, Map<string, string>>();
  #next = new Map<string, number>();
  constructor(private readonly patterns: Record<string, (n: number) => string>) {}
  map(kind: string, value: unknown): string | undefined {
    if (typeof value !== "string" || value === "") return undefined;
    let m = this.#maps.get(kind);
    if (!m) this.#maps.set(kind, (m = new Map()));
    let hit = m.get(value);
    if (hit === undefined) {
      const n = (this.#next.get(kind) ?? 0) + 1;
      this.#next.set(kind, n);
      hit = this.patterns[kind]!(n);
      m.set(value, hit);
    }
    return hit;
  }
  size(kind: string): number {
    return this.#maps.get(kind)?.size ?? 0;
  }
}

const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
const ids = new IdMap({
  // UUID-shaped so nothing downstream can start depending on a shorter form.
  uuid: (n) => `f1000000-0000-4000-8000-${hex(n, 12)}`,
  session: (n) => `${hex(n, 8)}-5e55-4000-8000-000000000000`,
  message: (n) => `msg_fixture${hex(n, 16)}`,
  request: (n) => `req_fixture${hex(n, 16)}`,
  tooluse: (n) => `toolu_fixture${hex(n, 16)}`,
  agent: (n) => `agent-fixture${hex(n, 12)}`,
  cwd: (n) => `/fixture/projects/proj-${String(n).padStart(2, "0")}`,
  branch: (n) => `branch-${String(n).padStart(2, "0")}`,
  slug: (n) => `slug-${String(n).padStart(4, "0")}`,
  account: (n) => `acc00000-0000-4000-8000-${hex(n, 12)}`,
  org: (n) => `06900000-0000-4000-8000-${hex(n, 12)}`,
});

const REDACTED = "[redacted]";

/* -------------------------------------------------------------- scrub -- */

/** Envelope fields safe to copy verbatim: enumerated technical values only.
 *  Verified against the live corpus -- entrypoint, version, effort, userType,
 *  promptSource, sessionKind and every attribution* value is a tool, model,
 *  skill or agent name, never user text. */
const VERBATIM_ENVELOPE = [
  "type", "timestamp", "isSidechain", "userType", "entrypoint", "version",
  "effort", "sessionKind", "apiBlockIndex", "promptSource", "origin",
  "permissionMode", "isMeta", "subtype", "level", "durationMs", "messageCount",
  "trigger", "direction", "scope", "originalModel", "fallbackModel",
  "stopReason", "toolDenialKind", "isApiErrorMessage", "apiErrorStatus",
  "truncatedAfterOutput", "hookCount", "hasOutput", "preventedContinuation",
  "attributionAgent", "attributionSkill", "attributionPlugin",
  "attributionMcpServer", "attributionMcpTool",
] as const;

/** Only these record types reach the fixture. The rest -- file-history-snapshot
 *  (file bodies), file-history-delta (real paths), attachment (rendered
 *  system-reminders), queue-operation, last-prompt, ai-title -- carry content
 *  and are dropped whole. */
const KEEP_TYPES = new Set(["user", "assistant", "system", "cost-state"]);

function scrubContentBlock(b: any): any {
  if (!b || typeof b !== "object") return { type: "text", text: REDACTED };
  switch (b.type) {
    case "tool_use":
      // The name is the entire point of the tool_calls table. The input is not.
      return { type: "tool_use", id: ids.map("tooluse", b.id) ?? null, name: b.name ?? null, input: {} };
    case "tool_result":
      return { type: "tool_result", tool_use_id: ids.map("tooluse", b.tool_use_id) ?? null, content: REDACTED };
    case "thinking":
      return { type: "thinking", thinking: REDACTED, signature: REDACTED };
    default:
      return { type: b.type ?? "text", text: REDACTED };
  }
}

function scrubRecord(rec: any): any | null {
  if (!rec || typeof rec !== "object" || !KEEP_TYPES.has(rec.type)) return null;

  const out: any = {};
  for (const k of VERBATIM_ENVELOPE) if (rec[k] !== undefined) out[k] = rec[k];

  // Absence is load-bearing: 228 assistant records have no requestId and the
  // primary key design exists for them. Map only when present.
  const put = (key: string, kind: string, v: unknown) => {
    if (v === undefined) return;
    if (v === null) { out[key] = null; return; }
    const m = ids.map(kind, v);
    if (m !== undefined) out[key] = m;
  };
  put("uuid", "uuid", rec.uuid);
  put("parentUuid", "uuid", rec.parentUuid);
  put("sessionId", "session", rec.sessionId);
  put("session_id", "session", rec.session_id);
  put("requestId", "request", rec.requestId);
  put("promptId", "uuid", rec.promptId);
  put("agentId", "agent", rec.agentId);
  put("toolUseID", "tooluse", rec.toolUseID);
  put("sourceToolUseID", "tooluse", rec.sourceToolUseID);
  put("cwd", "cwd", rec.cwd);
  put("gitBranch", "branch", rec.gitBranch);
  put("slug", "slug", rec.slug);

  if (rec.type === "cost-state") {
    // Numbers and model names only -- nothing here is text.
    for (const k of [
      "totalCostUSD", "totalAPIDuration", "totalAPIDurationWithoutRetries",
      "totalToolDuration", "totalLinesAdded", "totalLinesRemoved",
      "totalDuration", "startTime", "hasUnknownModelCost",
    ]) if (rec[k] !== undefined) out[k] = rec[k];
    if (rec.modelUsage) {
      out.modelUsage = {};
      for (const [model, u] of Object.entries<any>(rec.modelUsage)) {
        out.modelUsage[model] = {
          inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0,
          thinkingTokens: u?.thinkingTokens ?? 0,
          cacheReadInputTokens: u?.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: u?.cacheCreationInputTokens ?? 0,
          webSearchRequests: u?.webSearchRequests ?? 0,
          costUSD: u?.costUSD ?? 0,
        };
      }
    }
    return out;
  }

  if (rec.type === "system") {
    // content on a system record is hook output / refusal text. Drop it.
    return out;
  }

  const msg = rec.message;
  if (msg && typeof msg === "object") {
    const m: any = { role: msg.role };
    if (rec.type === "assistant") {
      m.id = ids.map("message", msg.id) ?? null;
      m.type = msg.type;
      m.model = msg.model ?? null;
      m.stop_reason = msg.stop_reason ?? null;
      m.stop_sequence = null;
      // Verbatim. Every token count in every assertion comes from here.
      if (msg.usage) m.usage = msg.usage;
    }
    m.content = Array.isArray(msg.content)
      ? msg.content.map(scrubContentBlock)
      : REDACTED;
    out.message = m;
  }
  return out;
}

/* ----------------------------------------------------------- selection -- */

type Trait =
  | "no_request_id" | "sidechain" | "subagent_file" | "dup_key"
  | "cross_file_session" | "cost_state" | "cost_state_opus_1m"
  | "compact_boundary" | "mcp_tool" | "attr_skill" | "attr_agent"
  | "attr_plugin" | "attr_mcp" | "api_block_index" | "session_kind"
  | "ephemeral_1h" | "api_error" | "multi_model" | "no_effort" | "thinking";

const ALL_TRAITS: Trait[] = [
  "no_request_id", "sidechain", "subagent_file", "dup_key", "cross_file_session",
  "cost_state", "cost_state_opus_1m", "compact_boundary", "mcp_tool",
  "attr_skill", "attr_agent", "attr_plugin", "attr_mcp", "api_block_index",
  "session_kind", "ephemeral_1h", "api_error", "multi_model", "no_effort",
  "thinking",
];

interface Scanned {
  path: string;
  bytes: number;
  traits: Set<Trait>;
  sessions: Set<string>;
  assistants: number;
}

function scanFile(path: string, text: string): Scanned {
  const traits = new Set<Trait>();
  const sessions = new Set<string>();
  const models = new Set<string>();
  const keys = new Map<string, number>();
  let assistants = 0;
  if (path.includes("/subagents/")) traits.add("subagent_file");

  for (const line of text.split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line) } catch { continue }
    if (o.sessionId) sessions.add(o.sessionId);
    if (o.type === "system" && o.subtype === "compact_boundary") traits.add("compact_boundary");
    if (o.type === "cost-state") {
      traits.add("cost_state");
      if (Object.keys(o.modelUsage ?? {}).some((m) => m.includes("[1m]"))) {
        traits.add("cost_state_opus_1m");
      }
      continue;
    }
    if (o.type !== "assistant" || !o.message?.usage) continue;
    assistants++;
    const u = o.message.usage;
    if (!o.requestId) traits.add("no_request_id");
    if (o.isSidechain) traits.add("sidechain");
    if (o.attributionSkill) traits.add("attr_skill");
    if (o.attributionAgent) traits.add("attr_agent");
    if (o.attributionPlugin) traits.add("attr_plugin");
    if (o.attributionMcpServer) traits.add("attr_mcp");
    if (typeof o.apiBlockIndex === "number") traits.add("api_block_index");
    if (o.sessionKind) traits.add("session_kind");
    if (o.isApiErrorMessage) traits.add("api_error");
    if (!o.effort) traits.add("no_effort");
    if (u.cache_creation?.ephemeral_1h_input_tokens) traits.add("ephemeral_1h");
    if (u.output_tokens_details?.thinking_tokens) traits.add("thinking");
    if (o.message.model) models.add(o.message.model);
    for (const b of o.message.content ?? []) {
      if (b?.type === "tool_use" && typeof b.name === "string" && b.name.startsWith("mcp__")) {
        traits.add("mcp_tool");
      }
    }
    const key = `${o.message.id ?? ""}|${o.requestId ?? ""}|${o.sessionId ?? ""}`;
    const tot = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const prev = keys.get(key);
    if (prev !== undefined && prev !== tot) traits.add("dup_key");
    keys.set(key, tot);
  }
  if (models.size > 1) traits.add("multi_model");
  return { path, bytes: Buffer.byteLength(text), traits, sessions, assistants };
}

/* ------------------------------------------------------------------ go -- */

const files = findTranscripts();
process.stderr.write(`scanning ${files.length} transcripts…\n`);

const scanned: Scanned[] = [];
const sessionFileCount = new Map<string, number>();
for (const f of files) {
  const s = scanFile(f, await Bun.file(f).text());
  scanned.push(s);
  for (const sid of s.sessions) sessionFileCount.set(sid, (sessionFileCount.get(sid) ?? 0) + 1);
}
// cross_file_session needs global knowledge, so it is tagged after the scan.
for (const s of scanned) {
  if ([...s.sessions].some((sid) => (sessionFileCount.get(sid) ?? 0) > 1)) {
    s.traits.add("cross_file_session");
  }
}

// Greedy set cover, cheapest-per-new-trait first. Small files win ties, which
// keeps the committed fixture reviewable by hand.
const uncovered = new Set(ALL_TRAITS);
const chosen: Scanned[] = [];
const pool = scanned.filter((s) => s.assistants > 0 || s.traits.has("cost_state"));

while (uncovered.size > 0 && chosen.length < MAX_FILES) {
  let best: Scanned | null = null;
  let bestScore = 0;
  for (const s of pool) {
    if (chosen.includes(s)) continue;
    const gain = [...s.traits].filter((t) => uncovered.has(t)).length;
    if (gain === 0) continue;
    const penalty = s.bytes > MAX_FILE_BYTES ? 1000 : 1;
    const score = gain / (penalty * Math.max(1, Math.log10(s.bytes)));
    if (score > bestScore) { bestScore = score; best = s }
  }
  if (!best) break;
  chosen.push(best);
  for (const t of best.traits) uncovered.delete(t);
}

// A cross-file session is only actually exercised if BOTH of its files are in.
// The set cover picks one; pull in a few siblings explicitly. Capped, because
// one session can own 22 subagent transcripts and swamp the fixture.
const chosenPaths = new Set(chosen.map((c) => c.path));
const MAX_SIBLINGS = 4;
for (const c of [...chosen]) {
  for (const sid of c.sessions) {
    if ((sessionFileCount.get(sid) ?? 0) < 2) continue;
    let taken = 0;
    for (const s of scanned) {
      if (taken >= MAX_SIBLINGS) break;
      if (chosenPaths.has(s.path) || !s.sessions.has(sid)) continue;
      if (s.bytes > MAX_FILE_BYTES) continue;
      chosen.push(s); chosenPaths.add(s.path); taken++;
    }
  }
}

// Top up for breadth. The set cover optimises for rare traits and leaves too
// few distinct sessions and projects to exercise the grouping queries, so add
// small files that each bring a new session, preferring new projects.
const TARGET_SESSIONS = 20;
const seenSessions = new Set(chosen.flatMap((c) => [...c.sessions]));
const seenProjects = new Set(chosen.map((c) => c.path.slice(paths.transcripts.length + 1).split("/")[0]!));
const topUp = pool
  .filter((s) => !chosenPaths.has(s.path) && s.assistants > 0 && s.bytes <= MAX_FILE_BYTES)
  .sort((a, b) => {
    const pa = seenProjects.has(a.path.slice(paths.transcripts.length + 1).split("/")[0]!) ? 1 : 0;
    const pb = seenProjects.has(b.path.slice(paths.transcripts.length + 1).split("/")[0]!) ? 1 : 0;
    return pa - pb || a.bytes - b.bytes;
  });
for (const s of topUp) {
  if (seenSessions.size >= TARGET_SESSIONS) break;
  if ([...s.sessions].every((sid) => seenSessions.has(sid))) continue;
  chosen.push(s); chosenPaths.add(s.path);
  for (const sid of s.sessions) seenSessions.add(sid);
  seenProjects.add(s.path.slice(paths.transcripts.length + 1).split("/")[0]!);
}

chosen.sort((a, b) => a.path.localeCompare(b.path));

if (uncovered.size > 0) {
  process.stderr.write(`WARNING uncovered traits: ${[...uncovered].join(", ")}\n`);
}

rmSync(`${OUT}/projects`, { recursive: true, force: true });

// Fixture paths mirror the live layout (project dir / sessionId / subagents/)
// so the recursive walker is genuinely under test, with every path component
// remapped.
const written: { path: string; bytes: number; lines: number }[] = [];
for (const s of chosen) {
  const rel = s.path.slice(paths.transcripts.length + 1);
  const parts = rel.split("/");
  const outParts = parts.map((p, i) => {
    if (i === parts.length - 1) {
      return p.endsWith(".jsonl") && p.startsWith("agent-")
        ? `${ids.map("agent", p.slice(6, -6))}.jsonl`
        : `${ids.map("session", p.slice(0, -6))}.jsonl`;
    }
    if (p === "subagents") return p;
    if (i === 0) return ids.map("cwd", p)!.split("/").pop()!;
    return ids.map("session", p)!;
  });
  const outPath = `${OUT}/projects/${outParts.join("/")}`;

  const lines: string[] = [];
  for (const line of (await Bun.file(s.path).text()).split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line) } catch { continue }
    const scrubbed = scrubRecord(o);
    if (scrubbed) lines.push(JSON.stringify(scrubbed));
  }
  if (lines.length === 0) continue;
  mkdirSync(dirname(outPath), { recursive: true });
  const body = lines.join("\n") + "\n";
  writeFileSync(outPath, body);
  written.push({ path: outPath.slice(OUT.length + 1), bytes: Buffer.byteLength(body), lines: lines.length });
}

/* --------------------------------------------------- the other sources -- */

const cached = (await Bun.file(paths.claudeJson).json())?.cachedUsageUtilization;
writeFileSync(
  `${OUT}/claude.json`,
  // Exactly one key survives. oauthAccount, userID, machineID,
  // referral_code_details and every project entry are dropped.
  JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: cached.fetchedAtMs,
      accountUuid: ids.map("account", cached.accountUuid),
      utilization: cached.utilization,
    },
  }, null, 2) + "\n",
);

const desktop = await Bun.file(paths.desktopHistory).json();
writeFileSync(
  `${OUT}/plan-usage-history.json`,
  JSON.stringify({
    version: desktop.version,
    samples: desktop.samples.map((s: any) => ({ t: s.t, org: ids.map("org", s.org), u: s.u })),
  }) + "\n",
);

const glaze = await Bun.file(paths.glazeHistory).json();
writeFileSync(`${OUT}/glaze-usage-history.json`, JSON.stringify(glaze) + "\n");

/* ---------------------------------------------------------- baseline -- */

/**
 * The numeric baseline the test suite asserts against, computed HERE by a
 * second, deliberately independent implementation of the dedup rule.
 *
 * Reading the expected numbers out of src/ingest.ts would only prove the
 * ingester agrees with itself. This reducer is thirty lines of plain
 * JavaScript over the committed fixture bytes; if it and the SQL UPSERT ever
 * disagree, one of them is wrong and the test says so.
 */
interface Deduped {
  total: number; out: number; inp: number; cw: number; cr: number;
  think: number; e5m: number; e1h: number;
  isSidechain: boolean; hasSpeed: boolean;
  session: string; model: string | null;
}

const dedup = new Map<string, Deduped>();
let rawAssistants = 0;
const toolUseIds = new Set<string>();
const costSessions = new Map<string, number>();
const costModels = new Map<string, number>();

for (const w of written) {
  for (const line of (await Bun.file(`${OUT}/${w.path}`).text()).split("\n")) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (o.type === "cost-state") {
      const prev = costSessions.get(o.sessionId) ?? -1;
      if ((o.totalCostUSD ?? 0) > prev) costSessions.set(o.sessionId, o.totalCostUSD ?? 0);
      for (const [m, u] of Object.entries<any>(o.modelUsage ?? {})) {
        const k = `${o.sessionId}|${m}`;
        if ((u?.costUSD ?? 0) > (costModels.get(k) ?? -1)) costModels.set(k, u?.costUSD ?? 0);
      }
      continue;
    }
    if (o.type !== "assistant" || !o.message?.usage) continue;
    rawAssistants++;
    const u = o.message.usage;
    const cand: Deduped = {
      inp: u.input_tokens ?? 0, out: u.output_tokens ?? 0,
      cw: u.cache_creation_input_tokens ?? 0, cr: u.cache_read_input_tokens ?? 0,
      think: u.output_tokens_details?.thinking_tokens ?? 0,
      e5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      e1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      total: 0, isSidechain: !!o.isSidechain, hasSpeed: u.speed !== undefined && u.speed !== null,
      session: o.sessionId, model: o.message.model ?? null,
    };
    cand.total = cand.inp + cand.out + cand.cw + cand.cr;
    const key = `${o.message.id ?? ""}|${o.requestId ?? ""}|${o.sessionId ?? ""}`;
    const cur = dedup.get(key);
    const wins =
      !cur ||
      cand.total > cur.total ||
      (cand.total === cur.total && cur.isSidechain && !cand.isSidechain) ||
      (cand.total === cur.total && cur.isSidechain === cand.isSidechain &&
        !cur.hasSpeed && cand.hasSpeed);
    if (wins) dedup.set(key, cand);
    for (const blk of o.message.content ?? []) {
      if (blk?.type === "tool_use" && blk.id) toolUseIds.add(`${o.sessionId}|${blk.id}`);
    }
  }
}

const sum = (f: (d: Deduped) => number) => [...dedup.values()].reduce((a, d) => a + f(d), 0);
const noRequestId = [...dedup.keys()].filter((k) => k.split("|")[1] === "").length;
const perSession: Record<string, { requests: number; output_tokens: number; total_tokens: number }> = {};
for (const d of dedup.values()) {
  const e = (perSession[d.session] ??= { requests: 0, output_tokens: 0, total_tokens: 0 });
  e.requests++; e.output_tokens += d.out; e.total_tokens += d.total;
}

writeFileSync(
  `${OUT}/BASELINE.json`,
  JSON.stringify({
    note: "Computed by tools/make-fixture.ts with an independent dedup implementation. tests/ assert src/ingest.ts reproduces these exactly.",
    rawAssistantRecords: rawAssistants,
    requests: dedup.size,
    dedupRatio: Number((rawAssistants / dedup.size).toFixed(4)),
    noRequestIdRows: noRequestId,
    toolCalls: toolUseIds.size,
    sessions: Object.keys(perSession).length,
    sessionsWithCostState: costSessions.size,
    costStateModelRows: costModels.size,
    costStateTotalUSD: Number([...costSessions.values()].reduce((a, c) => a + c, 0).toFixed(6)),
    tokens: {
      input_tokens: sum((d) => d.inp),
      output_tokens: sum((d) => d.out),
      thinking_tokens: sum((d) => d.think),
      cache_creation_tokens: sum((d) => d.cw),
      cache_read_tokens: sum((d) => d.cr),
      ephemeral_5m: sum((d) => d.e5m),
      ephemeral_1h: sum((d) => d.e1h),
      total_tokens: sum((d) => d.total),
    },
    perSession,
  }, null, 2) + "\n",
);

/* ---------------------------------------------------------- manifest -- */

const sha = async (p: string) =>
  new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(p).arrayBuffer())).digest("hex");

const manifestFiles: Record<string, string> = {};
for (const w of written) manifestFiles[w.path] = await sha(`${OUT}/${w.path}`);
for (const p of ["claude.json", "plan-usage-history.json", "glaze-usage-history.json", "BASELINE.json"]) {
  manifestFiles[p] = await sha(`${OUT}/${p}`);
}

writeFileSync(
  `${OUT}/MANIFEST.json`,
  JSON.stringify({
    generatedBy: "tools/make-fixture.ts",
    note: "Scrubbed copy of a live corpus. Every id, path, branch and slug is remapped; all message content is dropped. Regenerating against a different corpus produces different ids -- the checksums pin THIS copy.",
    transcriptFiles: written.length,
    transcriptLines: written.reduce((a, w) => a + w.lines, 0),
    transcriptBytes: written.reduce((a, w) => a + w.bytes, 0),
    traitsCovered: ALL_TRAITS.filter((t) => !uncovered.has(t)),
    traitsMissing: [...uncovered],
    files: manifestFiles,
  }, null, 2) + "\n",
);

process.stderr.write(
  `\nwrote ${written.length} transcripts, ${written.reduce((a, w) => a + w.lines, 0)} lines, ` +
  `${(written.reduce((a, w) => a + w.bytes, 0) / 1024).toFixed(0)} KB\n` +
  `sessions ${ids.size("session")}, projects ${ids.size("cwd")}, messages ${ids.size("message")}\n` +
  `baseline: ${rawAssistants} raw -> ${dedup.size} deduped (${(rawAssistants / dedup.size).toFixed(2)}x)\n` +
  `traits covered ${ALL_TRAITS.length - uncovered.size}/${ALL_TRAITS.length}\n`,
);
