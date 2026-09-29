import { useMemo, useState } from "react";
import { Viewport, line, scrollMax, wrapLines } from "./components.tsx";
import { movement, useKeys } from "./keys.ts";

const HELP = [
  "1 Overview · 2 Sessions · Tab / Shift+Tab focus panels or Detail sections",
  "↑↓ or j/k move / scroll · PageUp / PageDown · Home / End",
  "Enter opens selected session · Esc returns from Detail or cancels an overlay",
  "/ edit search (ID or name, case-insensitive) · f project/model/activity filters · s sort",
  "Filters select sessions. Displayed tokens and costs are WHOLE-SESSION totals, not spend within a filter.",
  "Detail: Tab changes section; Attribution: ←/→ selects effort, agent, skill, MCP server or plugin.",
  "r rereads archive and reruns credential-free diagnostics; no ingestion or fetch.",
  "R explicitly fetches limits using the shared attempt floor; CUSAGE_REFRESH=off disables it.",
  "q quits outside overlays. Ctrl+C always quits. Text inputs and overlays own keyboard input.",
  "$ measured cumulative session cost-state · ~$ estimated using committed rates · + partial known-rate subtotal.",
  "Unavailable means wholly unpriced. Measured and estimated subtotals are never combined.",
  "Unknown context tiers and unknown rates are disclosed in Detail. No per-tool token costs are assigned.",
  "Meters show hourly peaks, not current readings. · is missing; gaps are never interpolated.",
  "Daily output is archived local usage in UTC. Zero days remain present; today is partial.",
  "Archive diagnostics report operational evidence, not inferred agent health; ordinary browsing never probes credentials.",
];

/** Contextual help. Mounted fresh on each open, so it always starts at the top. */
export function Help({
  title,
  width,
  height,
  mono,
}: {
  title: string;
  width: number;
  height: number;
  mono: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const rows = useMemo(
    () => wrapLines([`${title} help`, ...HELP].map((t) => line(t)), width),
    [title, width],
  );
  const max = scrollMax(rows, height);
  useKeys((input, key) => {
    const to = movement(input, key, height - 2);
    if (to) setOffset((o) => to(o, max));
  });
  return (
    <Viewport rows={rows} offset={offset} width={width} height={height} mono={mono} />
  );
}
