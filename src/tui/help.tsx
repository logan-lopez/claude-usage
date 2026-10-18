import { useMemo, useState } from "react";
import { Viewport, line, scrollMax, wrapLines } from "./components.tsx";
import { movement, useKeys } from "./keys.ts";
import { visibleRows } from "./layout.ts";

/** What every cost column's marks mean; shared by the screens that show costs. */
export const COST_MARKS = [
  "$ is Claude Code's own cost record for the session. ~$ is an estimate from the price table, for sessions without one. A trailing + means some requests couldn't be priced and aren't in the amount. unavailable means none could.",
  "Measured and estimated amounts are never added together.",
];

/** The shell's own keys, shown under every screen's help. `tabs` is e.g. "1 Overview · 2 Sessions". */
const shellHelp = (tabs: string) => [
  `${tabs} switch screens. ? opens this help; Esc closes it.`,
  "r rereads the archive and reruns the health checks. It fetches and ingests nothing.",
  "R fetches fresh limits, with the same 3-minute spacing as the CLI. CUSAGE_REFRESH=off turns it off.",
  "q quits, except while you're typing in search or a filter. Ctrl+C always quits.",
];

/** Contextual help. Mounted fresh on each open, so it always starts at the top. */
export function Help({
  title,
  lines,
  tabs,
  width,
  height,
  themeNote,
}: {
  title: string;
  /** The screen's own lines; the shell's follow them. */
  lines: string[];
  /** The tabs and their keys, e.g. "1 Overview · 2 Sessions". */
  tabs: string;
  width: number;
  height: number;
  themeNote?: string;
}) {
  const [offset, setOffset] = useState(0);
  const rows = useMemo(
    () =>
      wrapLines(
        [
          line(`${title} help`, "accent"),
          ...lines.map((t) => line(t)),
          // A Text holding "" renders no row at all.
          line(" "),
          line("Everywhere", "muted"),
          ...shellHelp(tabs).map((t) => line(t)),
          ...(themeNote
            ? [line(`Theme: ${themeNote}. Override with CUSAGE_THEME=light|dark|auto or --theme.`, "muted")]
            : []),
        ],
        width,
      ),
    [title, lines, tabs, width, themeNote],
  );
  const max = scrollMax(rows, height);
  useKeys((input, key) => {
    const to = movement(input, key, visibleRows(height));
    if (to) setOffset((o) => to(o, max));
  });
  return <Viewport rows={rows} offset={offset} width={width} height={height} />;
}
