/** Overview: five panels, all visible at 110×36+, one at a time down to 80×24. */
import React, { useMemo } from "react";
import { Box } from "ink";
import type { Diagnostics, OverviewData } from "./data.ts";
import {
  BarChart,
  Row,
  Section,
  SessionTable,
  Viewport,
  line,
  scrollMax,
  wrapLines,
  type Line,
} from "./components.tsx";
import { age, isStale, num, spark } from "./text.ts";
import { cycle, movement, useKeys } from "./keys.ts";

export const panels = [
  "Server limits",
  "Archive",
  "Meters",
  "Daily output tokens",
  "Recent sessions",
];
const LIMITS = 0;
const ARCHIVE = 1;
const METERS = 2;
const DAILY = 3;
const RECENT = 4;

export type OverviewNav = {
  panel: number;
  /** Scroll offset per panel. */
  offsets: number[];
  /** Selected recent session by ID, so a reread cannot move the selection. */
  recentId: string | undefined;
};
export const initialOverviewNav: OverviewNav = {
  panel: RECENT,
  offsets: panels.map(() => 0),
  recentId: undefined,
};

/** Full dashboard row budget below the two top panels; they take the rest. */
const FULL = { meters: 9, daily: 7, recent: 8 };
const FULL_MIN_WIDTH = 110;
/** Content height at a 36-row terminal (header, tabs and footer take 6). */
const FULL_MIN_HEIGHT = 30;

