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
import { tableBodyRows } from "./layout.ts";
import type { ScreenModel } from "./screen.ts";
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
/** The input or select that replaces the table while it owns the keyboard. */
type Editor = "search" | "filters" | "project" | "model" | "activity" | "sort";

/** The search, filter and count rows above the table. */
const FILTER_ROWS = 3;
/** Table body rows on a Sessions screen of `height`: what one page fetches and PageDown moves. */
const sessionRows = (height: number) => tableBodyRows(height - FILTER_ROWS);

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

/** Sessions' model: paged browsing state, plus the editor overlays it owns. */
export function useSessionsScreen({
  deps,
  report,
  height,
  open,
}: {
  deps: TuiDependencies;
  report: Report;
  height: number;
  open: (id: string | undefined) => void;
}): ScreenModel {
  const list = useSessions(deps, sessionRows(height), report);
  const [editor, setEditor] = useState<Editor | null>(null);
  return {
    title: "Sessions",
    hints:
      "↑↓ select · Enter open · / search · f filters · s sort · r reread · R fetch · ? help · q quit",
    help: [],
    reload: list.reload,
    overlay: editor !== null,
    closeOverlay: () => setEditor(null),
    render: (frame) =>
      editor ? (
        <FilterEditor
          editor={editor}
          filters={list.filters}
          width={frame.width}
          onEditor={setEditor}
          onApply={(next) => {
            list.apply(next);
            setEditor(null);
          }}
        />
      ) : (
        <SessionsScreen
          sessions={list}
          archiveEmpty={!frame.data.inventory.requests}
          width={frame.width}
          height={frame.height}
          now={frame.now}
          onOpen={open}
          onEditor={setEditor}
        />
      ),
  };
}

function useSessions(
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
type Sessions = ReturnType<typeof useSessions>;

function SessionsScreen({
  sessions,
  archiveEmpty,
  width,
  height,
  now,
  onOpen,
  onEditor,
}: {
  sessions: Sessions;
  archiveEmpty: boolean;
  width: number;
  height: number;
  now: number;
  onOpen: (id: string | undefined) => void;
  onEditor: (editor: Editor) => void;
}) {
  const { filters, view } = sessions;
  useKeys((input, key) => {
    if (input === "/") return onEditor("search");
    if (input === "f") return onEditor("filters");
    if (input === "s") return onEditor("sort");
    if (key.return) return onOpen(sessions.selected());
    const to = movement(input, key, sessionRows(height));
    if (to) sessions.move(to);
  });
  return (
    <Box flexDirection="column">
      <Row
        text={`Search: ${filters.search || "—"} · project: ${filters.project || "All"} · model: ${filters.model || "All"}`}
        width={width}
      />
      <Row
        text={`${filters.activity} · sort ${filters.sort} ↓ · Filters select sessions; whole-session totals.`}
        width={width}
        tone="muted"
      />
      <Row
        text={`${view.total} matching · ${view.total ? view.scroll + 1 : 0}–${Math.min(view.total, view.scroll + view.rows.length)} visible`}
        width={width}
        tone="muted"
      />
      {view.total ? (
        <SessionTable
          rows={view.rows}
          costs={view.costs}
          selected={selectedId(view)}
          width={width}
          height={height - FILTER_ROWS}
          now={now}
        />
      ) : (
        <Row
          text={
            archiveEmpty
              ? "Archive is empty. Run cusage sync."
              : "No matching sessions. f clears filters."
          }
          width={width}
        />
      )}
    </Box>
  );
}

const options = (values: readonly string[]) =>
  values.map((value) => ({ label: value, value }));

/** Editors own the keyboard; Esc (handled by the shell) cancels without applying. */
function FilterEditor({
  editor: overlay,
  filters,
  width,
  onApply,
  onEditor,
}: {
  editor: Editor;
  filters: Filters;
  width: number;
  onApply: (next: Filters) => void;
  onEditor: (editor: Editor) => void;
}) {
  if (overlay === "search" || overlay === "project" || overlay === "model")
    return (
      <Box flexDirection="column">
        <Row
          text={`${overlay}: ${overlay === "search" ? "session ID or name" : "case-insensitive contains"} · Enter applies · Esc cancels`}
          width={width}
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
        />
        <Select
          options={options(["Project", "Model", "Activity", "Clear all"])}
          onChange={(v) =>
            v === "Clear all"
              ? onApply({ ...initialFilters, sort: filters.sort })
              : onEditor(v.toLowerCase() as "project" | "model" | "activity")
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
