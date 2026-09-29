/** Sessions: paged browsing state, the table screen, and its search/filter/sort overlays. */
import { useEffect, useRef, useState } from "react";
import { Box } from "ink";
import { Select, TextInput } from "@inkjs/ui";
import type { CostRow, SessionRow, SessionSort } from "../query.ts";
import {
  activities,
  activitySince,
  SessionBrowser,
  type Activity,
  type TuiDependencies,
} from "./data.ts";
import { Row, SessionTable } from "./components.tsx";
import { movement, useKeys } from "./keys.ts";
import type { Report } from "./useArchive.ts";

export type Filters = {
  search: string;
  project: string;
  model: string;
  activity: Activity;
  sort: SessionSort;
};
export const initialFilters: Filters = {
  search: "",
  project: "",
  model: "",
  activity: "All",
  sort: "activity",
};
export type SessionOverlay =
  | "search"
  | "filters"
  | "project"
  | "model"
  | "activity"
  | "sort";

/** Everything the table needs, committed together so one move is one render. */
type View = {
  rows: SessionRow[];
  costs: Record<string, CostRow>;
  total: number;
  selection: number;
  scroll: number;
};
const emptyView: View = { rows: [], costs: {}, total: 0, selection: 0, scroll: 0 };
const selectedId = (v: View) => v.rows[v.selection - v.scroll]?.session_id;

export function useSessions(
  deps: TuiDependencies,
  pageHeight: number,
  report: Report,
) {
  const [filters, setFilters] = useState(initialFilters);
  const [view, setView] = useState(emptyView);
  const browser = useRef<SessionBrowser | null>(null);
  // Refs track what was last committed, so repeated keys in one stdin chunk
  // and reloads from timers never act on a stale render.
  const latest = useRef(emptyView);
  const current = useRef(initialFilters);

  function show(b: SessionBrowser, index: number, scroll = latest.current.scroll) {
    b.page(Math.max(0, index));
    const last = Math.max(0, b.total - 1);
    const selection = Math.max(0, Math.min(index, last));
    const start = Math.max(
      0,
      Math.min(
        selection < scroll
          ? selection
          : selection >= scroll + pageHeight
            ? selection - pageHeight + 1
            : scroll,
        Math.max(0, b.total - pageHeight),
      ),
    );
    const rows = b.visible(start, pageHeight);
    const costs: Record<string, CostRow> = {};
    for (const r of rows) if (b.costs[r.session_id]) costs[r.session_id] = b.costs[r.session_id]!;
    browser.current = b;
    latest.current = { rows, costs, total: b.total, selection, scroll: start };
    setView(latest.current);
  }
  function create(f: Filters) {
    return new SessionBrowser(deps, {
      search: f.search,
      project: f.project || null,
      model: f.model || null,
      since: activitySince(f.activity, deps.now()),
      sort: f.sort,
    });
  }
  function attempt(message: string, action: () => void) {
    try {
      action();
      return true;
    } catch {
      report.error(message);
      return false;
    }
  }

  useEffect(() => {
    const b = browser.current;
    if (b)
      attempt("Could not read the next page; previous results retained.", () =>
        show(b, latest.current.selection),
      );
  }, [pageHeight]);

  return {
    filters,
    view,
    selected: () => selectedId(latest.current),
    apply(next: Filters) {
      if (
        attempt(
          "Archive read failed; last successful results retained (outdated).",
          () => show(create(next), 0, 0),
        )
      ) {
        current.current = next;
        setFilters(next);
        report.ok();
      }
    },
    /** After an archive change: same filters, selection kept by session ID. */
    reload() {
      attempt(
        "Archive unreadable; last successful data retained (outdated). Run cusage sync or check --db.",
        () => {
          const b = create(current.current);
          show(b, b.locate(selectedId(latest.current), latest.current.selection));
        },
      );
    },
    move(to: (selection: number, last: number) => number) {
      const b = browser.current;
      if (b)
        attempt("Page read failed; last successful results retained.", () =>
          show(b, to(latest.current.selection, Math.max(0, b.total - 1))),
        );
    },
  };
}
export type Sessions = ReturnType<typeof useSessions>;

