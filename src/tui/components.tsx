/** Presentational primitives. Plain props in, Ink elements out. */
import React, { createContext, memo, useContext } from "react";
import { Box, Text } from "ink";
import type { CostRow, SessionRow } from "../query.ts";
import { age, costLabel, fit, num, wrap } from "./text.ts";
import { palettes, type Palette, type Tone } from "./theme.ts";

export type { Tone };
/** Set once by `App`; the default keeps components renderable on their own. */
export const PaletteContext = createContext<Palette>(palettes.dark);
export type Line = { text: string; tone?: Tone };
export const line = (text: string, tone?: Tone): Line => ({ text, tone });

export const Row = memo(function Row({
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
  const palette = useContext(PaletteContext);
  return (
    <Text
      color={mono ? undefined : palette[selected ? "accent" : tone]}
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

/** Wrap logical lines into terminal rows. Callers memoize this and size scrolling from it. */
export const wrapLines = (lines: Line[], width: number): Line[] =>
  lines.flatMap((l) => wrap(l.text, width).map((text) => ({ ...l, text })));

/** A viewport of `height` shows `height - 1` rows; the last row is the position indicator. */
export const scrollMax = (rows: Line[], height: number) =>
  Math.max(0, rows.length - Math.max(1, height - 1));

export function Viewport({
  rows,
  offset,
  width,
  height,
  mono,
}: {
  rows: Line[];
  offset: number;
  width: number;
  height: number;
  mono: boolean;
}) {
  const visible = Math.max(1, height - 1);
  const start = Math.min(offset, scrollMax(rows, height));
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {rows.slice(start, start + visible).map((l, i) => (
        <Row key={i} text={l.text} tone={l.tone} width={width} mono={mono} />
      ))}
      {rows.length > visible && (
        <Row
          text={`↑↓ ${start + 1}–${Math.min(rows.length, start + visible)} / ${rows.length}`}
          width={width}
          mono={mono}
          tone="muted"
        />
      )}
    </Box>
  );
}

/** One string per chart row, with the last (partial) bucket in the accent colour. */
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
  const palette = useContext(PaletteContext);
  if (!values.length) return null;
  const peak = Math.max(1, ...values);
  const step = Math.max(1, Math.floor(width / values.length));
  const cell = (v: number, i: number) =>
    (v > 0 && (v / peak) * height >= height - i
      ? "█"
      : i === height - 1
        ? "─"
        : " "
    ).repeat(Math.max(1, step - 1)) + (step > 1 ? " " : "");
  const history = values.slice(0, -1);
  const today = values.at(-1)!;
  return (
    <Box flexDirection="column">
      {Array.from({ length: height }, (_, i) => (
        <Text key={i}>
          <Text color={mono ? undefined : palette.muted}>
            {history.map((v) => cell(v, i)).join("")}
          </Text>
          <Text color={mono ? undefined : palette.accent}>{cell(today, i)}</Text>
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
        mono={mono}
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
          mono={mono}
          selected={selected === r.session_id}
        />
      ))}
    </Box>
  );
}
