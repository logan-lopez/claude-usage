/** Session Detail: identity header over switchable, scrollable sections. */
import { useMemo, useState } from "react";
import { Box } from "ink";
import type { CostRow, SessionDetail, TokenTotals } from "../query.ts";
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
import type { Report } from "./useArchive.ts";

export const sections = [
  "Summary",
  "Models",
  "Attribution",
  "Tools",
  "API blocks",
];
export const dimensions = ["Effort", "Agent", "Skill", "MCP server", "Plugin"];
const ATTRIBUTION = sections.indexOf("Attribution");

type DetailState = {
  /** null once the session has disappeared from the archive. */
  session: SessionDetail | null;
  cost: CostRow | undefined;
  section: number;
  dimension: number;
  /** Scroll position per section:dimension, so switching back keeps your place. */
  offsets: Record<string, number>;
};

export function useDetail(deps: TuiDependencies, report: Report) {
  const [state, setState] = useState<DetailState | null>(null);
  return {
    state,
    setState,
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
      const id = state?.session?.session.session_id;
      if (!id) return;
      try {
        const session = deps.detail(id);
        const cost = session ? deps.costs([id])[id] : undefined;
        setState((s) => s && { ...s, session, cost });
      } catch {
        report.error(
          "Session reread failed; last successful data retained (outdated).",
        );
      }
    },
  };
}
export type Detail = ReturnType<typeof useDetail>;

export function DetailScreen({
  detail,
  width,
  height,
  mono,
  onBack,
}: {
  detail: Detail;
  width: number;
  height: number;
  mono: boolean;
  onBack: () => void;
}) {
  const state = detail.state!;
  const { session, cost, section, dimension } = state;
  const key = `${section}:${dimension}`;
  const viewportHeight = height - 3;
  const rows = useMemo(
    () =>
      wrapLines(
        session
          ? detailLines(session, cost, section, dimension)
          : [line("Session no longer available in the archive.")],
        width,
      ),
    [session, cost, section, dimension, width],
  );
  const max = scrollMax(rows, viewportHeight);
  useKeys((input, k) => {
    const update = (f: (s: DetailState) => DetailState) =>
      detail.setState((s) => s && f(s));
    if (k.escape) return onBack();
    if (k.tab)
      return update((s) => ({
        ...s,
        section: cycle(s.section, k.shift ? -1 : 1, sections.length),
      }));
    if (k.leftArrow || k.rightArrow) {
      const d = k.leftArrow ? -1 : 1;
      return update((s) =>
        s.section === ATTRIBUTION
          ? { ...s, dimension: cycle(s.dimension, d, dimensions.length) }
          : { ...s, section: cycle(s.section, d, sections.length) },
      );
    }
    const to = movement(input, k, height - 5);
    if (to)
      update((s) => {
        const at = `${s.section}:${s.dimension}`;
        return { ...s, offsets: { ...s.offsets, [at]: to(s.offsets[at] ?? 0, max) } };
      });
  });
  const s = session?.session;
  return (
    <Box flexDirection="column">
      <Row
        text={`Session: ${s?.slug ?? s?.session_id ?? "unavailable"} / ${s?.project ?? "—"}`}
        width={width}
        mono={mono}
        tone="accent"
      />
      <Row
        text={`${num(s?.requests ?? 0)} requests · ${num(s?.total_tokens ?? 0)} tokens · ${costLabel(cost)} whole-session`}
        width={width}
        mono={mono}
      />
      <Row
        text={
          sections.map((name, i) => `${i === section ? "▸" : ""}${name}`).join("  ") +
          (section === ATTRIBUTION ? ` · ${dimensions[dimension]}` : "")
        }
        width={width}
        mono={mono}
        tone="muted"
      />
      <Viewport
        rows={rows}
        offset={state.offsets[key] ?? 0}
        width={width}
        height={viewportHeight}
        mono={mono}
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

const SUMMARY_FIELDS = [
  "session_id",
  "slug",
  "project",
  "cwd",
  "git_branch",
  "entrypoint",
  "first_ts",
  "last_ts",
  "total_duration_ms",
  "total_api_duration_ms",
  "total_tool_duration_ms",
] as const;

export function detailLines(
  d: SessionDetail,
  cost: CostRow | undefined,
  section: number,
  dimension: number,
): Line[] {
  const s = d.session;
  if (section === 0)
    return [
      ...SUMMARY_FIELDS.map((key) => line(`${key}: ${s[key] ?? "unavailable"}`)),
      ...tokenLines(s, "Whole session: "),
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
    ];
  if (section === 1) {
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
  }
  if (section === ATTRIBUTION) {
    const rows = [d.byEffort, d.byAgent, d.bySkill, d.byMcpServer, d.byPlugin][
      dimension
    ]!;
    return [
      line(
        `${dimensions[dimension]} · ←/→ changes attribution dimension`,
        "muted",
      ),
      line(
        "(none) identifies unattributed requests; every request remains in coverage.",
      ),
      ...rows.flatMap((r) => [
        line(`${r.key} · ${r.requests} / ${s.requests} requests`),
        ...tokenLines(r),
      ]),
    ];
  }
  if (section === 3)
    return d.byTool.length
      ? [
          line(
            "Call counts only; no per-tool token consumption is assigned.",
            "muted",
          ),
          ...d.byTool.map((t) => line(`${t.key} · ${t.calls} calls`)),
        ]
      : [line("No tool calls archived for this session.")];
  return d.blocks.length
    ? [
        line("Session API blocks — NOT server five-hour windows.", "warning"),
        ...d.blocks.flatMap((b) => [
          line(
            `Block ${b.api_block_index ?? "unattributed"} · ${b.first_ts ?? "—"} → ${b.last_ts ?? "—"}`,
          ),
          ...tokenLines(b),
        ]),
      ]
    : [line("No session API blocks archived.")];
}
