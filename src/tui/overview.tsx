/** Overview: five panels, all visible at 110×36+, one at a time down to 80×24. */
import React, { useMemo, useRef, useState } from "react";
import { Box } from "ink";
import { DAY, type Diagnostics, type OverviewData } from "./data.ts";
import type { SessionScope } from "../query.ts";
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
import { fmtWhen } from "../time.ts";
import { cycle, movement, useKeys } from "./keys.ts";
import { contentHeight, tableBodyRows, visibleRows } from "./layout.ts";
import { tabKeys, type ScreenModel } from "./screen.ts";
import { COST_MARKS } from "./help.tsx";

const panels = [
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

type OverviewNav = {
  panel: number;
  /** Scroll offset per panel. */
  offsets: number[];
  /** Selected recent session by ID, so a reread cannot move the selection. */
  recentId: string | undefined;
  /** Daily output's chosen UTC day by its start, so a reread at midnight cannot move it. */
  day: number;
};
const initialOverviewNav = (now: number): OverviewNav => ({
  panel: RECENT,
  offsets: panels.map(() => 0),
  recentId: undefined,
  day: Math.floor(now / DAY) * DAY,
});

/** What the panel keys do: Recent sessions opens one, Daily output drills into a day. */
const PANEL_KEYS = [
  "↑↓ scroll · ",
  "↑↓ scroll · ",
  "↑↓ scroll · ",
  "←→ day · Enter sessions · ",
  "↑↓ select · Enter open · ",
];

const isoDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

const HELP = [
  "Tab and Shift+Tab move between the five panels. ↑↓ or j/k scroll the focused one, PageUp and PageDown by a page, Home and End to either end.",
  "In Recent sessions, ↑↓ chooses a session and Enter opens it.",
  "Server limits show each reading's source and age.",
  "Archive runs the same checks as cusage doctor, minus the credential check: browsing never touches your credentials. The checks report what the archive shows, not whether the agents are healthy.",
  "Meters show the highest reading in each hour, not the current one. · is an hour with no reading; gaps are left as gaps, never filled in.",
  "Daily output is output tokens by UTC day, from your local archive. Days with none still show, and today is partial.",
  "In Daily output, ←→ or h/l choose a day (▲ marks it) and Enter lists the sessions active that UTC day.",
  ...COST_MARKS,
];

/** Full dashboard row budget below the two top panels; they take the rest. */
const FULL = { meters: 9, daily: 7, recent: 8 };
const FULL_MIN_WIDTH = 110;
/** Content height at a 36-row terminal. */
const FULL_MIN_HEIGHT = contentHeight(36);

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
          line(`  resets ${r.resetsAt ? fmtWhen(r.resetsAt) : "unknown"}`, "muted"),
        ]
      : [line(`${name} unavailable`, "warning")];
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
    line(`Archive span: ${a.firstTs ? fmtWhen(a.firstTs) : "empty"} → ${a.lastTs ? fmtWhen(a.lastTs) : "empty"}`, "muted"),
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

/** Overview's model. Its navigation lives here so Detail can return to the same selection. */
export function useOverviewScreen({
  open,
  drill,
  now,
}: {
  open: (id: string | undefined) => void;
  drill: (scope: SessionScope, label: string) => void;
  /** The day cursor starts on this UTC day. */
  now: number;
}): ScreenModel {
  const [nav, setNav] = useState(() => initialOverviewNav(now));
  // What was last committed, so keys delivered in one stdin chunk each see the one before.
  const latest = useRef(nav);
  const update = (f: (n: OverviewNav) => OverviewNav) => {
    latest.current = f(latest.current);
    setNav(latest.current);
  };
  return {
    title: "Overview",
    context: panels[nav.panel],
    hints: `${tabKeys} tabs · Tab panel · ${PANEL_KEYS[nav.panel]}r reread · R fetch · ? help · q quit`,
    help: HELP,
    overlay: false,
    render: (frame) => (
      <Overview
        data={frame.data}
        diagnostics={frame.diagnostics}
        now={frame.now}
        width={frame.width}
        height={frame.height}
        nav={nav}
        latest={latest}
        update={update}
        onOpen={open}
        onDrill={drill}
      />
    ),
  };
}

