/** Breakdown: one table of groups for a dimension over a window, each drilling to its sessions. */
import { useRef, useState } from "react";
import { Box } from "ink";
import type { SessionScope } from "../query.ts";
import {
  BREAKDOWN_DIMENSIONS,
  DAY,
  type BreakdownData,
  type BreakdownDimension,
  type BreakdownGroup,
  type TuiDependencies,
} from "./data.ts";
import { Row } from "./components.tsx";
import { cycle, movement, useKeys } from "./keys.ts";
import { tableBodyRows } from "./layout.ts";
import type { ScreenModel } from "./screen.ts";
import { fit, num } from "./text.ts";
import { ARCHIVE_UNREADABLE, type Report } from "./useArchive.ts";

/** `w` cycles these; days run back from now, as Sessions' activity filter does. */
export const WINDOWS = [
  { label: "last 30 days", days: 30 },
  { label: "last 7 days", days: 7 },
  { label: "all time", days: null },
] as const;
export const windowSince = (index: number, now: number) => {
  const days = WINDOWS[index]!.days;
  return days === null ? null : now - days * DAY;
};

const NAMES: Record<BreakdownDimension, string> = {
  project: "project", model: "model", skill: "skill", agent: "agent", mcp: "MCP server",
  plugin: "plugin", tool: "tool", effort: "effort", entrypoint: "entrypoint", branch: "branch",
  version: "Claude Code version",
};
/** `groupSessions` names a NULL key this; a drill matches it as NULL. */
const UNKNOWN = "(unknown)";

/** The dimension and coverage rows above the table, and the note row below it. */
const FIXED_ROWS = 3;
const groupRows = (height: number) => tableBodyRows(height - FIXED_ROWS);

/** Where each dimension was left: the selected group by key, and the scroll. */
type Place = { key?: string; selection: number; scroll: number };
type View = {
  dimension: number;
  window: number;
  /** The `since` the rows were read with, so a drill scopes the same requests. */
  since: number | null;
  data: BreakdownData | null;
  places: Partial<Record<BreakdownDimension, Place>>;
};
const emptyView: View = { dimension: 0, window: 0, since: null, data: null, places: {} };
const dimensionOf = (v: View) => BREAKDOWN_DIMENSIONS[v.dimension]!;
const placeOf = (v: View): Place => v.places[dimensionOf(v)] ?? { selection: 0, scroll: 0 };

const HELP = [
  "←→ or h/l change the dimension. w cycles the window: last 30 days, last 7 days, all time.",
  "↑↓ or j/k choose a group, PageUp and PageDown move a page, Home and End jump to either end. Enter lists its sessions.",
  "Tokens and requests are counted per request, so every request in the window lands in its own group. Share is of the window's total tokens.",
  "Project, model, entrypoint and branch also show sessions and cost. A session's cost counts toward a group only when the whole session sits in that group and inside the window; it's never split or repeated.",
  "A trailing + on a cost means some of the group's sessions were left out of it: they span more than one group, reach outside the window, or have no cost record of their own. Costs are Claude Code's own records, never estimates.",
  "The other dimensions carry no cost: a skill or tool has no cost record, and splitting a session's cost by tokens would be a guess.",
  "Tool rows overlap. A request that used several tools counts under each, so they add up past the total, and their tokens are the context those calls ran in, not what each tool consumed.",
  "Enter lists the sessions with at least one request in the group and window, with whole-session totals.",
];

export function useBreakdownScreen({
  deps,
  report,
  height,
  drill,
}: {
  deps: TuiDependencies;
  report: Report;
  height: number;
  drill: (scope: SessionScope, label: string) => void;
}): ScreenModel {
  const [view, setView] = useState(emptyView);
  // What was last committed, so keys in one chunk and reloads from timers compose.
  const latest = useRef(emptyView);
  // Reads since the last reload, by dimension and window: a ←→ round trip doesn't requery.
  const cache = useRef(new Map<string, { since: number | null; data: BreakdownData }>());

  function commit(next: View) {
    latest.current = next;
    setView(next);
  }
  /** Show `dimension` over `window`, reading it unless it's cached; the selection follows its key. */
  function show(dimension: number, window: number) {
    const by = BREAKDOWN_DIMENSIONS[dimension]!;
    const id = `${by}|${window}`;
    let read = cache.current.get(id);
    if (!read) {
      const since = windowSince(window, deps.now());
      read = { since, data: deps.breakdown(by, { since }) };
      cache.current.set(id, read);
      report.ok();
    }
    const before = latest.current.places[by];
    const found = before?.key === undefined ? -1 : read.data.rows.findIndex((r) => r.key === before.key);
    const last = Math.max(0, read.data.rows.length - 1);
    const selection = found >= 0 ? found : Math.min(before?.selection ?? 0, last);
    commit({
      dimension,
      window,
      since: read.since,
      data: read.data,
      places: {
        ...latest.current.places,
        [by]: { key: read.data.rows[selection]?.key, selection, scroll: before?.scroll ?? 0 },
      },
    });
  }
  function attempt(message: string, action: () => void) {
    try {
      action();
    } catch {
      report.error(message);
    }
  }
  const page = groupRows(height);
  const move = (to: (selection: number, last: number) => number) => {
    const v = latest.current;
    const rows = v.data?.rows ?? [];
    const place = placeOf(v);
    const selection = to(place.selection, Math.max(0, rows.length - 1));
    commit({
      ...v,
      places: { ...v.places, [dimensionOf(v)]: { key: rows[selection]?.key, selection, scroll: scrolled(place.scroll, selection, page) } },
    });
  };

  return {
    title: "Breakdown",
    context: NAMES[dimensionOf(view)],
    hints: "↑↓ group · ←→ dimension · w window · Enter sessions · r reread · ? help · q quit",
    help: HELP,
    overlay: false,
    /** After an archive change: the same dimension and window, reread, selection kept by key. */
    reload: () =>
      attempt(ARCHIVE_UNREADABLE, () => {
        cache.current.clear();
        show(latest.current.dimension, latest.current.window);
      }),
    render: (frame) => (
      <BreakdownScreen
        view={view}
        width={frame.width}
        height={frame.height}
        onKeys={(input, key) => {
          const v = latest.current;
          // h/l that queued behind a slow frame arrive as one string ("lll"); count them.
          const step = key.leftArrow ? -1 : key.rightArrow ? 1
            : /^(?:h+|l+)$/.test(input) ? (input[0] === "h" ? -input.length : input.length) : 0;
          if (step)
            return attempt("Archive read failed; last breakdown retained.", () =>
              show(cycle(v.dimension, step % BREAKDOWN_DIMENSIONS.length, BREAKDOWN_DIMENSIONS.length), v.window),
            );
          if (/^w+$/.test(input))
            return attempt("Archive read failed; last breakdown retained.", () =>
              show(v.dimension, cycle(v.window, input.length % WINDOWS.length, WINDOWS.length)),
            );
          if (key.return) {
            const by = dimensionOf(v);
            const group = v.data?.rows[placeOf(v).selection];
            if (!group) return;
            const unknown = v.data!.priced && group.key === UNKNOWN;
            return drill(
              { since: v.since, by, key: unknown ? null : group.key },
              `${NAMES[by]} ${group.key} · ${WINDOWS[v.window]!.label}`,
            );
          }
          const to = movement(input, key, page);
          if (to) move(to);
        }}
      />
    ),
  };
}

