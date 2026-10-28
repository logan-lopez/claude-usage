/** Limits: the current readings and every source, then zoomable meter history and its five-hour cycles. */
import { useRef, useState } from "react";
import { Box } from "ink";
import { chooseBucket, type MeterCycle, type SessionScope } from "../query.ts";
import { fmtDuration, fmtWhenMs } from "../time.ts";
import { DAY, type LimitsData, type TuiDependencies } from "./data.ts";
import { Row, Section, Viewport, line, scrollMax, wrapLines, type Line } from "./components.tsx";
import { cycle, movement, useKeys } from "./keys.ts";
import { contentHeight, tableBodyRows, visibleRows } from "./layout.ts";
import { limitsLines, meterLines } from "./readings.ts";
import type { Frame, ScreenModel } from "./screen.ts";
import { fit, num } from "./text.ts";
import { ARCHIVE_UNREADABLE, type Report } from "./useArchive.ts";

const HOUR = 3_600_000;
/** ←→ cycles these. 72 hours stays hourly, as Overview's Meters does; the others fit the width. */
export const ZOOMS = [
  { label: "72 hours", ms: 72 * HOUR },
  { label: "7 days", ms: 7 * DAY },
  { label: "30 days", ms: 30 * DAY },
] as const;
/** Where a zoom's history starts, and its bucket for a chart `chartWidth` columns wide. */
export function zoomRange(zoom: number, now: number, chartWidth: number) {
  if (zoom === 0) return { since: Math.floor(now / HOUR) * HOUR - 71 * HOUR, bucketMs: HOUR };
  const { ms } = ZOOMS[zoom]!;
  return { since: now - ms, bucketMs: chooseBucket(ms, chartWidth) };
}
/** Wide enough for a sparkline beside its label; narrower terminals put it on its own row. */
const WIDE = 110;
/** The label and peak beside a wide sparkline. */
const chartWidth = (width: number) => (width >= WIDE ? width - 36 : width - 2);
/** Content height at a 36-row terminal: below it, Tab switches between Now and History. */
const STACKED_MIN_HEIGHT = contentHeight(36);
const MIN_CYCLE_ROWS = 5;

export const CAVEAT =
  "Local activity is context, not the cause: the meter also counts claude.ai and the desktop app.";

const HELP = [
  "←→ or h/l change the zoom: 72 hours, 7 days or 30 days. ↑↓ or j/k choose a cycle, PageUp and PageDown move a page, Home and End jump to either end. Enter lists the sessions active during it.",
  "Below 36 rows, Tab switches between Now and History; ↑↓ scrolls Now.",
  "Now is the current reading of each meter, from the freshest source that has it, with its source and age, and every archived source with its own figures. Two current sources more than 2 points apart are shown as a disagreement, never averaged.",
  "History shows the highest reading in each bucket, not the mean. · is a bucket with no sample; gaps are left as gaps, never filled in. Historical peaks aren't current readings.",
  "A cycle starts where one source's five-hour meter drops by at least 5 points and by half between two samples. An OAuth reset time confirms the drop when one matches; otherwise the reset is bracketed by the two samples. A quiet reset at low usage can be missed. Gaps of more than 30 minutes stay gaps, and the first and last cycles are usually partial.",
  "One source defines the cycles: desktop history when it's there, else live OAuth, else cached. Samples from the others are counted as set aside.",
  `${CAVEAT} Reqs and Output are your Claude Code requests inside the cycle.`,
  "Enter lists the sessions with at least one request during the cycle, with whole-session totals.",
];

type View = {
  zoom: number;
  /** What the cycles and history were read with: a drill scopes the same range. */
  data: LimitsData | null;
  /** The selected cycle, newest first, by its start so a reread can't move it. */
  selected?: number;
  selection: number;
  scroll: number;
  /** Below 36 rows: 0 Now, 1 History. */
  panel: number;
  nowOffset: number;
};
const emptyView: View = { zoom: 0, data: null, selection: 0, scroll: 0, panel: 0, nowOffset: 0 };
/** Newest first, as the table lists them. */
const cyclesOf = (v: View): MeterCycle[] => [...(v.data?.cycles.rows ?? [])].reverse();

