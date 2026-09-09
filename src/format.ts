/**
 * Rendering only. Rows in, strings out.
 *
 * No I/O, no argument parsing, no database handle. That is what makes every
 * view here unit-testable without spawning a process, and it is why `--json`
 * never comes through this file: JSON is JSON.stringify on a query.ts result,
 * full stop.
 */
import type { RefreshOutcome } from "./limits.ts";
import type {
  BreakdownRow, GroupRow, LimitBucket, LimitsHistory, LimitsNow, SessionDetail,
  SessionRow, TokenTotals,
} from "./query.ts";
import { fmtAge, fmtDuration, fmtWhen, fmtWhenMs } from "./time.ts";

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

const pct = (n: number | null | undefined): string =>
  n === null || n === undefined ? "-" : `${Math.round(n)}%`;

/**
 * One line about a network attempt, or nothing.
 *
 * Silence is the normal case: a successful or skipped refresh is not news and
 * would be noise on a screen polled every few seconds. Only outcomes the user
 * can act on get a line, and this goes to stderr so `--json` stays clean.
 */
export function renderRefreshNote(r: RefreshOutcome): string | null {
  switch (r.reason) {
    case "no-token":
      return "could not refresh: no usable Claude credentials found. `claude login` and retry.";
    case "failed":
      return `could not refresh: ${r.error ?? "unknown error"}. Showing archived data.`;
    case "guard":
      // Only worth saying when the refresh was asked for explicitly. Under
      // `stale` the guard doing its job is the design working, not an event.
      return r.mode === "force"
        ? `refresh skipped: ${Math.ceil((r.waitMs ?? 0) / 1000)}s left on the request` +
            ` guard. Showing archived data.`
        : null;
    default:
      return null;
  }
}

/**
 * The one screen that has to be trustworthy, so every number on it carries
 * where it came from and how old it is.
 *
 * The rule the previous version broke was not "never present a derived number
 * as fact" — it never did that. It broke the unstated corollary: **never
 * present a stale number as current.** A bold `binding constraint: 53%` with
 * no age, sitting above a disclaimer about local data, is a lie of omission
 * when the real figure is 74%. Hence: provenance on every row, age on every
 * row, and an explicit warning rather than a silent one when the freshest
 * thing we have is old.
 */
export function renderLimits(l: LimitsNow | null): string {
  if (!l) return "no limit data archived yet — run `cusage sync --limits-only`\n";
  const out: string[] = [];

  const scopedAge = fmtAge(l.scopedAgeMs);
  out.push(
    b("Server-reported limits") +
      (l.scopedSource ? d(`  ${l.scopedSource} · ${scopedAge}`) : ""),
  );

  if (l.scoped.length === 0) {
    out.push(`  ${d("no scoped breakdown archived — run `cusage limits --refresh`")}`);
  } else {
    out.push(table(l.scoped, [
      { header: "", get: (r) => (r.is_active ? "▸" : " ") },
      { header: "kind", get: (r) => r.kind },
      { header: "scope", get: (r) => r.scope_model || "all" },
      { header: "pct", get: (r) => pct(r.percent), align: "right" },
      { header: "severity", get: (r) => r.severity ?? "-" },
      { header: "resets", get: (r) => fmtWhen(r.resets_at) },
    ], "  "));
  }

  if (l.binding) {
    out.push("");
    const who =
      `${l.binding.kind}${l.binding.scope_model ? ` (${l.binding.scope_model})` : ""}` +
      ` at ${pct(l.binding.percent)}`;
    if (l.scopedStale) {
      // Deliberately not bold, and never without the age. A stale binding
      // constraint is a lead, not an answer.
      out.push(`  binding constraint: ${who} ${d(`— as of ${scopedAge}`)}`);
      out.push(
        `  ${d("this is the last scoped response on disk and may be out of date;")}`,
      );
      out.push(`  ${d("run `cusage limits --refresh` for the current figure")}`);
    } else {
      out.push(`  ${b("binding constraint")}: ${who} ${d(`· ${scopedAge}`)}`);
    }
  }

  const meters = [
    { label: "five_hour", r: l.fiveHour },
    { label: "seven_day", r: l.sevenDay },
  ].filter((m) => m.r !== null) as { label: string; r: NonNullable<LimitsNow["fiveHour"]> }[];
  if (meters.length > 0) {
    out.push("");
    out.push(table(meters, [
      { header: "meter", get: (m) => m.label },
      { header: "pct", get: (m) => pct(m.r.percent), align: "right" },
      { header: "source", get: (m) => m.r.source },
      { header: "age", get: (m) => fmtAge(m.r.ageMs) },
      { header: "resets", get: (m) => fmtWhen(m.r.resetsAt) },
    ], "  "));
  }

  for (const dis of l.disagreements) {
    out.push("");
    out.push(
      `  ${b("sources disagree")}: ${dis.metric} is ${pct(dis.chosen.percent)} per ` +
        `${dis.chosen.source} (${fmtAge(dis.chosen.ageMs)}) and ${pct(dis.other.percent)} ` +
        `per ${dis.other.source} (${fmtAge(dis.other.ageMs)}).`,
    );
    out.push(`  ${d("the fresher reading is shown above; neither is averaged.")}`);
  }

  if (l.sources.length > 1) {
    out.push("");
    out.push(d("  archived sources"));
    out.push(table(l.sources, [
      { header: "source", get: (s) => s.source },
      { header: "age", get: (s) => fmtAge(s.ageMs) },
      { header: "five_hour", get: (s) => pct(s.fiveHourPct), align: "right" },
      { header: "seven_day", get: (s) => pct(s.sevenDayPct), align: "right" },
      { header: "", get: (s) => (s.reconcilable ? "" : d("daily, inferred — not reconciled")) },
    ], "    "));
  }

  out.push("");
  out.push(d("  These are server truth. Local transcripts cover Claude Code only;"));
  out.push(d("  claude.ai and Desktop chat usage counts against these and is not on disk."));
  return out.join("\n") + "\n";
}