/** The first visible row: unchanged unless the selection left the page. */
const scrolled = (scroll: number, selection: number, page: number) =>
  selection < scroll ? selection : selection >= scroll + page ? selection - page + 1 : scroll;

const percent = (n: number, of: number) => `${of ? ((n / of) * 100).toFixed(1) : "0.0"}%`;
/** Measured dollars, never an estimate; `+` when some sessions' cost was left out. */
const groupCost = (r: BreakdownGroup) => `$${(r.cost_usd ?? 0).toFixed(2)}${r.cost_complete ? "" : "+"}`;

function BreakdownScreen({
  view,
  width,
  height,
  onKeys,
}: {
  view: View;
  width: number;
  height: number;
  onKeys: Parameters<typeof useKeys>[0];
}) {
  useKeys(onKeys);
  const { data } = view;
  const by = dimensionOf(view);
  const window = WINDOWS[view.window]!.label;
  if (!data) return <Row text={`${NAMES[by]} · ${window}`} width={width} />;
  const page = groupRows(height);
  const place = placeOf(view);
  const rows = data.rows;
  const last = Math.max(0, rows.length - 1);
  const selection = Math.min(place.selection, last);
  const scroll = Math.max(0, Math.min(scrolled(place.scroll, selection, page), Math.max(0, rows.length - page)));
  const tool = by === "tool";
  // As wide as the longest key, so the numbers sit beside the names rather than at the far edge.
  const room = width - 2 - 7 * 4 - (data.priced ? 6 + 11 : 0) - (tool ? 7 : 0);
  const nameWidth = Math.max(12, Math.min(room, Math.max(NAMES[by].length, ...rows.map((r) => r.key.length)) + 1));
  const cells = (name: string, requests: string, tokens: string, output: string, share: string, sessions: string, cost: string, calls: string, marker = " ") =>
    `${marker} ${fit(name, nameWidth, true)}${requests.padStart(7)}${tokens.padStart(7)}${output.padStart(7)}${share.padStart(7)}` +
    (data.priced ? `${sessions.padStart(6)}${cost.padStart(11)}` : "") + (tool ? calls.padStart(7) : "");
  const { coverage } = data;
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Row
        text={`${NAMES[by]} · ${window} · ${rows.length} group${rows.length === 1 ? "" : "s"}${rows.length > page ? ` · ${scroll + 1}–${Math.min(rows.length, scroll + page)} visible` : ""}`}
        width={width}
      />
      <Row
        text={`attributed ${coverage.percent.toFixed(1)}% of ${num(coverage.total)} requests · ${num(data.tokens)} tokens in the window`}
        width={width}
        tone="muted"
      />
      <Box flexDirection="column" height={height - FIXED_ROWS} overflow="hidden">
        {rows.length ? (
          <>
            <Row text={cells(NAMES[by], "Reqs", "Tokens", "Output", "Share", "Sess", "Cost", "Calls")} width={width} tone="muted" />
            {rows.slice(scroll, scroll + page).map((r, i) => {
              const selected = scroll + i === selection;
              return (
                <Row
                  key={r.key}
                  text={cells(
                    r.key,
                    num(r.requests),
                    num(r.total_tokens),
                    num(r.output_tokens),
                    percent(r.total_tokens, data.tokens),
                    num(r.sessions ?? 0),
                    groupCost(r),
                    num(r.calls ?? 0),
                    selected ? "▸" : " ",
                  )}
                  width={width}
                  selected={selected}
                />
              );
            })}
          </>
        ) : (
          <Row
            text={coverage.total ? `No requests with a ${NAMES[by]} in this window. ←→ another dimension, w another window.` : "No requests in this window. w another window."}
            width={width}
          />
        )}
      </Box>
      <Row
        text={
          data.overlapping
            ? (data.note ?? "")
            : data.priced
              ? "Cost: whole sessions only; + some sessions' cost left out (? explains)."
              : `No cost by ${NAMES[by]}: costs are recorded per session.`
        }
        width={width}
        tone="muted"
      />
    </Box>
  );
}
