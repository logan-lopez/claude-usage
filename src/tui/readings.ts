/** Lines for limit readings and meter history, shared by Overview and Limits. No React, no I/O. */
import type { LimitsHistory, LimitsNow } from "../query.ts";
import { fmtWhen } from "../time.ts";
import { line, type Line } from "./components.tsx";
import { age, fit, isStale, spark } from "./text.ts";

/**
 * The scoped limits (binding marked), both meters, current disagreements and the archived sources,
 * every figure with its source and age. `sources: "table"` gives each source's own five-hour and
 * seven-day figures, as `cusage limits` prints them; Overview keeps one line of ages.
 */
export function limitsLines(
  limits: LimitsNow | null,
  now: number,
  { sources = "ages" }: { sources?: "ages" | "table" } = {},
): Line[] {
  if (!limits)
    return [line("Limits unavailable. R fetches; r rereads archive.", "warning")];
  const staleMark = (ts: number) => (isStale(ts, now) ? " · STALE" : "");
  const reading = (name: string, r: typeof limits.fiveHour) =>
    r
      ? [
          line(
            `${name} ${r.percent ?? "—"}% · ${r.source} · ${age(r.tsMs, now)}${staleMark(r.tsMs)}`,
            isStale(r.tsMs, now) ? "warning" : "text",
          ),
          line(`  resets ${r.resetsAt ? fmtWhen(r.resetsAt) : "unknown"}`, "muted"),
        ]
      : [line(`${name} unavailable`, "warning")];
  const pct = (n: number | null) => (n === null ? "—" : `${n}%`);
  const sourceCells = (source: string, when: string, five: string, seven: string, note = "") =>
    `  ${fit(source, 16, true)} ${fit(when, 18, true)}${five.padStart(10)}${seven.padStart(11)}${note}`;
  return [
    ...limits.scoped.flatMap((s) => [
      line(
        `${s.is_active ? "▸ binding" : " "} ${s.kind} ${s.scope_model || "all"} ${s.percent ?? "—"}% · ${s.severity ?? "unknown severity"}`,
        s.is_active ? "accent" : "text",
      ),
      line(
        `  ${s.source} · ${age(s.tsMs, now)}${staleMark(s.tsMs)} · reset ${s.resets_at ? fmtWhen(s.resets_at) : "unknown"}`,
        isStale(s.tsMs, now) ? "warning" : "muted",
      ),
    ]),
    ...reading("five_hour", limits.fiveHour),
    ...reading("seven_day", limits.sevenDay),
    ...limits.disagreements
      .filter((d) => !isStale(d.chosen.tsMs, now) && !isStale(d.other.tsMs, now))
      .map((d) =>
        line(
          `! disagreement ${d.metric}: ${d.chosen.source} ${d.chosen.percent}% vs ${d.other.source} ${d.other.percent}% (${d.deltaPoints} points)`,
          "warning",
        ),
      ),
    ...(sources === "ages"
      ? limits.sources.map((s) =>
          line(
            `${s.source}: ${age(s.tsMs, now)}${s.reconcilable ? "" : " · not reconciled"}`,
            "muted",
          ),
        )
      : [
          line("Archived sources", "muted"),
          line(sourceCells("source", "age", "five_hour", "seven_day"), "muted"),
          ...limits.sources.map((s) =>
            line(
              sourceCells(
                s.source,
                `${age(s.tsMs, now)}${s.reconcilable && isStale(s.tsMs, now) ? " · STALE" : ""}`,
                pct(s.fiveHourPct),
                pct(s.sevenDayPct),
                s.reconcilable ? "" : "  daily, inferred · not reconciled",
              ),
            ),
          ),
        ]),
  ];
}

/**
 * The seven-day, five-hour and scoped sparklines with their peaks. Compact puts each sparkline
 * under its label; otherwise both fit one row. `heading` replaces the sources line at the top.
 */
export function meterLines(h: LimitsHistory, compact: boolean, heading?: string): Line[] {
  const sources = h.sources.map((s) => s.source).join(" + ");
  const series = [
    ["seven_day", "sevenDayPct"],
    ["five_hour", "fiveHourPct"],
    [`${h.scopedModel ?? "no model"} scoped`, "scopedPct"],
  ] as const;
  const peak = (key: (typeof series)[number][1]) =>
    h.peaks[key] === null ? "—" : `${h.peaks[key]}%`;
  return [
    line(
      heading ??
        (compact
          ? `72 hourly peak buckets · ${sources || "no samples"}${h.sources.length > 1 ? " (mixed sources)" : ""}`
          : `${sources || "No samples"}${h.sources.length > 1 ? " · mixed-source history" : ""}`),
      "muted",
    ),
    ...series.flatMap(([label, key]) => {
      const bars = spark(h.buckets.map((b) => b[key]));
      return compact
        ? [line(`${label}  peak ${peak(key)}`), line(bars)]
        : [line(`${label}: ${bars} peak ${peak(key)}`)];
    }),
    line(
      `Scoped sources: ${h.scopedSources.map((s) => s.source).join(" + ") || "none"}`,
      "muted",
    ),
    line("· no sample; gaps never bridged. Historical peaks ≠ current readings.", "muted"),
  ];
}