/* ------------------------------------------------------------ sparkline -- */

const SPARK = "▁▂▃▄▅▆▇█";

/**
 * Percent to one of eight blocks. Gaps are a dim dot rather than a low block:
 * "no sample" and "0%" are different facts and must not share a glyph.
 */
export function sparkline(values: (number | null)[]): string {
  return values
    .map((v) => {
      if (v === null) return d("·");
      const i = Math.min(SPARK.length - 1, Math.max(0, Math.round((v / 100) * (SPARK.length - 1))));
      return SPARK[i]!;
    })
    .join("");
}

const series = (h: LimitsHistory, pick: (b: LimitBucket) => number | null) =>
  h.buckets.map(pick);

function seriesLine(
  label: string,
  values: (number | null)[],
  width: number,
): string {
  const present = values.filter((v): v is number => v !== null);
  const last = [...values].reverse().find((v) => v !== null) ?? null;
  const peak = present.length ? Math.max(...present) : null;
  return (
    `  ${label.padEnd(width)}  ${sparkline(values)}  ` +
    `now ${pct(last).padStart(4)}  ${d(`peak ${pct(peak)}`)}` +
    (present.length === 0 ? d("  (no samples)") : "")
  );
}

const fmtBucket = (ms: number): string =>
  ms >= 86_400_000 ? `${ms / 86_400_000}d` : ms >= 3_600_000 ? `${ms / 3_600_000}h` : `${ms / 60_000}m`;

export function renderLimitsHistory(h: LimitsHistory): string {
  const out: string[] = [];
  const scopedLabel = h.scopedModel ? `weekly_scoped (${h.scopedModel})` : "weekly_scoped";
  const labels = ["seven_day (weekly)", "five_hour (session)", scopedLabel];
  const width = Math.max(...labels.map((s) => s.length));

  out.push(
    b("Limit history") +
      d(`  ${fmtWhenMs(h.since)} → ${fmtWhenMs(h.until)}` +
        `  ·  ${h.buckets.length} × ${fmtBucket(h.bucketMs)}` +
        `  ·  ${num(h.totalSamples)} samples`),
  );
  out.push("");
  out.push(seriesLine(labels[0]!, series(h, (x) => x.sevenDayPct), width));
  out.push(seriesLine(labels[1]!, series(h, (x) => x.fiveHourPct), width));
  out.push(seriesLine(labels[2]!, series(h, (x) => x.scopedPct), width));

  if (h.scopedSamples === 0) {
    out.push("");
    out.push(d("  no weekly_scoped samples in this window. That series only exists for"));
    out.push(d("  periods where `cusage` fetched it — the desktop app records fh/sd only."));
  }

  // Daily peaks. The sparkline shows shape; this is where you read numbers off.
  const days = new Map<string, { fh: number | null; sd: number | null; sc: number | null; n: number }>();
  for (const bkt of h.buckets) {
    const day = new Date(bkt.tsMs).toISOString().slice(0, 10);
    const cur = days.get(day) ?? { fh: null, sd: null, sc: null, n: 0 };
    const hi = (a: number | null, b2: number | null) =>
      a === null ? b2 : b2 === null ? a : Math.max(a, b2);
    days.set(day, {
      fh: hi(cur.fh, bkt.fiveHourPct),
      sd: hi(cur.sd, bkt.sevenDayPct),
      sc: hi(cur.sc, bkt.scopedPct),
      n: cur.n + bkt.samples,
    });
  }
  const dayRows = [...days.entries()]
    .filter(([, v]) => v.n > 0)
    .map(([day, v]) => ({ day, ...v }));
  if (dayRows.length > 0) {
    out.push("");
    out.push(d("  daily peaks (UTC)"));
    out.push(table(dayRows, [
      { header: "day", get: (r) => r.day },
      { header: "five_hour", get: (r) => pct(r.fh), align: "right" },
      { header: "seven_day", get: (r) => pct(r.sd), align: "right" },
      { header: h.scopedModel ?? "scoped", get: (r) => pct(r.sc), align: "right" },
      { header: "samples", get: (r) => num(r.n), align: "right" },
    ], "    "));
  }

  if (h.sources.length > 0) {
    out.push("");
    out.push(d(`  sources: ${h.sources.map((s) => `${s.source} ${num(s.samples)}`).join(", ")}`));
  }
  out.push(d("  buckets hold the peak, not the mean; gaps are shown as · and never bridged."));
  return out.join("\n") + "\n";
}
