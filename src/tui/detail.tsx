/** Session Detail: identity header over switchable, scrollable sections. */
import { useMemo, useState } from "react";
import { Box } from "ink";
import type { CostRow, SessionDetail, SessionRow, TokenTotals } from "../query.ts";
import { fmtDuration, fmtWhen } from "../time.ts";
import type { TuiDependencies } from "./data.ts";
import {
  Row,
  Viewport,
  line,
  scrollMax,
  wrapLines,
  type Line,
} from "./components.tsx";
import { costLabel, num } from "./text.ts";
import { cycle, movement, useKeys } from "./keys.ts";
import { visibleRows } from "./layout.ts";
import type { ScreenModel } from "./screen.ts";
import { COST_MARKS } from "./help.tsx";
import type { Report } from "./useArchive.ts";

const SECTIONS = ["Summary", "Models", "Attribution", "Tools", "API blocks"] as const;
type Section = (typeof SECTIONS)[number];
const DIMENSIONS = ["Effort", "Agent", "Skill", "MCP server", "Plugin"] as const;
type Dimension = (typeof DIMENSIONS)[number];

type DetailState = {
  /** Kept apart from `session` so a reread can find the session again if it comes back. */
  id: string;
  /** null once the session has disappeared from the archive. */
  session: SessionDetail | null;
  cost: CostRow | undefined;
  section: number;
  dimension: number;
  /** Scroll position per section:dimension, so switching back keeps your place. */
  offsets: Record<string, number>;
};
const at = (s: DetailState) => `${s.section}:${s.dimension}`;

const HELP = [
  "Tab and Shift+Tab change section. ← and → do too, except in Attribution, where they choose effort, agent, skill, MCP server or plugin.",
  "↑↓ or j/k scroll, PageUp and PageDown by a page, Home and End to either end. Esc goes back to where you came from.",
  "Amounts are whole-session totals.",
  ...COST_MARKS,
  "Requests with an unknown context tier, and rates that aren't known, are listed in the Summary.",
  "Tools counts calls. It doesn't assign tokens or cost to tools.",
];

/**
 * Detail's model, pushed rather than tabbed. `open` loads a session and says whether Detail can
 * show it; the shell then pushes the screen, and `back` returns to where it came from.
 */
export function useDetailScreen({
  deps,
  report,
  back,
}: {
  deps: TuiDependencies;
  report: Report;
  back: () => void;
}): ScreenModel & { open: (id: string | undefined) => boolean } {
  const viewer = useDetail(deps, report);
  return {
    title: "Session Detail",
    hints:
      "Tab section · ←→ attribution · ↑↓ scroll · Esc back · r reread · R fetch · ? help · q quit",
    help: HELP,
    reload: viewer.reload,
    overlay: false,
    open: viewer.open,
    render: (frame) => (
      <DetailScreen detail={viewer} width={frame.width} height={frame.height} onBack={back} />
    ),
  };
}

/** Navigation goes through functional updates, so keys delivered in one chunk compose. */
function useDetail(deps: TuiDependencies, report: Report) {
  const [state, setState] = useState<DetailState | null>(null);
  const update = (f: (s: DetailState) => DetailState) => setState((s) => s && f(s));
  return {
    state,
    /** Load a session and reset navigation. Returns whether Detail can open. */
    open(id: string | undefined) {
      if (!id) return false;
      try {
        const session = deps.detail(id);
        if (!session) {
          report.notice("Selected session is no longer available. r rereads.");
          return false;
        }
        setState({
          id,
          session,
          cost: deps.costs([id])[id],
          section: 0,
          dimension: 0,
          offsets: {},
        });
        return true;
      } catch {
        report.error("Session read failed; browsing state retained.");
        return false;
      }
    },
    /** After an archive change: reread the open session, keeping navigation. */
    reload() {
      const id = state?.id;
      if (!id) return;
      try {
        const session = deps.detail(id);
        const cost = session ? deps.costs([id])[id] : undefined;
        update((s) => ({ ...s, session, cost }));
      } catch {
        report.error(
          "Session reread failed; last successful data retained (outdated).",
        );
      }
    },
    /** Tab, Shift+Tab: the next or previous section. */
    section(delta: number) {
      update((s) => ({ ...s, section: cycle(s.section, delta, SECTIONS.length) }));
    },
    /** ←→: the attribution dimension in Attribution; elsewhere there's none, so the section. */
    dimension(delta: number) {
      update((s) =>
        SECTIONS[s.section] === "Attribution"
          ? { ...s, dimension: cycle(s.dimension, delta, DIMENSIONS.length) }
          : { ...s, section: cycle(s.section, delta, SECTIONS.length) },
      );
    },
    /** Scroll the current section by a `movement()`, clamped to `max`. */
    scroll(to: (current: number, max: number) => number, max: number) {
      update((s) => ({ ...s, offsets: { ...s.offsets, [at(s)]: to(s.offsets[at(s)] ?? 0, max) } }));
    },
  };
}
type Detail = ReturnType<typeof useDetail>;

