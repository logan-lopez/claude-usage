/** Pure text helpers: terminal-cell fitting, wrapping and labels. No React, no I/O. */
import stringWidth from "string-width";
import { FRESH_MS, type CostRow } from "../query.ts";

/** Control characters in archived names must never reach the terminal. */
export const clean = (s: unknown) =>
  String(s ?? "—").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Truncate (with …) or pad to exactly `width` terminal cells. */
export function fit(value: unknown, width: number, pad = false) {
  const text = clean(value);
  const used = stringWidth(text);
  if (used <= width) return pad ? text + " ".repeat(width - used) : text;
  if (width <= 0) return "";
  let out = "";
  let kept = 0;
  for (const { segment } of segments.segment(text)) {
    const n = stringWidth(segment);
    if (kept + n > width - 1) break;
    out += segment;
    kept += n;
  }
  return `${out}…${pad ? " ".repeat(Math.max(0, width - kept - 1)) : ""}`;
}

/** Hard-wrap on grapheme boundaries; always returns at least one line. */
export function wrap(value: string, width: number): string[] {
  const text = clean(value);
  if (stringWidth(text) <= width) return [text];
  const result: string[] = [];
  let line = "";
  let used = 0;
  for (const { segment } of segments.segment(text)) {
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

export const isStale = (tsMs: number, now: number) => now - tsMs > FRESH_MS;

export const costLabel = (c: CostRow | undefined) =>
  !c || (c.basis === "estimated" && c.priced_requests === 0)
    ? "unavailable"
    : `${c.basis === "estimated" ? "~" : ""}$${c.cost_usd.toFixed(2)}${c.cost_complete ? "" : "+"}`;

const BARS = "▁▂▃▄▅▆▇█";
/** Percent series as block glyphs. Missing samples stay `·`; gaps are never bridged. */
export const spark = (values: (number | null)[]) =>
  values
    .map((n) =>
      n === null ? "·" : BARS[Math.max(0, Math.min(7, Math.floor((n / 100) * 7)))],
    )
    .join("");