/** Every row the screen draws, and where they go, for one frame. */
function layout(view: View, frame: Pick<Frame, "width" | "height" | "now" | "data">) {
  const { width, height } = frame;
  const stacked = height >= STACKED_MIN_HEIGHT;
  const wide = width >= WIDE;
  const zoom = ZOOMS[view.zoom]!;
  const now = wrapLines(limitsLines(frame.data.limits, frame.now, { sources: "table" }), width);
  const h = view.data?.history;
  const history = h
    ? wrapLines(meterLines(h, !wide, `${h.sources.map((s) => s.source).join(" + ") || "no samples"}${h.sources.length > 1 ? " · mixed sources" : ""} · ${num(h.totalSamples)} samples`), width)
    : [line(`${zoom.label} · reading…`, "muted")];
  const caveat = wrapLines([line(CAVEAT, "muted")], width);
  // The cycles section: its title, the caveat, the table header, then the body.
  const fixed = 1 + caveat.length + 1;
  const panelRow = stacked ? 0 : 1;
  const historyHeight = history.length + 1;
  const nowHeight = stacked
    ? Math.max(2, Math.min(now.length + 1, height - historyHeight - fixed - MIN_CYCLE_ROWS))
    : height - panelRow;
  const cycleRows = Math.max(1, height - panelRow - historyHeight - fixed - (stacked ? nowHeight : 0));
  return { stacked, wide, now, history, caveat, nowHeight, historyHeight, cycleRows };
}

export function useLimitsScreen({
  deps,
  report,
  height,
  width,
  drill,
}: {
  deps: TuiDependencies;
  report: Report;
  height: number;
  width: number;
  drill: (scope: SessionScope, label: string) => void;
}): ScreenModel {
  const [view, setView] = useState(emptyView);
  // What was last committed, so keys in one chunk and reloads from timers compose.
  const latest = useRef(emptyView);
  // Reads since the last reload, by zoom and bucket: a ←→ round trip doesn't requery.
  const cache = useRef(new Map<string, LimitsData>());

  function commit(next: View) {
    latest.current = next;
    setView(next);
  }
  /** Show `zoom`, reading it unless it's cached; the selection follows its start. */
  function show(zoom: number) {
    const range = zoomRange(zoom, deps.now(), chartWidth(width));
    const id = `${zoom}|${range.bucketMs}`;
    let data = cache.current.get(id);
    if (!data) {
      data = deps.limits(range.since, range.bucketMs);
      cache.current.set(id, data);
      report.ok();
    }
    const before = latest.current;
    const next: View = { ...before, zoom, data };
    const rows = cyclesOf(next);
    const found = before.selected === undefined ? -1 : rows.findIndex((r) => r.startMs === before.selected);
    const selection = found >= 0 ? found : Math.min(before.selection, Math.max(0, rows.length - 1));
    commit({ ...next, selection, selected: rows[selection]?.startMs });
  }
  function attempt(message: string, action: () => void) {
    try {
      action();
    } catch {
      report.error(message);
    }
  }
  const stacked = height >= STACKED_MIN_HEIGHT;

  return {
    title: "Limits",
    context: ZOOMS[view.zoom]!.label,
    hints: stacked
      ? "↑↓ cycle · ←→ zoom · Enter sessions · r reread · R fetch · ? help · q quit"
      : `Tab ${view.panel ? "Now" : "History"} · ↑↓ ${view.panel ? "cycle" : "scroll"} · ←→ zoom${view.panel ? " · Enter sessions" : ""} · R fetch · ? help · q quit`,
    help: HELP,
    overlay: false,
    /** After an archive change: the same zoom, reread, the selected cycle kept by its start. */
    reload: () =>
      attempt(ARCHIVE_UNREADABLE, () => {
        cache.current.clear();
        show(latest.current.zoom);
      }),
    render: (frame) => {
      const shape = layout(view, frame);
      return (
        <LimitsScreen
          view={view}
          frame={frame}
          shape={shape}
          onKeys={(input, key) => {
            const v = latest.current;
            if (key.tab) {
              if (!shape.stacked) commit({ ...v, panel: cycle(v.panel, key.shift ? -1 : 1, 2) });
              return;
            }
            // h/l that queued behind a slow frame arrive as one string ("lll"); count them.
            const step = key.leftArrow ? -1 : key.rightArrow ? 1
              : /^(?:h+|l+)$/.test(input) ? (input[0] === "h" ? -input.length : input.length) : 0;
            if (step)
              return attempt("Archive read failed; last limits retained.", () =>
                show(cycle(v.zoom, step % ZOOMS.length, ZOOMS.length)),
              );
            const onNow = !shape.stacked && v.panel === 0;
            if (key.return) {
              const row = cyclesOf(v)[v.selection];
              if (onNow || row?.kind !== "cycle") return;
              return drill({ since: row.startMs, until: row.endMs }, `five-hour cycle ${fmtWhenMs(row.startMs)} UTC`);
            }
            if (onNow) {
              const to = movement(input, key, visibleRows(shape.nowHeight - 1));
              if (to) commit({ ...v, nowOffset: to(v.nowOffset, scrollMax(shape.now, shape.nowHeight - 1)) });
              return;
            }
            const to = movement(input, key, shape.cycleRows);
            if (!to) return;
            const rows = cyclesOf(v);
            const selection = to(v.selection, Math.max(0, rows.length - 1));
            commit({ ...v, selection, selected: rows[selection]?.startMs, scroll: scrolled(v.scroll, selection, shape.cycleRows) });
          }}
        />
      );
    },
  };
}