function Overview({
  data,
  diagnostics,
  now,
  width,
  height,
  nav,
  latest,
  update,
  onOpen,
  onDrill,
}: {
  data: OverviewData;
  diagnostics: Diagnostics | null;
  now: number;
  width: number;
  height: number;
  nav: OverviewNav;
  latest: React.RefObject<OverviewNav>;
  update: (f: (n: OverviewNav) => OverviewNav) => void;
  onOpen: (id: string | undefined) => void;
  onDrill: (scope: SessionScope, label: string) => void;
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
  const recentAt = (id: string | undefined) =>
    Math.max(0, data.recent.findIndex((r) => r.session_id === id));
  const selected = data.recent[recentAt(nav.recentId)]?.session_id;
  /** The day cursor's bar; a day that has scrolled out of the 30 clamps to the nearest end. */
  const dayAt = (day: number) => {
    const i = data.daily.findIndex((d) => d.tsMs === day);
    return i >= 0 ? i : day < data.daily[0]!.tsMs ? 0 : data.daily.length - 1;
  };
  /** Each panel pages by what it shows: its viewport, or Recent sessions' table body. */
  const page = (panel: number) =>
    panel === RECENT ? tableBodyRows(size(panel)[1] - 1) : visibleRows(size(panel)[1] - 1);

  // Every branch reads `latest`, not this render's `nav`: a Tab, ↓ or Enter earlier in the same
  // chunk has already moved it.
  useKeys((input, key) => {
    const n = latest.current;
    if (key.tab)
      return update((n) => ({
        ...n,
        panel: cycle(n.panel, key.shift ? -1 : 1, panels.length),
      }));
    if (key.return) {
      if (n.panel === RECENT) onOpen(data.recent[recentAt(n.recentId)]?.session_id);
      if (n.panel === DAILY) {
        const day = data.daily[dayAt(n.day)]!.tsMs;
        onDrill({ since: day, until: day + DAY }, `${isoDay(day)} UTC`);
      }
      return;
    }
    if (n.panel === DAILY) {
      // h/l that queued behind a slow frame arrive as one string ("lll"); count them.
      const step = key.leftArrow ? -1 : key.rightArrow ? 1 : /^(?:h+|l+)$/.test(input) ? (input[0] === "h" ? -input.length : input.length) : 0;
      if (step)
        update((n) => ({
          ...n,
          day: data.daily[Math.max(0, Math.min(data.daily.length - 1, dayAt(n.day) + step))]!.tsMs,
        }));
      return;
    }
    const to = movement(input, key, page(n.panel));
    if (!to) return;
    if (n.panel === RECENT)
      return update((n) => ({
        ...n,
        recentId: data.recent[to(recentAt(n.recentId), data.recent.length - 1)]?.session_id,
      }));
    const rows = scrollable[n.panel];
    if (!rows) return;
    const max = scrollMax(rows, size(n.panel)[1] - 1);
    update((n) => ({
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
      >
        {rows ? (
          <Viewport
            rows={rows}
            offset={nav.offsets[index]!}
            width={w}
            height={h - 1}
          />
        ) : index === DAILY ? (
          <>
            <Row
              text="Archived local usage · 30 UTC calendar days · today partial"
              width={w}
              tone="muted"
            />
            <BarChart
              values={data.daily.map((d) => d.output_tokens)}
              width={w}
              height={Math.max(1, Math.min(5, h - 4))}
              marker={dayAt(nav.day)}
            />
            <Row
              text={`▲ ${isoDay(data.daily[dayAt(nav.day)]!.tsMs)} UTC${dayAt(nav.day) === data.daily.length - 1 ? ", today (partial)" : ""}: ${num(data.daily[dayAt(nav.day)]!.output_tokens)} output tokens`}
              width={w}
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
          />
        ) : (
          <Row
            text="Archive is empty. Run cusage sync to archive requests."
            width={w}
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
