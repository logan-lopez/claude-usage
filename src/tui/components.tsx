import React, { useEffect } from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { CostRow, SessionRow } from "../query.ts";

export const palette = {
  text: "#edede9",
  muted: "#99988f",
  accent: "#d97757",
  warning: "#cfae6e",
  ok: "#94b87a",
};
export type Tone = keyof typeof palette;
export type Line = { text: string; tone?: Tone };
export const clean = (s: unknown) =>
  String(s ?? "—").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function fit(value: unknown, width: number, pad = false) {
  const text = clean(value);
  let out = "";
  let used = 0;
  const truncated = stringWidth(text) > width;
  for (const { segment } of segments.segment(text)) {
    const n = stringWidth(segment);
    if (used + n > width - (truncated ? 1 : 0)) break;
    out += segment;
    used += n;
  }
  if (truncated && width > 0) {
    out += "…";
    used++;
  }
  return out + (pad ? " ".repeat(Math.max(0, width - used)) : "");
}
export function wrap(value: string, width: number): string[] {
  const result: string[] = [];
  let line = "";
  let used = 0;
  for (const { segment } of segments.segment(clean(value))) {
    const n = stringWidth(segment);
    if (used + n > width && line) {
      result.push(line);
      line = "";
      used = 0;
    }
    line += segment;
    used += n;
  }
  result.push(line);
  return result;
}
export const num = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(1)}K`
      : String(n);
export const age = (timestamp: number | null, now: number) =>
  timestamp === null
    ? "unknown age"
    : timestamp > now
      ? "future timestamp"
      : now - timestamp < 60_000
        ? "just now"
        : now - timestamp < 3_600_000
          ? `${Math.floor((now - timestamp) / 60_000)}m ago`
          : now - timestamp < 86_400_000
            ? `${Math.floor((now - timestamp) / 3_600_000)}h ago`
            : `${Math.floor((now - timestamp) / 86_400_000)}d ago`;
export const costLabel = (c: CostRow | undefined) =>
  !c || (c.basis === "estimated" && c.priced_requests === 0)
    ? "unavailable"
    : `${c.basis === "estimated" ? "~" : ""}$${c.cost_usd.toFixed(2)}${c.cost_complete ? "" : "+"}`;
export function Row({
  text,
  width,
  tone = "text",
  mono = false,
  selected = false,
}: {
  text: string;
  width: number;
  tone?: Tone;
  mono?: boolean;
  selected?: boolean;
}) {
  return (
    <Text
      color={mono ? undefined : palette[selected ? "accent" : tone]}
      bold={selected}
      wrap="truncate-end"
    >
      {fit(text, width)}
    </Text>
  );
}
export function Section({
  title,
  width,
  height,
  focused,
  children,
  mono,
}: React.PropsWithChildren<{
  title: string;
  width: number;
  height: number;
  focused?: boolean;
  mono: boolean;
}>) {
  return (
    <Box
      width={width}
      height={height}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
    >
      <Row
        text={`${focused ? "▸" : " "} ${title} ${"─".repeat(width)}`}
        width={width}
        tone={focused ? "accent" : "muted"}
        mono={mono}
      />
      {children}
    </Box>
  );
}
export function Viewport({
  lines,
  offset,
  width,
  height,
  mono,
  onRange,
}: {
  lines: Line[];
  offset: number;
  width: number;
  height: number;
  mono: boolean;
  onRange?: (max: number) => void;
}) {
  const expanded = lines.flatMap((l) =>
    wrap(l.text, width).map((text) => ({ ...l, text })),
  );
  const max = Math.max(0, expanded.length - Math.max(1, height - 1));
  useEffect(() => {
    onRange?.(max);
  }, [max, onRange]);
  const start = Math.min(offset, max);
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {expanded.slice(start, start + height - 1).map((l, i) => (
        <Row key={i} {...l} width={width} mono={mono} />
      ))}
      {expanded.length > height - 1 && (
        <Row
          text={`↑↓ ${start + 1}–${Math.min(expanded.length, start + height - 1)} / ${expanded.length}`}
          width={width}
          mono={mono}
          tone="muted"
        />
      )}
    </Box>
  );
}
export function Sparkline({
  values,
  width,
  mono,
}: {
  values: (number | null)[];
  width: number;
  mono: boolean;
}) {
  const bars = "▁▂▃▄▅▆▇█";
  return (
    <Row
      width={width}
      mono={mono}
      text={values
        .map((n) =>
          n === null
            ? "·"
            : bars[Math.max(0, Math.min(7, Math.floor((n / 100) * 7)))],
        )
        .join("")}
    />
  );
}
export function BarChart({
  values,
  width,
  height,
  mono,
}: {
  values: number[];
  width: number;
  height: number;
  mono: boolean;
}) {
  const peak = Math.max(1, ...values);
  const step = Math.max(1, Math.floor(width / values.length));
  return (
    <Box flexDirection="column">
      {Array.from({ length: height }, (_, i) => (
        <Text key={i}>
          {values.map((v, j) => (
            <Text
              key={j}
              color={
                mono
                  ? undefined
                  : j === values.length - 1
                    ? palette.accent
                    : palette.muted
              }
            >
              {(v > 0 && (v / peak) * height >= height - i
                ? "█"
                : i === height - 1
                  ? "─"
                  : " "
              ).repeat(Math.max(1, step - 1))}
              {step > 1 ? " " : ""}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
export function SessionTable({
  rows,
  costs,
  selected,
  width,
  height,
  now,
  mono,
}: {
  rows: SessionRow[];
  costs: Record<string, CostRow>;
  selected?: string;
  width: number;
  height: number;
  now: number;
  mono: boolean;
}) {
  const nameWidth = Math.max(13, width - 60);
  const line = (
    when: string,
    name: string,
    model: string,
    requests: string,
    tokens: string,
    cost: string,
    marker = " ",
  ) =>
    `${marker} ${fit(when, 8, true)} ${fit(name, nameWidth, true)} ${fit(model, 17, true)} ${fit(requests, 6, true)} ${fit(tokens, 7, true)} ${cost}`;
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Row
        text={line(
          "Activity",
          "Name / project",
          "Models",
          "Reqs",
          "Tokens",
          "Cost",
        )}
        width={width}
        tone="muted"
        mono={mono}
      />
      {rows.map((r) => (
        <Row
          key={r.session_id}
          text={line(
            age(r.last_ts ? Date.parse(r.last_ts) : null, now),
            `${r.slug ?? r.session_id} / ${r.project ?? "—"}`,
            r.models ?? "—",
            num(r.requests),
            num(r.total_tokens),
            costLabel(costs[r.session_id]),
            selected === r.session_id ? "▸" : " ",
          )}
          width={width}
          mono={mono}
          selected={selected === r.session_id}
        />
      ))}
    </Box>
  );
}
