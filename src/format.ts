/**
 * Rendering only. Rows in, strings out.
 *
 * No I/O, no argument parsing, no database handle. That is what makes every
 * view here unit-testable without spawning a process, and it is why `--json`
 * never comes through this file: JSON is JSON.stringify on a query.ts result,
 * full stop.
 */
import type {
  BreakdownRow, GroupRow, LimitsNow, SessionDetail, SessionRow, TokenTotals,
} from "./query.ts";
import { fmtDuration, fmtWhen } from "./time.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let colour = true;
export function setColour(on: boolean): void {
  colour = on;
}
const b = (s: string) => (colour ? BOLD + s + RESET : s);
const d = (s: string) => (colour ? DIM + s + RESET : s);

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

export function usd(n: number | null | undefined): string {
  return n === null || n === undefined ? "-" : `$${n.toFixed(2)}`;
}

/** Width-aware only for the plain ASCII these views emit. */
const visibleLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** One long key must not blow out every column. Real project names reach 84
 *  characters -- conductor worktrees are named after the issue title. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export interface Column<T> {
  header: string;
  get: (row: T) => string;
  align?: "left" | "right";
}

export function table<T>(rows: T[], cols: Column<T>[], indent = ""): string {
  if (rows.length === 0) return `${indent}${d("(none)")}`;
  const cells = rows.map((r) => cols.map((c) => c.get(r)));
  const widths = cols.map((c, i) =>
    Math.max(visibleLen(c.header), ...cells.map((row) => visibleLen(row[i]!))),
  );
  const pad = (s: string, w: number, align: "left" | "right") => {
    const gap = " ".repeat(Math.max(0, w - visibleLen(s)));
    return align === "right" ? gap + s : s + gap;
  };
  const line = (vals: string[], f = (s: string) => s) =>
    indent +
    vals.map((v, i) => f(pad(v, widths[i]!, cols[i]!.align ?? "left"))).join("  ").trimEnd();
  return [
    line(cols.map((c) => c.header), d),
    ...cells.map((row) => line(row)),
  ].join("\n");
}

const TOKEN_COLS: Column<TokenTotals & { key?: string }>[] = [
  { header: "req", get: (r) => num(r.requests), align: "right" },
  { header: "in", get: (r) => num(r.input_tokens), align: "right" },
  { header: "out", get: (r) => num(r.output_tokens), align: "right" },
  { header: "think", get: (r) => num(r.thinking_tokens), align: "right" },
  { header: "cache w", get: (r) => num(r.cache_creation_tokens), align: "right" },
  { header: "cache r", get: (r) => num(r.cache_read_tokens), align: "right" },
  { header: "total", get: (r) => num(r.total_tokens), align: "right" },
];

function breakdownTable(rows: BreakdownRow[], label: string): string {
  const real = rows.filter((r) => r.key !== "(none)");
  if (real.length === 0) return "";
  const cols: Column<BreakdownRow>[] = [
    { header: label, get: (r) => r.key },
    ...(TOKEN_COLS as Column<BreakdownRow>[]),
  ];
  return `\n${b(label)}\n${table(rows, cols, "  ")}\n`;
}

export function renderSession(detail: SessionDetail): string {
  const s = detail.session;
  const out: string[] = [];

  out.push(b(s.slug ?? s.session_id));
  out.push(
    d(
      [
        s.slug ? s.session_id : null,
        s.project ? `project ${s.project}` : null,
        s.git_branch ? `branch ${s.git_branch}` : null,
        s.entrypoint ? `via ${s.entrypoint}` : null,
      ].filter(Boolean).join("  ·  "),
    ),
  );
  out.push(
    d(`${fmtWhen(s.first_ts)} → ${fmtWhen(s.last_ts)}   wall ${fmtDuration(s.total_duration_ms)}` +
      `   api ${fmtDuration(s.total_api_duration_ms)}   tools ${fmtDuration(s.total_tool_duration_ms)}`),
  );
  out.push("");

  out.push(b("Tokens"));
  out.push(table([{ key: "total", ...s }], [
    { header: "", get: () => "" },
    ...(TOKEN_COLS as Column<any>[]),
  ], "  "));

  if (detail.sidechain.requests > 0) {
    out.push("");
    out.push(b("Main vs sub-agent"));
    out.push(table(
      [
        { key: "main", ...detail.main },
        { key: "sub-agent", ...detail.sidechain },
      ],
      [{ header: "", get: (r: any) => r.key }, ...(TOKEN_COLS as Column<any>[])],
      "  ",
    ));
  }

  for (const [rows, label] of [
    [detail.byModel, "model"], [detail.byEffort, "effort"],
    [detail.byAgent, "agent"], [detail.bySkill, "skill"],
    [detail.byMcpServer, "mcp server"], [detail.byPlugin, "plugin"],
  ] as [BreakdownRow[], string][]) {
    const t = breakdownTable(rows, label);
    if (t) out.push(t.replace(/\n$/, ""));
  }

  if (detail.byTool.length > 0) {
    out.push("");
    out.push(b("tools"));
    out.push(table(detail.byTool, [
      { header: "tool", get: (r) => r.key },
      { header: "calls", get: (r) => String(r.calls), align: "right" },
    ], "  "));
  }

  out.push("");
  out.push(b("Cost"));
  if (detail.costModels.length > 0) {
    out.push(table(detail.costModels, [
      { header: "model", get: (r) => r.model },
      { header: "cost", get: (r) => usd(r.cost_usd), align: "right" },
      { header: "in", get: (r) => num(r.input_tokens), align: "right" },
      { header: "out", get: (r) => num(r.output_tokens), align: "right" },
      { header: "think", get: (r) => num(r.thinking_tokens), align: "right" },
      { header: "cache w", get: (r) => num(r.cache_creation_input_tokens), align: "right" },
      { header: "cache r", get: (r) => num(r.cache_read_input_tokens), align: "right" },
    ], "  "));
    out.push(`  ${b(usd(s.total_cost_usd))} ${d("measured — from this session's cost-state record")}`);
  } else {
    out.push(`  ${d("no cost-state record for this session; pricing is estimated (see `cusage cost`)")}`);
  }

  return out.join("\n") + "\n";
}

