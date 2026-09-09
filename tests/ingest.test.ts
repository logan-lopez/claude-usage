import { expect, test } from "bun:test";
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync, truncateSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb, SCHEMA_VERSION } from "../src/schema.ts";
import { findTranscripts, ingestTranscripts, mcpServerOf, rollupSessions } from "../src/ingest.ts";
import { baseline, freshDb, FIXTURE_TRANSCRIPTS, totals } from "./helpers.ts";

test("walker descends into subagent transcripts", () => {
  const files = findTranscripts(FIXTURE_TRANSCRIPTS);
  expect(files.length).toBeGreaterThan(0);
  // Sub-agent transcripts live two levels further down, at
  // <project>/<sessionId>/subagents/. A one-level glob misses them entirely,
  // and with them every sub-agent attribution row.
  expect(files.some((f) => f.includes("/subagents/"))).toBe(true);
});

test("deduped totals match the independently computed baseline", () => {
  const db = freshDb();
  const t = totals(db);
  expect(t.requests).toBe(baseline.requests);
  expect(t.input_tokens).toBe(baseline.tokens.input_tokens);
  expect(t.output_tokens).toBe(baseline.tokens.output_tokens);
  expect(t.thinking_tokens).toBe(baseline.tokens.thinking_tokens);
  expect(t.cache_creation_tokens).toBe(baseline.tokens.cache_creation_tokens);
  expect(t.cache_read_tokens).toBe(baseline.tokens.cache_read_tokens);
  expect(t.ephemeral_5m).toBe(baseline.tokens.ephemeral_5m);
  expect(t.ephemeral_1h).toBe(baseline.tokens.ephemeral_1h);
  expect(t.total_tokens).toBe(baseline.tokens.total_tokens);
});

test("dedup actually happens -- raw record count is far higher", () => {
  // The failure this guards against is subtle: first-seen dedup produces a
  // plausible-looking number that is ~2x too small on output tokens, and no
  // dedup at all produces one that is ~2x too big. Both look fine in isolation.
  expect(baseline.rawAssistantRecords).toBeGreaterThan(baseline.requests * 1.5);
  const db = freshDb();
  expect(totals(db).requests).toBeLessThan(baseline.rawAssistantRecords);
});

test("re-ingesting is idempotent even with all resume state discarded", () => {
  const db = freshDb();
  const first = JSON.stringify(totals(db));
  for (let i = 0; i < 3; i++) {
    db.run("DELETE FROM ingest_state");
    ingestTranscripts(db, FIXTURE_TRANSCRIPTS);
    expect(JSON.stringify(totals(db))).toBe(first);
  }
});

test("records with no requestId do not duplicate on re-ingest", () => {
  // This is the specific case WITHOUT ROWID exists for: on an ordinary rowid
  // table these columns would be nullable, NULLs never compare equal, and each
  // of these rows would be re-inserted on every single sync.
  const db = freshDb();
  const count = () =>
    (db.query("SELECT COUNT(*) c FROM requests WHERE request_id = ''").get() as { c: number }).c;
  expect(count()).toBe(baseline.noRequestIdRows);
  expect(count()).toBeGreaterThan(0);
  db.run("DELETE FROM ingest_state");
  ingestTranscripts(db, FIXTURE_TRANSCRIPTS);
  expect(count()).toBe(baseline.noRequestIdRows);
});

test("primary key is enforced -- no key appears twice", () => {
  const db = freshDb();
  const dupes = db
    .query(
      `SELECT COUNT(*) c FROM (
         SELECT message_id, request_id, session_id FROM requests
          GROUP BY message_id, request_id, session_id HAVING COUNT(*) > 1)`,
    )
    .get() as { c: number };
  expect(dupes.c).toBe(0);
});