function DetailScreen({
  detail,
  width,
  height,
  onBack,
}: {
  detail: Detail;
  width: number;
  height: number;
  onBack: () => void;
}) {
  const state = detail.state!;
  const { session, cost, section, dimension } = state;
  const name = SECTIONS[section]!;
  // A session that's gone has no totals to show, so it loses that row.
  const viewportHeight = height - (session ? 3 : 2);
  const rows = useMemo(
    () =>
      wrapLines(
        session
          ? SECTION_LINES[name](session, cost, DIMENSIONS[dimension]!)
          : [line("Session no longer available in the archive.")],
        width,
      ),
    [session, cost, name, dimension, width],
  );
  const max = scrollMax(rows, viewportHeight);
  useKeys((input, k) => {
    if (k.escape) return onBack();
    if (k.tab) return detail.section(k.shift ? -1 : 1);
    if (k.leftArrow || k.rightArrow) return detail.dimension(k.leftArrow ? -1 : 1);
    const to = movement(input, k, visibleRows(viewportHeight));
    if (to) detail.scroll(to, max);
  });
  const s = session?.session;
  return (
    <Box flexDirection="column">
      <Row
        text={`Session: ${s ? (s.slug ?? s.session_id) : state.id} / ${s?.project ?? "—"}`}
        width={width}
        tone="accent"
      />
      {s && (
        <Row
          text={`${num(s.requests)} requests · ${num(s.total_tokens)} tokens · ${costLabel(cost)} whole-session`}
          width={width}
        />
      )}
      <Row
        text={
          SECTIONS.map((n, i) => `${i === section ? "▸" : ""}${n}`).join("  ") +
          (name === "Attribution" ? ` · ${DIMENSIONS[dimension]}` : "")
        }
        width={width}
        tone="muted"
      />
      <Viewport
        rows={rows}
        offset={state.offsets[at(state)] ?? 0}
        width={width}
        height={viewportHeight}
      />
    </Box>
  );
}

const tokenLines = (t: TokenTotals, prefix = "") => [
  line(
    `${prefix}${num(t.requests)} requests · ${num(t.total_tokens)} total tokens`,
  ),
  line(
    `  input ${num(t.input_tokens)} · output ${num(t.output_tokens)} · thinking ${num(t.thinking_tokens)} (included in output)`,
  ),
  line(
    `  cache read ${num(t.cache_read_tokens)} · creation ${num(t.cache_creation_tokens)} · 5m ${num(t.ephemeral_5m)} · 1h ${num(t.ephemeral_1h)}`,
  ),
];

const duration = (ms: number | null) => (ms === null ? null : fmtDuration(ms));
const when = (ts: string | null) => (ts === null ? null : fmtWhen(ts));