/** The first visible row: unchanged unless the selection left the page. */
const scrolled = (scroll: number, selection: number, page: number) =>
  selection < scroll ? selection : selection >= scroll + page ? selection - page + 1 : scroll;

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const resetLabel = (r: MeterCycle) =>
  r.resetConfirmed ? `${hhmm(r.resetAtMs!)} confirmed` : r.resetBetween ? `${hhmm(r.resetBetween[0])}–${hhmm(r.resetBetween[1])}` : "unknown / partial";
const cells = (start: string, length: string, peak: string, toPeak: string, reset: string, requests: string, output: string, marker = " ") =>
  `${marker} ${fit(start, 16, true)} ${length.padStart(7)}${peak.padStart(6)}${toPeak.padStart(9)}  ${fit(reset, 18, true)}${requests.padStart(6)}${output.padStart(8)}`;

function LimitsScreen({
  view,
  frame,
  shape,
  onKeys,
}: {
  view: View;
  frame: Frame;
  shape: ReturnType<typeof layout>;
  onKeys: Parameters<typeof useKeys>[0];
}) {
  useKeys(onKeys);
  const { width, height } = frame;
  const zoom = ZOOMS[view.zoom]!;
  const h = view.data?.history;
  const c = view.data?.cycles;
  const rows = cyclesOf(view);
  const page = shape.cycleRows;
  const selection = Math.min(view.selection, Math.max(0, rows.length - 1));
  const scroll = Math.max(0, Math.min(scrolled(view.scroll, selection, page), Math.max(0, rows.length - page)));
  const bucket = h ? (h.bucketMs % HOUR ? `${h.bucketMs / 60_000}m` : h.bucketMs % DAY ? `${h.bucketMs / HOUR}h` : `${h.bucketMs / DAY}d`) : "";
  const plain = (lines: Line[]) => lines.map((l, i) => <Row key={i} text={l.text} tone={l.tone} width={width} />);

  const now = (
    <Section title="Now" width={width} height={shape.nowHeight} focused={!shape.stacked}>
      {shape.stacked ? (
        plain(shape.now.slice(0, shape.nowHeight - 1))
      ) : (
        <Viewport rows={shape.now} offset={view.nowOffset} width={width} height={shape.nowHeight - 1} />
      )}
    </Section>
  );
  const history = (
    <>
      <Section title={`History · ${zoom.label}${h ? ` · ${bucket} peaks` : ""}`} width={width} height={shape.historyHeight} focused={!shape.stacked}>
        {plain(shape.history)}
      </Section>
      <Section
        title={`Five-hour cycles${c ? ` · ${c.source} · ${num(c.cycles)} cycle${c.cycles === 1 ? "" : "s"} · ${c.setAside.samples ? `${num(c.setAside.samples)} ${c.setAside.sources.join("/")} samples set aside` : "no other sources"}` : ""}`}
        width={width}
        height={height - (shape.stacked ? shape.nowHeight : 1) - shape.historyHeight}
      >
        {plain(shape.caveat)}
        <Row text={cells("Start (UTC)", "Length", "Peak", "To peak", "Reset (UTC)", "Reqs", "Output")} width={width} tone="muted" />
        {rows.length ? (
          rows.slice(scroll, scroll + page).map((r, i) => {
            const selected = scroll + i === selection;
            const marker = selected ? "▸" : " ";
            return r.kind === "gap" ? (
              <Row key={r.startMs} text={`${marker} ${fit(fmtWhenMs(r.startMs), 16, true)} ${fmtDuration(r.endMs - r.startMs).padStart(7)}  · gap, no samples`} width={width} tone={selected ? "text" : "muted"} selected={selected} />
            ) : (
              <Row
                key={r.startMs}
                text={cells(
                  fmtWhenMs(r.startMs),
                  fmtDuration(r.endMs - r.startMs),
                  r.peakPct === null ? "—" : `${r.peakPct}%`,
                  fmtDuration(r.timeToPeakMs),
                  resetLabel(r),
                  num(r.local?.requests ?? 0),
                  num(r.local?.output_tokens ?? 0),
                  marker,
                )}
                width={width}
                selected={selected}
              />
            );
          })
        ) : (
          <Row text={c ? `No five-hour readings in the last ${zoom.label}. ←→ another zoom.` : "Reading…"} width={width} />
        )}
      </Section>
    </>
  );
  if (shape.stacked)
    return (
      <Box flexDirection="column" height={height} overflow="hidden">
        {now}
        {history}
      </Box>
    );
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Row text={`Panel ${view.panel + 1}/2: ${view.panel ? "History" : "Now"} · Tab to switch`} width={width} tone="accent" />
      {view.panel ? history : now}
    </Box>
  );
}
