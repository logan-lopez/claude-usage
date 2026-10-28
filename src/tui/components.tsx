/** Presentational primitives. Plain props in, Ink elements out. */
import React, { createContext, memo, useContext } from "react";
import { Box, Text } from "ink";
import type { CostRow, SessionRow } from "../query.ts";
import { age, costLabel, fit, num, wrap } from "./text.ts";
import { palettes, type Palette, type Tone } from "./theme.ts";
import { visibleRows } from "./layout.ts";

export type { Tone };
/** Set once by `App` (`MONO` for no colour); the default keeps components renderable on their own. */
export const PaletteContext = createContext<Palette>(palettes.dark);
export type Line = { text: string; tone?: Tone };
export const line = (text: string, tone?: Tone): Line => ({ text, tone });

export const Row = memo(function Row({
  text,
  width,
  tone = "text",
  selected = false,
}: {
  text: string;
  width: number;
  tone?: Tone;
  selected?: boolean;
}) {
  const palette = useContext(PaletteContext);
  return (
    <Text
      color={palette[selected ? "accent" : tone]}
      bold={selected}
      wrap="truncate-end"
    >
      {fit(text, width)}
    </Text>
  );
});

export function Section({
  title,
  width,
  height,
  focused,
  children,
}: React.PropsWithChildren<{
  title: string;
  width: number;
  height: number;
  focused?: boolean;
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
      />
      {children}
    </Box>
  );
}

/** Wrap logical lines into terminal rows. Callers memoize this and size scrolling from it. */
export const wrapLines = (lines: Line[], width: number): Line[] =>
  lines.flatMap((l) => wrap(l.text, width).map((text) => ({ ...l, text })));

/** The furthest a viewport of `height` can scroll through `rows`. */
export const scrollMax = (rows: Line[], height: number) =>
  Math.max(0, rows.length - visibleRows(height));

export function Viewport({
  rows,
  offset,
  width,
  height,
}: {
  rows: Line[];
  offset: number;
  width: number;
  height: number;
}) {
  const visible = visibleRows(height);
  const start = Math.min(offset, scrollMax(rows, height));
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {rows.slice(start, start + visible).map((l, i) => (
        <Row key={i} text={l.text} tone={l.tone} width={width} />
      ))}
      {rows.length > visible && (
        <Row
          text={`↑↓ ${start + 1}–${Math.min(rows.length, start + visible)} / ${rows.length}`}
          width={width}
          tone="muted"
        />
      )}
    </Box>
  );
}

/**
 * One string per chart row, with the last (partial) bucket in the accent colour. Any nonzero value
 * gets at least the bottom block, so a small day never reads as a zero day; zero days keep `─`.
 */
/** Bars, today's last; `marker` draws a ▲ under that bar on one more row. */
export function BarChart({
  values,
  width,
  height,
  marker,
  partial = true,
}: {
  values: number[];
  width: number;
  height: number;
  marker?: number;
  /** The last bar is a bucket still filling, in the accent colour. */
  partial?: boolean;
}) {
  const palette = useContext(PaletteContext);
  if (!values.length) return null;
  const peak = Math.max(1, ...values);
  const step = Math.max(1, Math.floor(width / values.length));
  const cell = (v: number, i: number) =>
    (v > 0 && (i === height - 1 || (v / peak) * height >= height - i)
      ? "█"
      : i === height - 1
        ? "─"
        : " "
    ).repeat(Math.max(1, step - 1)) + (step > 1 ? " " : "");
  const history = partial ? values.slice(0, -1) : values;
  const today = partial ? values.at(-1)! : null;
  return (
    <Box flexDirection="column">
      {Array.from({ length: height }, (_, i) => (
        <Text key={i}>
          <Text color={palette.muted}>
            {history.map((v) => cell(v, i)).join("")}
          </Text>
          {today !== null && <Text color={palette.accent}>{cell(today, i)}</Text>}
        </Text>
      ))}
      {marker !== undefined && (
        <Text color={palette.accent}>
          {" ".repeat(marker * step + Math.floor((Math.max(1, step - 1) - 1) / 2))}▲
        </Text>
      )}
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
}: {
  rows: SessionRow[];
  costs: Record<string, CostRow>;
  selected?: string;
  width: number;
  height: number;
  now: number;
}) {
  const nameWidth = Math.max(13, width - 60);
  const cells = (
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
        text={cells("Activity", "Name / project", "Models", "Reqs", "Tokens", "Cost")}
        width={width}
        tone="muted"
      />
      {rows.map((r) => (
        <Row
          key={r.session_id}
          text={cells(
            age(r.last_ts ? Date.parse(r.last_ts) : null, now),
            `${r.slug ?? r.session_id} / ${r.project ?? "—"}`,
            r.models ?? "—",
            num(r.requests),
            num(r.total_tokens),
            costLabel(costs[r.session_id]),
            selected === r.session_id ? "▸" : " ",
          )}
          width={width}
          selected={selected === r.session_id}
        />
      ))}
    </Box>
  );
}