export function renderSessions(rows: SessionRow[]): string {
  return table(rows, [
    { header: "when", get: (r) => fmtWhen(r.last_ts) },
    { header: "session", get: (r) => r.session_id.slice(0, 8) },
    { header: "slug", get: (r) => truncate(r.slug ?? "-", 34) },
    { header: "project", get: (r) => truncate(r.project ?? "-", 24) },
    { header: "req", get: (r) => num(r.requests), align: "right" },
    { header: "out", get: (r) => num(r.output_tokens), align: "right" },
    { header: "cache r", get: (r) => num(r.cache_read_tokens), align: "right" },
    { header: "total", get: (r) => num(r.total_tokens), align: "right" },
    { header: "cost", get: (r) => (r.total_cost_usd === null ? d("est") : usd(r.total_cost_usd)), align: "right" },
  ]);
}

export function renderGroups(rows: GroupRow[], label: string): string {
  const body = table(rows, [
    { header: label, get: (r) => truncate(r.key, 40) },
    { header: "sess", get: (r) => String(r.sessions), align: "right" },
    ...(TOKEN_COLS as Column<GroupRow>[]),
    {
      // Marked, never silently short. `+` means the real figure is higher than
      // what is printed, and the note below says why.
      header: "cost",
      get: (r) => (r.cost_complete ? usd(r.cost_usd) : `${usd(r.cost_usd)}${d("+")}`),
      align: "right",
    },
  ]);
  const split = rows.reduce((a, r) => a + r.sessions_split, 0);
  const unpriced = rows.reduce((a, r) => a + r.sessions_unpriced, 0);
  if (split === 0 && unpriced === 0) return body;
  const notes: string[] = [];
  if (unpriced > 0) notes.push(`${unpriced} session(s) predate cost-state and are unpriced`);
  if (split > 0) {
    notes.push(
      `${split} session(s) span more than one ${label}; their cost is excluded ` +
        `rather than counted in each`,
    );
  }
  return `${body}\n\n${d(`  + ${notes.join("; ")}.`)}`;
}

export function renderLimits(l: LimitsNow | null): string {
  if (!l) return "no limit snapshot archived yet — run `cusage sync --limits-only`\n";
  const out: string[] = [];
  out.push(b("Server-reported limits") + d(`  (cached ${fmtWhen(l.fetchedAt)})`));
  out.push(table(l.scoped, [
    { header: "", get: (r) => (r.is_active ? "▸" : " ") },
    { header: "kind", get: (r) => r.kind },
    { header: "scope", get: (r) => r.scope_model || "all" },
    { header: "pct", get: (r) => (r.percent === null ? "-" : `${r.percent}%`), align: "right" },
    { header: "severity", get: (r) => r.severity ?? "-" },
    { header: "resets", get: (r) => fmtWhen(r.resets_at) },
  ], "  "));
  const active = l.scoped.find((r) => r.is_active);
  if (active) {
    out.push("");
    out.push(
      `  ${b("binding constraint")}: ${active.kind}` +
        (active.scope_model ? ` (${active.scope_model})` : "") +
        ` at ${active.percent}%`,
    );
  }
  out.push("");
  out.push(d("  These are server truth. Local transcripts cover Claude Code only;"));
  out.push(d("  claude.ai and Desktop chat usage counts against these and is not on disk."));
  return out.join("\n") + "\n";
}
