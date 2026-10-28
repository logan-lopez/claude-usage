/** Timeline: output-token bars per day, week or month, and the bucket under the cursor split by series. */
import { useRef, useState } from "react";
import { Box } from "ink";
import type { SessionScope, TokenTotals } from "../query.ts";
import {
  TIMELINE_BUCKETS,
  TIMELINE_SPLITS,
  type TimelineData,
  type TimelineSlot,
  type TuiDependencies,
} from "./data.ts";
import { bookLine, TOKENS_PER_WORD } from "./books.ts";
import { BarChart, Row } from "./components.tsx";
import { cycle, movement, useKeys } from "./keys.ts";
import { tableBodyRows } from "./layout.ts";
import type { ScreenModel } from "./screen.ts";
import { fit, num } from "./text.ts";
import { ARCHIVE_UNREADABLE, type Report } from "./useArchive.ts";

const BUCKET_NAMES = { day: "days", week: "weeks", month: "months" } as const;
/** `timeline()` names a NULL series this; a drill matches it as NULL. */
const UNKNOWN = "(unknown)";
const ALL = "all";

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A bucket as the drill names it: `2026-10-21 UTC`, `week of 2026-10-19 UTC`, `2026-10 UTC`. */
export function bucketLabel(bucket: number, tsMs: number) {
  const name = TIMELINE_BUCKETS[bucket]!;
  return name === "month" ? `${isoDay(tsMs).slice(0, 7)} UTC` : `${name === "week" ? "week of " : ""}${isoDay(tsMs)} UTC`;
}
const splitName = (split: number) => TIMELINE_SPLITS[split] ?? "none";

/** Two columns a bar, one of them the gap. */
const visibleCount = (width: number) => Math.max(1, Math.floor(width / 2));
/** The book line, the chart, the ▲ row, the cursor's line, and the table's header. */
const chartHeight = (height: number) => Math.max(3, Math.min(8, Math.floor((height - 6) / 3)));
const tableRows = (height: number) => tableBodyRows(height - 3 - chartHeight(height));

type View = {
  bucket: number;
  split: number;
  data: TimelineData | null;
  /** A time in the cursor's bucket (the start of the one last chosen), so a reread can't move it. */
  cursor: number | null;
  /** The newest bucket on screen by its start; null follows the newest bucket there is. */
  right: number | null;
  /** The table's selection by key, falling back to `all`. */
  key: string;
  selection: number;
  scroll: number;
};
const emptyView: View = { bucket: 0, split: 0, data: null, cursor: null, right: null, key: ALL, selection: 0, scroll: 0 };

/** The cursor's index, the window `[start, end)` on screen, and the table's rows, for one width. */
function place(v: View, width: number) {
  const buckets = v.data?.buckets ?? [];
  const n = buckets.length;
  const found = v.cursor === null ? -1 : buckets.findIndex((b) => b.tsMs <= v.cursor! && v.cursor! < b.endMs);
  const cursor = found >= 0 ? found : v.cursor !== null && n && v.cursor < buckets[0]!.tsMs ? 0 : Math.max(0, n - 1);
  const count = Math.min(n, visibleCount(width));
  const rightAt = v.right === null ? n : buckets.findIndex((b) => b.tsMs === v.right) + 1 || n;
  const end = Math.min(n, Math.max(cursor + 1, Math.min(rightAt, cursor + count)));
  const slot = buckets[cursor];
  return { buckets, cursor, start: Math.max(0, end - count), end, slot, rows: slot ? tableOf(slot, v.split) : [] };
}
/** `all` first, then the bucket's series when split. */
const tableOf = (slot: TimelineSlot, split: number) => [
  { ...slot.total, key: ALL },
  ...(TIMELINE_SPLITS[split] ? slot.rows : []),
];