/** The Summary's identity rows, in plain words and readable units. */
const SUMMARY_FIELDS: [label: string, value: (s: SessionRow) => string | null][] = [
  ["ID", (s) => s.session_id],
  ["Name", (s) => s.slug],
  ["Project", (s) => s.project],
  ["Directory", (s) => s.cwd],
  ["Branch", (s) => s.git_branch],
  ["Entrypoint", (s) => s.entrypoint],
  ["First", (s) => when(s.first_ts)],
  ["Last", (s) => when(s.last_ts)],
  ["Duration", (s) => duration(s.total_duration_ms)],
  ["API time", (s) => duration(s.total_api_duration_ms)],
  ["Tool time", (s) => duration(s.total_tool_duration_ms)],
];

const ATTRIBUTION_ROWS: Record<Dimension, (d: SessionDetail) => SessionDetail["byEffort"]> = {
  Effort: (d) => d.byEffort,
  Agent: (d) => d.byAgent,
  Skill: (d) => d.bySkill,
  "MCP server": (d) => d.byMcpServer,
  Plugin: (d) => d.byPlugin,
};

const SECTION_LINES: Record<
  Section,
  (d: SessionDetail, cost: CostRow | undefined, dimension: Dimension) => Line[]
> = {
  Summary: (d, cost) => [
    ...SUMMARY_FIELDS.map(([label, value]) => line(`${label}: ${value(d.session) ?? "unavailable"}`)),
    ...tokenLines(d.session, "Whole session: "),
    ...tokenLines(d.main, "Main: "),
    ...tokenLines(d.sidechain, "Sub-agent / sidechain: "),
    line(`Cost: ${costLabel(cost)} · ${cost?.source ?? "unavailable"}`),
    line(
      "Measured and estimated subtotals are never combined. ~ estimated; + partial known-rate amount.",
    ),
    ...(cost?.unknown_tier_requests
      ? [
          line(
            `${cost.unknown_tier_requests} requests with unknown context tier; [1m] cannot be inferred. Cache creation uses the supplied 5m rate.`,
            "warning",
          ),
        ]
      : []),
    ...(cost?.reasons.map((r) => line(r, "warning")) ?? []),
  ],
  Models: (d) => {
    if (!d.byModel.length) return [line("No model attribution archived.")];
    const measured = new Map(d.costModels.map((c) => [c.model, c]));
    return [
      ...d.byModel.flatMap((m) => [
        line(
          `${m.key} · measured model cost ${measured.has(m.key) ? `$${measured.get(m.key)!.cost_usd.toFixed(2)}` : "unavailable"}`,
        ),
        ...tokenLines(m),
      ]),
      ...d.costModels
        .filter((c) => !d.byModel.some((m) => m.key === c.model))
        .map((c) =>
          line(
            `${c.model} · measured $${c.cost_usd.toFixed(2)} · input ${num(c.input_tokens)} output ${num(c.output_tokens)} thinking ${num(c.thinking_tokens)} cache read ${num(c.cache_read_input_tokens)} creation ${num(c.cache_creation_input_tokens)}`,
          ),
        ),
    ];
  },
  Attribution: (d, _, dimension) => [
    line(`${dimension} · ←/→ changes attribution dimension`, "muted"),
    line("(none) identifies unattributed requests; every request remains in coverage."),
    ...ATTRIBUTION_ROWS[dimension](d).flatMap((r) => [
      line(`${r.key} · ${r.requests} / ${d.session.requests} requests`),
      ...tokenLines(r),
    ]),
  ],
  Tools: (d) =>
    d.byTool.length
      ? [
          line("Call counts only; no per-tool token consumption is assigned.", "muted"),
          ...d.byTool.map((t) => line(`${t.key} · ${t.calls} calls`)),
        ]
      : [line("No tool calls archived for this session.")],
  "API blocks": (d) =>
    d.blocks.length
      ? [
          line("Session API blocks — NOT server five-hour windows.", "warning"),
          ...d.blocks.flatMap((b) => [
            line(
              `Block ${b.api_block_index ?? "unattributed"} · ${when(b.first_ts) ?? "—"} → ${when(b.last_ts) ?? "—"}`,
            ),
            ...tokenLines(b),
          ]),
        ]
      : [line("No session API blocks archived.")],
};