export function SessionsScreen({
  sessions,
  archiveEmpty,
  width,
  height,
  pageHeight,
  now,
  mono,
  onOpen,
  onOverlay,
}: {
  sessions: Sessions;
  archiveEmpty: boolean;
  width: number;
  height: number;
  pageHeight: number;
  now: number;
  mono: boolean;
  onOpen: (id: string | undefined) => void;
  onOverlay: (overlay: SessionOverlay) => void;
}) {
  const { filters, view } = sessions;
  useKeys((input, key) => {
    if (input === "/") return onOverlay("search");
    if (input === "f") return onOverlay("filters");
    if (input === "s") return onOverlay("sort");
    if (key.return) return onOpen(sessions.selected());
    const to = movement(input, key, pageHeight);
    if (to) sessions.move(to);
  });
  return (
    <Box flexDirection="column">
      <Row
        text={`Search: ${filters.search || "—"} · project: ${filters.project || "All"} · model: ${filters.model || "All"}`}
        width={width}
        mono={mono}
      />
      <Row
        text={`${filters.activity} · sort ${filters.sort} ↓ · Filters select sessions; whole-session totals.`}
        width={width}
        mono={mono}
        tone="muted"
      />
      <Row
        text={`${view.total} matching · ${view.total ? view.scroll + 1 : 0}–${Math.min(view.total, view.scroll + view.rows.length)} visible`}
        width={width}
        mono={mono}
        tone="muted"
      />
      {view.total ? (
        <SessionTable
          rows={view.rows}
          costs={view.costs}
          selected={selectedId(view)}
          width={width}
          height={height - 3}
          now={now}
          mono={mono}
        />
      ) : (
        <Row
          text={
            archiveEmpty
              ? "Archive is empty. Run cusage sync."
              : "No matching sessions. f clears filters."
          }
          width={width}
          mono={mono}
        />
      )}
    </Box>
  );
}

const options = (values: readonly string[]) =>
  values.map((value) => ({ label: value, value }));

/** Overlays own the keyboard; Esc (handled by the shell) cancels without applying. */
export function SessionOverlayView({
  overlay,
  filters,
  width,
  mono,
  onApply,
  onOverlay,
}: {
  overlay: SessionOverlay;
  filters: Filters;
  width: number;
  mono: boolean;
  onApply: (next: Filters) => void;
  onOverlay: (overlay: SessionOverlay) => void;
}) {
  if (overlay === "search" || overlay === "project" || overlay === "model")
    return (
      <Box flexDirection="column">
        <Row
          text={`${overlay}: ${overlay === "search" ? "session ID or name" : "case-insensitive contains"} · Enter applies · Esc cancels`}
          width={width}
          mono={mono}
        />
        <TextInput
          key={overlay}
          defaultValue={filters[overlay]}
          onSubmit={(value) => onApply({ ...filters, [overlay]: value })}
        />
      </Box>
    );
  if (overlay === "filters")
    return (
      <Box flexDirection="column">
        <Row
          text="Filters choose sessions; amounts remain whole-session totals."
          width={width}
          mono={mono}
        />
        <Select
          options={options(["Project", "Model", "Activity", "Clear all"])}
          onChange={(v) =>
            v === "Clear all"
              ? onApply({ ...initialFilters, sort: filters.sort })
              : onOverlay(v.toLowerCase() as "project" | "model" | "activity")
          }
        />
      </Box>
    );
  if (overlay === "activity")
    return (
      <Select
        options={options(activities)}
        defaultValue={filters.activity}
        onChange={(v) => onApply({ ...filters, activity: v as Activity })}
      />
    );
  return (
    <Select
      options={[
        { label: "Last activity descending", value: "activity" },
        { label: "Total tokens descending", value: "tokens" },
        { label: "Requests descending", value: "requests" },
      ]}
      defaultValue={filters.sort}
      onChange={(v) => onApply({ ...filters, sort: v as SessionSort })}
    />
  );
}