const HELP = [
  "←→ or h/l move the ▲ from bucket to bucket; past the left edge the chart scrolls back in time. ↑↓ or j/k choose a row of the table, PageUp and PageDown move a page, Home and End jump to either end.",
  "b cycles days, weeks and months. g splits the table by model, project or effort, or not at all.",
  "Bars are output tokens, what Claude wrote: cache reads are nearly all of the total, so bars of total tokens would chart context size rather than work. The last bucket is partial.",
  "Buckets are UTC days, weeks from Monday, and calendar months.",
  "The table is the bucket under the ▲: output, total tokens, requests, and cache-read share, which is cache reads over all input (input, cache writes and cache reads).",
  "No cost here: a session's cost is recorded for the whole session, so one that crosses midnight would drop out of both days, and today would read $0.00 while you spend.",
  `The line at the top compares the output tokens on screen to classic books, at ${TOKENS_PER_WORD} tokens a word, a rule of thumb for English rather than a measured figure; word counts vary by edition. It's approximate by design.`,
  "Enter lists the sessions with at least one request in the bucket (and series), with whole-session totals.",
];

export function useTimelineScreen({
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
  // Reads since the last reload, by bucket and split: a b or g round trip doesn't requery.
  const cache = useRef(new Map<string, TimelineData>());

  function commit(next: View) {
    latest.current = next;
    setView(next);
  }
  /** The table's selection follows its key, else falls back to `all`. */
  function select(v: View): View {
    const { rows } = place(v, width);
    const found = rows.findIndex((r) => r.key === v.key);
    const selection = Math.max(0, found);
    return { ...v, selection, key: rows[selection]?.key ?? ALL, scroll: found >= 0 ? v.scroll : 0 };
  }
  /** Show `bucket` split by `split`, reading it unless it's cached; the cursor keeps its start. */
  function show(bucket: number, split: number) {
    const id = `${bucket}|${split}`;
    let data = cache.current.get(id);
    if (!data) {
      data = deps.timeline(TIMELINE_BUCKETS[bucket]!, TIMELINE_SPLITS[split]!);
      cache.current.set(id, data);
      report.ok();
    }
    const before = latest.current;
    const next: View = { ...before, bucket, split, data, right: bucket === before.bucket ? before.right : null };
    const at = place(next, width);
    // The cursor keeps the start it was given, not its bucket's: a week holds the day it came from,
    // and going back to days finds that day again.
    commit(select({ ...next, cursor: before.cursor ?? at.slot?.tsMs ?? null, right: at.end === at.buckets.length ? null : at.buckets[at.end - 1]!.tsMs }));
  }
  function attempt(message: string, action: () => void) {
    try {
      action();
    } catch {
      report.error(message);
    }
  }
  const page = tableRows(height);

  return {
    title: "Timeline",
    context: `${BUCKET_NAMES[TIMELINE_BUCKETS[view.bucket]!]} · ${TIMELINE_SPLITS[view.split] ? `by ${splitName(view.split)}` : "no split"}`,
    hints: "←→ bucket · ↑↓ row · b d/w/m · g split · Enter sessions · ? help · q quit",
    help: HELP,
    overlay: false,
    /** After an archive change: the same bucket and split, reread, cursor and row kept. */
    reload: () =>
      attempt(ARCHIVE_UNREADABLE, () => {
        cache.current.clear();
        show(latest.current.bucket, latest.current.split);
      }),
    render: (frame) => (
      <TimelineScreen
        view={view}
        width={frame.width}
        height={frame.height}
        onKeys={(input, key) => {
          const v = latest.current;
          if (/^b+$/.test(input))
            return attempt("Archive read failed; last timeline retained.", () =>
              show(cycle(v.bucket, input.length % TIMELINE_BUCKETS.length, TIMELINE_BUCKETS.length), v.split),
            );
          if (/^g+$/.test(input))
            return attempt("Archive read failed; last timeline retained.", () =>
              show(v.bucket, cycle(v.split, input.length % TIMELINE_SPLITS.length, TIMELINE_SPLITS.length)),
            );
          // h/l that queued behind a slow frame arrive as one string ("lll"); count them.
          const step = key.leftArrow ? -1 : key.rightArrow ? 1
            : /^(?:h+|l+)$/.test(input) ? (input[0] === "h" ? -input.length : input.length) : 0;
          const at = place(v, frame.width);
          if (step) {
            if (!at.buckets.length) return;
            const cursor = Math.max(0, Math.min(at.buckets.length - 1, at.cursor + step));
            const count = visibleCount(frame.width);
            // The window moves only when the cursor leaves it.
            const end = cursor >= at.end ? cursor + 1 : cursor < at.start ? Math.min(at.buckets.length, cursor + count) : at.end;
            return commit(select({
              ...v,
              cursor: at.buckets[cursor]!.tsMs,
              right: end === at.buckets.length ? null : at.buckets[end - 1]!.tsMs,
            }));
          }
          if (key.return) {
            const slot = at.slot;
            const row = at.rows[v.selection];
            if (!slot || !row) return;
            const label = bucketLabel(v.bucket, slot.tsMs);
            const by = TIMELINE_SPLITS[v.split];
            if (row.key === ALL || !by) return drill({ since: slot.tsMs, until: slot.endMs }, label);
            return drill(
              { since: slot.tsMs, until: slot.endMs, by, key: row.key === UNKNOWN ? null : row.key },
              `${label} · ${by} ${row.key}`,
            );
          }
          const to = movement(input, key, page);
          if (!to) return;
          const selection = to(v.selection, Math.max(0, at.rows.length - 1));
          commit({ ...v, selection, key: at.rows[selection]?.key ?? ALL, scroll: scrolled(v.scroll, selection, page) });
        }}
      />
    ),
  };
}

/** The first visible row: unchanged unless the selection left the page. */
const scrolled = (scroll: number, selection: number, page: number) =>
  selection < scroll ? selection : selection >= scroll + page ? selection - page + 1 : scroll;

/** Cache reads as a share of all input: what came from cache rather than being sent or written. */
export const cacheShare = (t: TokenTotals) => {
  const input = t.input_tokens + t.cache_creation_tokens + t.cache_read_tokens;
  return input ? `${((t.cache_read_tokens / input) * 100).toFixed(1)}%` : "—";
};

function TimelineScreen({
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
  const bucket = TIMELINE_BUCKETS[view.bucket]!;
  const split = TIMELINE_SPLITS[view.split];
  if (!view.data) return <Row text={`${BUCKET_NAMES[bucket]} · reading…`} width={width} />;
  const at = place(view, width);
  const shown = at.buckets.slice(at.start, at.end);
  if (!shown.length || !at.slot) return <Row text="Archive is empty. Run cusage sync to archive requests." width={width} />;
  const output = shown.reduce((n, b) => n + b.output, 0);
  const first = bucketLabel(view.bucket, shown[0]!.tsMs).replace(/^week of | UTC$/g, "");
  const last = bucketLabel(view.bucket, shown.at(-1)!.tsMs).replace(/^week of | UTC$/g, "");
  const newest = at.end === at.buckets.length;
  const page = tableRows(height);
  const rows = at.rows;
  const selection = Math.min(view.selection, Math.max(0, rows.length - 1));
  const scroll = Math.max(0, Math.min(scrolled(view.scroll, selection, page), Math.max(0, rows.length - page)));
  const nameWidth = Math.max(12, Math.min(width - 2 - 9 * 3 - 11, Math.max(5, ...rows.map((r) => r.key.length)) + 1));
  const cells = (name: string, out: string, tokens: string, requests: string, share: string, marker = " ") =>
    `${marker} ${fit(name, nameWidth, true)}${out.padStart(9)}${tokens.padStart(9)}${requests.padStart(9)}${share.padStart(11)}`;
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Row text={`${BUCKET_NAMES[bucket]} · ${first} → ${last} · ${num(output)} output tokens ${bookLine(output)}`} width={width} />
      <BarChart
        values={shown.map((b) => b.output)}
        // At most four columns a bar, so a few months don't stretch across the screen.
        width={Math.min(width, shown.length * 4)}
        height={chartHeight(height)}
        marker={at.cursor - at.start}
        partial={newest}
      />
      <Row
        text={`▲ ${bucketLabel(view.bucket, at.slot.tsMs)}${at.cursor === at.buckets.length - 1 ? " (partial)" : ""}: ${num(at.slot.output)} output tokens${at.start > 0 ? ` · ${at.start} older ←` : ""}`}
        width={width}
        tone="muted"
      />
      <Row text={cells(split ?? "series", "Output", "Tokens", "Reqs", "Cache read")} width={width} tone="muted" />
      {rows.slice(scroll, scroll + page).map((r, i) => {
        const selected = scroll + i === selection;
        return (
          <Row
            key={r.key}
            text={cells(r.key, num(r.output_tokens), num(r.total_tokens), num(r.requests), cacheShare(r), selected ? "▸" : " ")}
            width={width}
            selected={selected}
          />
        );
      })}
    </Box>
  );
}
