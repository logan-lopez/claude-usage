import React from "react";
import { Box } from "ink";
import {
  FRESH_MS,
  type SessionDetail,
  type CostRow,
  type TokenTotals,
} from "../query.ts";
import type { doctor } from "../doctor.ts";
import type { OverviewData } from "./data.ts";
import {
  Row,
  Section,
  Viewport,
  Sparkline,
  BarChart,
  SessionTable,
  age,
  num,
  costLabel,
  type Line,
} from "./components.tsx";

export const panels = [
  "Server limits",
  "Archive",
  "Meters",
  "Daily output tokens",
  "Recent sessions",
];
export const sections = [
  "Summary",
  "Models",
  "Attribution",
  "Tools",
  "API blocks",
];
export const dimensions = ["Effort", "Agent", "Skill", "MCP server", "Plugin"];
const line = (text: string, tone?: Line["tone"]): Line => ({ text, tone });
export function limitsLines(data: OverviewData, now: number): Line[] {
  const limits = data.limits;
  if (!limits)
    return [
      line("Limits unavailable. R fetches; r rereads archive.", "warning"),
    ];
  const reading = (name: string, r: typeof limits.fiveHour) =>
    r
      ? [
          line(
            `${name} ${r.percent ?? "—"}% · ${r.source} · ${age(r.tsMs, now)}${now - r.tsMs > FRESH_MS ? " · STALE" : ""}`,
            now - r.tsMs > FRESH_MS ? "warning" : "text",
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
        `  ${s.source} · ${age(s.tsMs, now)}${now - s.tsMs > FRESH_MS ? " · STALE" : ""} · reset ${s.resets_at ?? "unknown"}`,
        now - s.tsMs > FRESH_MS ? "warning" : "muted",
      ),
    ]),
    ...reading("five_hour", limits.fiveHour),
    ...reading("seven_day", limits.sevenDay),
    ...limits.disagreements
      .filter(
        (d) =>
          now - d.chosen.tsMs <= FRESH_MS && now - d.other.tsMs <= FRESH_MS,
      )
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
export function Overview({
  data,
  diagnostics,
  now,
  width,
  height,
  panel,
  offsets,
  selected,
  mono,
  onRange,
}: {
  data: OverviewData;
  diagnostics: Awaited<ReturnType<typeof doctor>> | null;
  now: number;
  width: number;
  height: number;
  panel: number;
  offsets: number[];
  selected?: string;
  mono: boolean;
  onRange: (panel: number, max: number) => void;
}) {
  const full = width >= 110 && height + 6 >= 36;
  const a = data.inventory;
  const archive: Line[] = [
    line(
      `${num(a.requests)} requests · ${num(a.sessions)} sessions · ${num(a.projects)} projects`,
    ),
    line(
      `${num(a.totals.total_tokens)} tokens · ${num(a.limitSamples)} limit samples`,
    ),
    line(
      `Archive span: ${a.firstTs ?? "empty"} → ${a.lastTs ?? "empty"}`,
      "muted",
    ),
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
  const render = (index: number, w: number, h: number) => (
    <Section
      key={index}
      title={panels[index]!}
      width={w}
      height={h}
      focused={index === panel}
      mono={mono}
    >
      {index === 0 && (
        <Viewport
          lines={limitsLines(data, now)}
          offset={offsets[0]!}
          onRange={(max) => onRange(0, max)}
          width={w}
          height={h - 1}
          mono={mono}
        />
      )}
      {index === 1 && (
        <Viewport
          lines={archive}
          offset={offsets[1]!}
          onRange={(max) => onRange(1, max)}
          width={w}
          height={h - 1}
          mono={mono}
        />
      )}
      {index === 2 && (
        <>
          <Row
            text={`72 hourly peak buckets · ${data.history.sources.map((s) => s.source).join(" + ") || "no samples"}${data.history.sources.length > 1 ? " (mixed sources)" : ""}`}
            width={w}
            mono={mono}
            tone="muted"
          />
          {(["sevenDayPct", "fiveHourPct", "scopedPct"] as const).map(
            (key, i) => (
              <Box key={key} flexDirection="column">
                <Row
                  text={`${["seven_day", "five_hour", `${data.history.scopedModel ?? "no model"} scoped`][i]}  peak ${data.history.peaks[key] === null ? "—" : data.history.peaks[key] + "%"}`}
                  width={w}
                  mono={mono}
                />
                <Sparkline
                  values={data.history.buckets.map((b) => b[key])}
                  width={w}
                  mono={mono}
                />
              </Box>
            ),
          )}
          <Row
            text={`Scoped sources: ${data.history.scopedSources.map((s) => s.source).join(" + ") || "none"} · gaps never bridged; peaks ≠ current.`}
            width={w}
            mono={mono}
            tone="muted"
          />
        </>
      )}
      {index === 3 && (
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
      )}
      {index === 4 &&
        (data.recent.length ? (
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
        ))}
    </Section>
  );
  if (!full)
    return (
      <Box flexDirection="column">
        <Row
          text={`Panel ${panel + 1}/5: ${panels[panel]} · Tab / Shift+Tab to switch`}
          width={width}
          mono={mono}
          tone="accent"
        />
        {render(panel, width, height - 1)}
      </Box>
    );
  // At 120×40 the entire five-panel hierarchy is visible; long sections scroll.
  return (
    <Box flexDirection="column">
      <Box>
        {render(0, Math.floor(width / 2), height - 24)}
        {render(1, width - Math.floor(width / 2), height - 24)}
      </Box>
      <Section
        title="Meters · trailing 72 hours"
        width={width}
        height={9}
        focused={panel === 2}
        mono={mono}
      >
        <Viewport
          lines={[
            line(
              `${data.history.sources.map((s) => s.source).join(" + ") || "No samples"}${data.history.sources.length > 1 ? " · mixed-source history" : ""}`,
              "muted",
            ),
            ...(["sevenDayPct", "fiveHourPct", "scopedPct"] as const).map(
              (key, i) =>
                line(
                  `${["seven_day", "five_hour", `${data.history.scopedModel ?? "none"} scoped`][i]}: ${data.history.buckets.map((b) => (b[key] === null ? "·" : "▁▂▃▄▅▆▇█"[Math.max(0, Math.min(7, Math.floor((b[key]! / 100) * 7)))])).join("")} peak ${data.history.peaks[key] === null ? "—" : data.history.peaks[key] + "%"}`,
                ),
            ),
            line(
              `Scoped sources: ${data.history.scopedSources.map((s) => s.source).join(" + ") || "none"}`,
              "muted",
            ),
            line(
              "· no sample; gaps never bridged. Historical peaks ≠ current readings.",
              "muted",
            ),
          ]}
          offset={offsets[2]!}
          onRange={(max) => onRange(2, max)}
          width={width}
          height={8}
          mono={mono}
        />
      </Section>
      {render(3, width, 7)}
      {render(4, width, 8)}
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
export function detailLines(
  d: SessionDetail,
  cost: CostRow | undefined,
  section: number,
  dimension: number,
): Line[] {
  const s = d.session;
  if (section === 0)
    return [
      ...(
        [
          "session_id",
          "slug",
          "project",
          "cwd",
          "git_branch",
          "entrypoint",
          "first_ts",
          "last_ts",
        ] as const
      ).map((key) => line(`${key}: ${s[key] ?? "unavailable"}`)),
      ...(
        [
          "total_duration_ms",
          "total_api_duration_ms",
          "total_tool_duration_ms",
        ] as const
      ).map((key) => line(`${key}: ${s[key] ?? "unavailable"}`)),
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
  if (section === 1)
    return d.byModel.length
      ? d.byModel
          .flatMap((m) => [
            line(
              `${m.key} · measured model cost ${d.costModels.find((c) => c.model === m.key) ? "$" + d.costModels.find((c) => c.model === m.key)!.cost_usd.toFixed(2) : "unavailable"}`,
            ),
            ...tokenLines(m),
          ])
          .concat(
            d.costModels
              .filter((c) => !d.byModel.some((m) => m.key === c.model))
              .map((c) =>
                line(
                  `${c.model} · measured $${c.cost_usd.toFixed(2)} · input ${num(c.input_tokens)} output ${num(c.output_tokens)} thinking ${num(c.thinking_tokens)} cache read ${num(c.cache_read_input_tokens)} creation ${num(c.cache_creation_input_tokens)}`,
                ),
              ),
          )
      : [line("No model attribution archived.")];
  if (section === 2) {
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