test("keep-max: a later smaller snapshot never overwrites a larger one", () => {
  const db = openDb(":memory:");
  const dir = mkdtempSync(`${tmpdir()}/cusage-keepmax-`);
  const rec = (out: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "assistant", sessionId: "s1", requestId: "r1",
      timestamp: "2026-09-01T00:00:00.000Z", cwd: "/x/p", isSidechain: false,
      message: { id: "m1", role: "assistant", model: "claude-opus-5", usage: { input_tokens: 0, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...extra } },
    });
  try {
    // Streaming order: big value written first, then overwritten with a small
    // one. "Keep last" gets this wrong; that is the ccusage #888 failure.
    writeFileSync(`${dir}/a.jsonl`, `${rec(5000)}\n${rec(3)}\n${rec(120)}\n`);
    ingestTranscripts(db, dir);
    expect((db.query("SELECT output_tokens o FROM requests").get() as { o: number }).o).toBe(5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a partial trailing record is skipped, then picked up once complete", () => {
  const dir = mkdtempSync(`${tmpdir()}/cusage-partial-`);
  try {
    cpSync(FIXTURE_TRANSCRIPTS, dir, { recursive: true });
    const target = findTranscripts(dir).find((f) => !f.includes("/subagents/"))!;
    const full = readFileSync(target);

    // Cut mid-line, exactly as a live append would look if we stat'd it
    // between two write() calls.
    const cut = full.lastIndexOf(0x0a, full.length - 2);
    truncateSync(target, cut + 1 + Math.floor((full.length - cut - 1) / 2));

    const db = openDb(":memory:");
    const r1 = ingestTranscripts(db, dir);
    expect(r1.partialTail).toBeGreaterThan(0);
    const partialRows = (db.query("SELECT COUNT(*) c FROM requests").get() as { c: number }).c;

    // The offset must sit on a line boundary, not inside the partial object.
    const state = db.query("SELECT offset FROM ingest_state WHERE path = ?").get(target) as { offset: number };
    expect(full[state.offset - 1]).toBe(0x0a);

    writeFileSync(target, full); // the rest of the line arrives
    ingestTranscripts(db, dir);
    const finalRows = (db.query("SELECT COUNT(*) c FROM requests").get() as { c: number }).c;
    expect(finalRows).toBeGreaterThanOrEqual(partialRows);

    // And the result equals a clean ingest of the untruncated corpus.
    const clean = openDb(":memory:");
    ingestTranscripts(clean, dir);
    expect(totals(db)).toEqual(totals(clean));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated or rotated file forces a full re-read", () => {
  const dir = mkdtempSync(`${tmpdir()}/cusage-rotate-`);
  try {
    cpSync(FIXTURE_TRANSCRIPTS, dir, { recursive: true });
    const db = openDb(":memory:");
    ingestTranscripts(db, dir);
    const before = totals(db);

    const target = findTranscripts(dir).find((f) => !f.includes("/subagents/"))!;
    const full = readFileSync(target);
    writeFileSync(target, full.subarray(0, Math.floor(full.length / 3)));
    const r = ingestTranscripts(db, dir);
    expect(r.rewound).toBeGreaterThan(0);

    writeFileSync(target, full);
    ingestTranscripts(db, dir);
    expect(totals(db)).toEqual(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archived rows survive deletion of the transcript -- the whole point", () => {
  const dir = mkdtempSync(`${tmpdir()}/cusage-gc-`);
  try {
    cpSync(FIXTURE_TRANSCRIPTS, dir, { recursive: true });
    const db = openDb(":memory:");
    ingestTranscripts(db, dir);
    const before = totals(db);

    const victim = findTranscripts(dir).find((f) => !f.includes("/subagents/"))!;
    const victimRows = (db.query("SELECT COUNT(*) c FROM requests").get() as { c: number }).c;
    rmSync(victim);

    ingestTranscripts(db, dir);
    expect(totals(db)).toEqual(before);
    expect((db.query("SELECT COUNT(*) c FROM requests").get() as { c: number }).c).toBe(victimRows);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost-state is captured, including the [1m] model variant", () => {
  const db = freshDb();
  const sessions = db
    .query("SELECT COUNT(*) c FROM sessions WHERE total_cost_usd IS NOT NULL")
    .get() as { c: number };
  expect(sessions.c).toBe(baseline.sessionsWithCostState);

  const rows = db.query("SELECT COUNT(*) c FROM cost_state_models").get() as { c: number };
  expect(rows.c).toBe(baseline.costStateModelRows);

  const total = db.query("SELECT SUM(total_cost_usd) s FROM sessions").get() as { s: number };
  expect(total.s).toBeCloseTo(baseline.costStateTotalUSD, 6);

  // cost-state is the only place claude-opus-5[1m] is distinguishable from
  // claude-opus-5; requests.model collapses them.
  const oneM = db
    .query("SELECT COUNT(*) c FROM cost_state_models WHERE model LIKE '%[1m]%'")
    .get() as { c: number };
  expect(oneM.c).toBeGreaterThan(0);
  const collapsed = db
    .query("SELECT COUNT(*) c FROM requests WHERE model LIKE '%[1m]%'")
    .get() as { c: number };
  expect(collapsed.c).toBe(0);
});

test("tool calls are recorded by name, with MCP server attribution", () => {
  const db = freshDb();
  const n = db.query("SELECT COUNT(*) c FROM tool_calls").get() as { c: number };
  expect(n.c).toBe(baseline.toolCalls);
  const mcp = db
    .query("SELECT COUNT(*) c FROM tool_calls WHERE mcp_server IS NOT NULL")
    .get() as { c: number };
  expect(mcp.c).toBeGreaterThan(0);
});

test("mcpServerOf parses the tool-name prefix", () => {
  expect(mcpServerOf("mcp__okf-memory__okf_search")).toBe("okf-memory");
  expect(mcpServerOf("mcp__claude_ai_Linear__get_issue")).toBe("claude_ai_Linear");
  expect(mcpServerOf("Bash")).toBeNull();
  expect(mcpServerOf(null)).toBeNull();
  expect(mcpServerOf("mcp__")).toBeNull();
});

test("request_count agrees with the request rows for every session", () => {
  const db = freshDb();
  const disagree = db
    .query(
      `SELECT COUNT(*) c FROM sessions s
        WHERE s.request_count <>
              (SELECT COUNT(*) FROM requests r WHERE r.session_id = s.session_id)`,
    )
    .get() as { c: number };
  expect(disagree.c).toBe(0);

  // Not vacuously true: the roll-up has to have actually run.
  const populated = db
    .query("SELECT COUNT(*) c FROM sessions WHERE request_count > 0")
    .get() as { c: number };
  expect(populated.c).toBeGreaterThan(0);
  const summed = db.query("SELECT SUM(request_count) s FROM sessions").get() as { s: number };
  expect(summed.s).toBe(baseline.requests);
});

test("the column is named for what it counts, not for messages", () => {
  // request_count counts deduped API requests, which is roughly 3x the number
  // of exchanges a human would say the session had. The old name invited the
  // wrong reading of the one screen this tool exists to be believed about.
  const db = freshDb();
  const cols = (db.query("PRAGMA table_info(sessions)").all() as { name: string }[])
    .map((c) => c.name);
  expect(cols).toContain("request_count");
  expect(cols).not.toContain("message_count");
});

test("a run that reads no new bytes rolls up nothing", () => {
  // The 15-minute limits agent used to pay for a full rewrite of every session
  // row on each fire, to change nothing.
  const db = freshDb();
  const again = ingestTranscripts(db, FIXTURE_TRANSCRIPTS);
  expect(again.filesRead).toBe(0);
  expect(again.sessionsRolledUp).toBe(0);
});

test("an appended record rolls up its own session and no other", () => {
  const dir = mkdtempSync(`${tmpdir()}/cusage-rollup-`);
  try {
    cpSync(FIXTURE_TRANSCRIPTS, dir, { recursive: true });
    const db = openDb(":memory:");
    ingestTranscripts(db, dir);

    const target = findTranscripts(dir).find((f) => !f.includes("/subagents/"))!;
    const first = JSON.parse(readFileSync(target, "utf8").split("\n")[0]!);
    const sessionId: string = first.sessionId;
    const countOf = (id: string) =>
      (db.query("SELECT request_count c FROM sessions WHERE session_id = ?").get(id) as { c: number }).c;
    const before = countOf(sessionId);

    appendFileSync(
      target,
      JSON.stringify({
        type: "assistant", sessionId, requestId: "req_appended",
        timestamp: "2026-09-09T12:00:00.000Z", cwd: first.cwd, isSidechain: false,
        message: {
          id: "msg_appended", role: "assistant", model: "claude-opus-5",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }) + "\n",
    );

    const r = ingestTranscripts(db, dir);
    expect(r.filesRead).toBe(1);
    expect(r.sessionsRolledUp).toBe(1);
    expect(countOf(sessionId)).toBe(before + 1);

    // Every other session is still right, i.e. scoping the roll-up did not
    // quietly leave the rest behind.
    const disagree = db
      .query(
        `SELECT COUNT(*) c FROM sessions s
          WHERE s.request_count <>
                (SELECT COUNT(*) FROM requests r WHERE r.session_id = s.session_id)`,
      )
      .get() as { c: number };
    expect(disagree.c).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scoped roll-up matches a full sweep", () => {
  const db = freshDb();
  const snapshot = () =>
    JSON.stringify(
      db.query("SELECT session_id, request_count FROM sessions ORDER BY session_id").all(),
    );
  const incremental = snapshot();
  db.run("UPDATE sessions SET request_count = 999999");
  rollupSessions(db);
  expect(snapshot()).toBe(incremental);
});

test("a v1 archive migrates to v2 with its counts intact", () => {
  const dir = mkdtempSync(`${tmpdir()}/cusage-migrate-`);
  const file = `${dir}/usage.db`;
  try {
    // Rewind a current archive to exactly the v1 shape, values and all.
    const v1 = openDb(file);
    v1.run("ALTER TABLE sessions RENAME COLUMN request_count TO message_count");
    v1.run("INSERT INTO sessions (session_id, message_count) VALUES ('s1', 7)");
    v1.run("PRAGMA user_version = 1");
    v1.close();

    const db = openDb(file);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version)
      .toBe(SCHEMA_VERSION);
    const cols = (db.query("PRAGMA table_info(sessions)").all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toContain("request_count");
    expect(cols).not.toContain("message_count");
    // A rename, not a drop-and-recompute: the archive is the point.
    expect((db.query("SELECT request_count c FROM sessions WHERE session_id = 's1'").get() as { c: number }).c)
      .toBe(7);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no message content is ever stored", () => {
  const db = freshDb();
  const cols = db.query("PRAGMA table_info(requests)").all() as { name: string }[];
  for (const c of cols) {
    expect(["content", "text", "thinking", "input", "result", "prompt"]).not.toContain(c.name);
  }
  const toolCols = db.query("PRAGMA table_info(tool_calls)").all() as { name: string }[];
  expect(toolCols.map((c) => c.name)).not.toContain("input");
});