export function limitsLines(data: OverviewData, now: number): Line[] {
  const limits = data.limits;
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
          line(`  resets ${r.resetsAt ?? "unknown"}`, "muted"),
        ]
      : [line(`${name} unavailable`, "warning")];
  return [
    ...limits.scoped.flatMap((s) => [
      line(
        `${s.is_active ? "▸ binding" : " "} ${s.kind} ${s.scope_model || "all"} ${s.percent ?? "—"}% · ${s.severity ?? "unknown severity"}`,
        s.is_active ? "accent" : "text",
      ),
      line(
        `  ${s.source} · ${age(s.tsMs, now)}${staleMark(s.tsMs)} · reset ${s.resets_at ?? "unknown"}`,
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
    ...limits.sources.map((s) =>
      line(
        `${s.source}: ${age(s.tsMs, now)}${s.reconcilable ? "" : " · not reconciled"}`,
        "muted",
      ),
    ),
  ];
}

function archiveLines(
  data: OverviewData,
  diagnostics: Diagnostics | null,
  now: number,
): Line[] {
  const a = data.inventory;
  return [
    line(
      `${num(a.requests)} requests · ${num(a.sessions)} sessions · ${num(a.projects)} projects`,
    ),
    line(`${num(a.totals.total_tokens)} tokens · ${num(a.limitSamples)} limit samples`),
    line(`Archive span: ${a.firstTs ?? "empty"} → ${a.lastTs ?? "empty"}`, "muted"),
    line(
      `Latest archived request: ${age(a.lastTs ? Date.parse(a.lastTs) : null, now)}`,
      "muted",
    ),
    line(
      diagnostics
        ? `Diagnostics checked ${age(diagnostics.checkedAt, now)}`
        : "Diagnostics pending…",
      "muted",
    ),
    ...(diagnostics?.checks.map((c) =>
      line(
        `${c.level === "ok" ? "✓" : "!"} ${c.name}: ${c.detail}`,
        c.level === "ok" ? "ok" : "warning",
      ),
    ) ?? []),
  ];
}

/** Compact mode puts each sparkline under its label; the full dashboard fits both on one row. */
function meterLines(data: OverviewData, compact: boolean): Line[] {
  const h = data.history;
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
      compact
        ? `72 hourly peak buckets · ${sources || "no samples"}${h.sources.length > 1 ? " (mixed sources)" : ""}`
        : `${sources || "No samples"}${h.sources.length > 1 ? " · mixed-source history" : ""}`,
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

export function Overview({
  data,
  diagnostics,
  now,
  width,
  height,
  nav,
  setNav,
  mono,
  onOpen,
}: {
  data: OverviewData;
  diagnostics: Diagnostics | null;
  now: number;
  width: number;
  height: number;
  nav: OverviewNav;
  setNav: React.Dispatch<React.SetStateAction<OverviewNav>>;
  mono: boolean;
  onOpen: (id: string | undefined) => void;
}) {
  const full = width >= FULL_MIN_WIDTH && height >= FULL_MIN_HEIGHT;
  const half = Math.floor(width / 2);
  const top = height - FULL.meters - FULL.daily - FULL.recent;
  /** Width and height of each panel, including its title row. */
  const size = (panel: number): [number, number] =>
    !full
      ? [width, height - 1]
      : panel === LIMITS
        ? [half, top]
        : panel === ARCHIVE
          ? [width - half, top]
          : [width, [FULL.meters, FULL.daily, FULL.recent][panel - METERS]!];

  const limits = useMemo(() => limitsLines(data, now), [data, now]);
  const archive = useMemo(
    () => archiveLines(data, diagnostics, now),
    [data, diagnostics, now],
  );
  const meters = useMemo(() => meterLines(data, !full), [data, full]);
  const scrollable: Partial<Record<number, Line[]>> = useMemo(
    () => ({
      [LIMITS]: wrapLines(limits, size(LIMITS)[0]),
      [ARCHIVE]: wrapLines(archive, size(ARCHIVE)[0]),
      [METERS]: wrapLines(meters, size(METERS)[0]),
    }),
    [limits, archive, meters, width, full],
  );
  const recentIndex = Math.max(
    0,
    data.recent.findIndex((r) => r.session_id === nav.recentId),
  );
  const selected = data.recent[recentIndex]?.session_id;
  const pageHeight = height - 5;

  useKeys((input, key) => {
    if (key.tab)
      return setNav((n) => ({
        ...n,
        panel: cycle(n.panel, key.shift ? -1 : 1, panels.length),
      }));
    if (key.return) {
      if (nav.panel === RECENT) onOpen(selected);
      return;
    }
    const to = movement(input, key, pageHeight);
    if (!to) return;
    if (nav.panel === RECENT)
      return setNav((n) => {
        const at = Math.max(
          0,
          data.recent.findIndex((r) => r.session_id === n.recentId),
        );
        return {
          ...n,
          recentId: data.recent[to(at, data.recent.length - 1)]?.session_id,
        };
      });
    const rows = scrollable[nav.panel];
    if (!rows) return;
    const max = scrollMax(rows, size(nav.panel)[1] - 1);
    setNav((n) => ({
      ...n,
      offsets: n.offsets.map((o, i) => (i === n.panel ? to(o, max) : o)),
    }));
  });

  const panel = (index: number) => {
    const [w, h] = size(index);
    const rows = scrollable[index];
    return (
      <Section
        key={index}
        title={index === METERS && full ? "Meters · trailing 72 hours" : panels[index]!}
        width={w}
        height={h}
        focused={index === nav.panel}
        mono={mono}
      >
        {rows ? (
          <Viewport
            rows={rows}
            offset={nav.offsets[index]!}
            width={w}
            height={h - 1}
            mono={mono}
          />
        ) : index === DAILY ? (
          <>
            <Row
              text="Archived local usage · 30 UTC calendar days · today partial"
              width={w}
              mono={mono}
              tone="muted"
            />
            <BarChart
              values={data.daily.map((d) => d.output_tokens)}
              width={w}
              height={Math.max(1, Math.min(5, h - 4))}
              mono={mono}
            />
            <Row
              text={`${new Date(data.daily[0]!.tsMs).toISOString().slice(0, 10)} → today (partial): ${num(data.daily.at(-1)!.output_tokens)} output tokens`}
              width={w}
              mono={mono}
              tone="muted"
            />
          </>
        ) : data.recent.length ? (
          <SessionTable
            rows={data.recent}
            costs={data.costs}
            selected={selected}
            width={w}
            height={h - 1}
            now={now}
            mono={mono}
          />
        ) : (
          <Row
            text="Archive is empty. Run cusage sync to archive requests."
            width={w}
            mono={mono}
          />
        )}
      </Section>
    );
  };

  if (!full)
    return (
      <Box flexDirection="column">
        <Row
          text={`Panel ${nav.panel + 1}/${panels.length}: ${panels[nav.panel]} · Tab / Shift+Tab to switch`}
          width={width}
          mono={mono}
          tone="accent"
        />
        {panel(nav.panel)}
      </Box>
    );
  return (
    <Box flexDirection="column">
      <Box>
        {panel(LIMITS)}
        {panel(ARCHIVE)}
      </Box>
      {panel(METERS)}
      {panel(DAILY)}
      {panel(RECENT)}
    </Box>
  );
}
