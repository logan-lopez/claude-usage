import React, { useEffect, useRef, useState } from "react";
import {
  Box,
  useApp,
  useFocus,
  useFocusManager,
  useInput,
  useWindowSize,
} from "ink";
import {
  TextInput,
  Select,
  Spinner,
  ThemeProvider,
  defaultTheme,
  extendTheme,
} from "@inkjs/ui";
import {
  FRESH_MS,
  type CostRow,
  type LimitReading,
  type SessionDetail,
  type SessionSort,
} from "../query.ts";
import type { doctor } from "../doctor.ts";
import {
  activities,
  activitySince,
  SessionBrowser,
  type Activity,
  type OverviewData,
  type TuiDependencies,
} from "./data.ts";
import {
  Row,
  Viewport,
  SessionTable,
  age,
  num,
  costLabel,
  wrap,
  palette,
} from "./components.tsx";
import {
  Overview,
  detailLines,
  panels,
  sections,
  dimensions,
} from "./screens.tsx";

type Filters = {
  search: string;
  project: string;
  model: string;
  activity: Activity;
  sort: SessionSort;
};
const initialFilters: Filters = {
  search: "",
  project: "",
  model: "",
  activity: "All",
  sort: "activity",
};
type Overlay =
  | "help"
  | "search"
  | "filters"
  | "project"
  | "model"
  | "activity"
  | "sort"
  | null;
export function App({
  deps,
  mono = false,
  dimensions: fixedDimensions,
  onQuit,
}: {
  deps: TuiDependencies;
  mono?: boolean;
  dimensions?: { columns: number; rows: number };
  onQuit?: () => void;
}) {
  const terminal = useWindowSize();
  const { columns: width, rows: terminalRows } = fixedDimensions ?? terminal;
  const height = Math.max(1, terminalRows - 6);
  const pageHeight = Math.max(1, height - 5);
  const { exit } = useApp();
  const focus = useFocusManager();
  useFocus({ id: "content", autoFocus: true });
  const [now, setNow] = useState(deps.now);
  const [data, setData] = useState<OverviewData | null>(null);
  const [diagnostics, setDiagnostics] = useState<Awaited<
    ReturnType<typeof doctor>
  > | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [screen, setScreen] = useState<"overview" | "sessions" | "detail">(
    "overview",
  );
  const origin = useRef<"overview" | "sessions">("overview");
  const [panel, setPanel] = useState(4);
  const [offsets, setOffsets] = useState([0, 0, 0, 0, 0]);
  const overviewRanges = useRef([0, 0, 0, 0, 0]);
  const [recentIndex, setRecentIndex] = useState(0);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const browser = useRef<SessionBrowser | null>(null);
  const [selection, setSelection] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [visible, setVisible] = useState<ReturnType<SessionBrowser["visible"]>>(
    [],
  );
  const [total, setTotal] = useState(0);
  const [costs, setCosts] = useState<Record<string, CostRow>>({});
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailCost, setDetailCost] = useState<CostRow>();
  const [section, setSection] = useState(0);
  const [dimension, setDimension] = useState(0);
  const [detailOffsets, setDetailOffsets] = useState<Record<string, number>>(
    {},
  );
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [draft, setDraft] = useState("");
  const [helpOffset, setHelpOffset] = useState(0);
  const [fetching, setFetching] = useState(false);
  const refreshBusy = useRef(false);
  const diagnosticBusy = useRef(false);
  const alive = useRef(true);
  const version = useRef<number | null>(null);
  const lastHour = useRef(Math.floor(deps.now() / 3_600_000));
  const quit = () => {
    alive.current = false;
    deps.cancelPending?.();
    onQuit?.();
    exit();
  };
  const currentId = browser.current?.row(selection)?.session_id;
  const selectedRecent = data?.recent[recentIndex]?.session_id;
  const detailKey = `${section}:${dimension}`;
  const lines = detail
    ? detailLines(detail, detailCost, section, dimension)
    : [{ text: "Session no longer available in the archive." }];
  const maxDetailOffset = Math.max(
    0,
    lines.flatMap((l) => wrap(l.text, width)).length - Math.max(1, height - 5),
  );
  function display(b: SessionBrowser, index: number, desiredScroll = scroll) {
    b.page(Math.max(0, index));
    index = Math.max(0, Math.min(index, b.total - 1));
    const start = Math.max(
      0,
      Math.min(
        index < desiredScroll
          ? index
          : index >= desiredScroll + pageHeight
            ? index - pageHeight + 1
            : desiredScroll,
        Math.max(0, b.total - 1),
      ),
    );
    const rows = b.visible(start, pageHeight);
    browser.current = b;
    setSelection(index);
    setScroll(start);
    setVisible(rows);
    setTotal(b.total);
    setCosts({ ...b.costs });
  }
  function newBrowser(f: Filters) {
    return new SessionBrowser(deps, {
      search: f.search,
      project: f.project || null,
      model: f.model || null,
      since: activitySince(f.activity, deps.now()),
      sort: f.sort,
    });
  }
  function applyFilters(next: Filters) {
    try {
      const b = newBrowser(next);
      display(b, 0, 0);
      setFilters(next);
      setError("");
    } catch {
      setError(
        "Archive read failed; last successful results retained (outdated).",
      );
    }
  }
  function reread() {
    try {
      const observedVersion = deps.version();
      const next = deps.overview();
      const b = newBrowser(filters);
      const index = b.locate(currentId, selection);
      const nextDetail = detail ? deps.detail(detail.session.session_id) : null;
      const nextCost = nextDetail
        ? deps.costs([nextDetail.session.session_id])[
            nextDetail.session.session_id
          ]
        : undefined;
      display(b, index);
      setData(next);
      setRecentIndex(
        Math.max(
          0,
          next.recent.findIndex((r) => r.session_id === selectedRecent),
        ),
      );
      if (screen === "detail") {
        setDetail(nextDetail);
        setDetailCost(nextCost);
      }
      setError("");
      version.current = observedVersion;
    } catch {
      setError(
        "Archive unreadable; last successful data retained (outdated). Run cusage sync or check --db.",
      );
    }
  }
  async function diagnose() {
    if (diagnosticBusy.current) return;
    diagnosticBusy.current = true;
    try {
      const result = await deps.diagnostics();
      if (alive.current) setDiagnostics(result);
    } catch {
      if (alive.current)
        setNotice("Diagnostics failed; previous checks retained.");
    } finally {
      diagnosticBusy.current = false;
    }
  }
  async function refresh() {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    setFetching(true);
    try {
      const result = await deps.refresh();
      if (!alive.current) return;
      setNotice(
        result.ok
          ? "Limits refreshed."
          : result.reason === "guard"
            ? `Refresh guarded; retry after ${new Date(deps.now() + (result.waitMs ?? 0)).toISOString()}`
            : result.reason === "disabled"
              ? "Refresh disabled by CUSAGE_REFRESH=off."
              : `Refresh ${result.reason}: ${result.error ?? "archived limits retained"}`,
      );
      if (result.ok) actions.current.reread();
    } catch {
      if (alive.current) setNotice("Refresh failed; archived limits retained.");
    } finally {
      refreshBusy.current = false;
      if (alive.current) setFetching(false);
    }
  }
  const actions = useRef({ reread, diagnose, refresh });
  actions.current = { reread, diagnose, refresh };
  useEffect(() => {
    alive.current = true;
    const first = setTimeout(() => {
      if (!alive.current) return;
      actions.current.reread();
      void actions.current.diagnose();
    }, 0);
    const poll = setInterval(() => {
      if (!alive.current) return;
      try {
        const next = deps.version();
        const hour = Math.floor(deps.now() / 3_600_000);
        if (next !== version.current || hour !== lastHour.current) {
          actions.current.reread();
          lastHour.current = hour;
        }
      } catch {
        setError("Archive poll failed; data is outdated. r retries.");
      }
    }, deps.pollMs);
    const clock = setInterval(() => {
      if (alive.current) setNow(deps.now());
    }, 1000);
    return () => {
      alive.current = false;
      deps.cancelPending?.();
      clearTimeout(first);
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [deps]);
  useEffect(() => {
    if (browser.current)
      try {
        display(browser.current, selection);
      } catch {
        setError("Could not read the next page; previous results retained.");
      }
  }, [pageHeight]);
  useEffect(() => {
    if (overlay) focus.disableFocus();
    else {
      focus.enableFocus();
      focus.focus("content");
    }
  }, [overlay]);
  function openSession(id: string | undefined) {
    if (!id) return;
    try {
      const d = deps.detail(id);
      if (!d) {
        setNotice("Selected session is no longer available. r rereads.");
        return;
      }
      setDetail(d);
      setDetailCost(deps.costs([id])[id]);
      origin.current = screen === "sessions" ? "sessions" : "overview";
      setSection(0);
      setDimension(0);
      setDetailOffsets({});
      setScreen("detail");
    } catch {
      setError("Session read failed; browsing state retained.");
    }
  }
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      quit();
      return;
    }
    if (width < 80 || terminalRows < 24) {
      if (input === "q") quit();
      return;
    }
    if (overlay) {
      if (key.escape) {
        setOverlay(null);
        return;
      }
      if (overlay === "help") {
        const delta = key.pageDown
          ? height - 2
          : key.pageUp
            ? -(height - 2)
            : key.downArrow || input === "j"
              ? 1
              : key.upArrow || input === "k"
                ? -1
                : 0;
        setHelpOffset((n) =>
          Math.max(
            0,
            Math.min(helpMax, key.home ? 0 : key.end ? helpMax : n + delta),
          ),
        );
      }
      return;
    }
    if (input === "q") {
      quit();
      return;
    }
    if (input === "?") {
      setHelpOffset(0);
      setOverlay("help");
      return;
    }
    if (input === "r") {
      reread();
      void diagnose();
      setNotice("Archive reread; no ingestion or limit fetch.");
      return;
    }
    if (input === "R") {
      void refresh();
      return;
    }
    if (input === "1" || input === "2") {
      setScreen(input === "1" ? "overview" : "sessions");
      return;
    }
    if (key.escape && screen === "detail") {
      setScreen(origin.current);
      return;
    }
    if (key.tab) {
      const d = key.shift ? -1 : 1;
      if (screen === "overview") setPanel((p) => (p + d + 5) % 5);
      if (screen === "detail") setSection((s) => (s + d + 5) % 5);
      return;
    }
    if (screen === "sessions") {
      if (input === "/") {
        setDraft(filters.search);
        setOverlay("search");
        return;
      }
      if (input === "f") {
        setOverlay("filters");
        return;
      }
      if (input === "s") {
        setOverlay("sort");
        return;
      }
    }
    if (screen === "detail" && (key.leftArrow || key.rightArrow)) {
      if (section === 2)
        setDimension((d) => (d + (key.leftArrow ? -1 : 1) + 5) % 5);
      else setSection((s) => (s + (key.leftArrow ? -1 : 1) + 5) % 5);
      return;
    }
    if (key.return) {
      if (screen === "sessions") openSession(currentId);
      else if (screen === "overview" && panel === 4)
        openSession(selectedRecent);
      return;
    }
    const step = key.pageDown
      ? pageHeight
      : key.pageUp
        ? -pageHeight
        : key.downArrow || input === "j"
          ? 1
          : key.upArrow || input === "k"
            ? -1
            : 0;
    if (!step && !key.home && !key.end) return;
    if (screen === "sessions" && browser.current) {
      try {
        display(
          browser.current,
          key.home ? 0 : key.end ? total - 1 : selection + step,
        );
      } catch {
        setError("Page read failed; last successful results retained.");
      }
    }
    if (screen === "overview") {
      if (panel === 4)
        setRecentIndex((n) =>
          Math.max(
            0,
            Math.min(
              (data?.recent.length ?? 1) - 1,
              key.home
                ? 0
                : key.end
                  ? (data?.recent.length ?? 1) - 1
                  : n + step,
            ),
          ),
        );
      else
        setOffsets((o) =>
          o.map((n, i) =>
            i === panel
              ? Math.max(
                  0,
                  Math.min(
                    overviewRanges.current[panel] ?? 0,
                    key.home
                      ? 0
                      : key.end
                        ? (overviewRanges.current[panel] ?? 0)
                        : Math.min(n, overviewRanges.current[panel] ?? 0) +
                          step,
                  ),
                )
              : n,
          ),
        );
    }
    if (screen === "detail")
      setDetailOffsets((o) => ({
        ...o,
        [detailKey]: Math.max(
          0,
          Math.min(
            maxDetailOffset,
            key.home
              ? 0
              : key.end
                ? maxDetailOffset
                : (o[detailKey] ?? 0) + step,
          ),
        ),
      }));
  });
  const options = (values: readonly string[]) =>
    values.map((value) => ({ label: value, value }));
  const closeApply = (next: Filters) => {
    applyFilters(next);
    setOverlay(null);
  };
  const help = [
    `${screen === "detail" ? "Session Detail" : screen === "sessions" ? "Sessions" : `Overview · ${panels[panel]}`} help`,
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
  ].map((text) => ({ text }));
  const helpMax = Math.max(
    0,
    help.flatMap((l) => wrap(l.text, width)).length - height + 1,
  );
  const theme = extendTheme(defaultTheme, {
    components: {
      Select: {
        styles: {
          focusIndicator: () => ({ color: mono ? undefined : palette.accent }),
          selectedIndicator: () => ({ color: mono ? undefined : palette.ok }),
          label: ({ isFocused, isSelected }: any) => ({
            color: mono
              ? undefined
              : isFocused
                ? palette.accent
                : isSelected
                  ? palette.ok
                  : palette.text,
            bold: isFocused,
          }),
        },
      },
    },
  });
  let content: React.ReactNode;
  if (overlay === "help")
    content = (
      <Viewport
        lines={help}
        offset={helpOffset}
        width={width}
        height={height}
        mono={mono}
      />
    );
  else if (overlay === "search" || overlay === "project" || overlay === "model")
    content = (
      <Box flexDirection="column">
        <Row
          text={`${overlay}: ${overlay === "search" ? "session ID or name" : "case-insensitive contains"} · Enter applies · Esc cancels`}
          width={width}
          mono={mono}
        />
        <TextInput
          key={overlay}
          defaultValue={draft}
          onChange={setDraft}
          onSubmit={(value) => closeApply({ ...filters, [overlay]: value })}
        />
      </Box>
    );
  else if (overlay === "filters")
    content = (
      <Box flexDirection="column">
        <Row
          text="Filters choose sessions; amounts remain whole-session totals."
          width={width}
          mono={mono}
        />
        <Select
          options={options(["Project", "Model", "Activity", "Clear all"])}
          onChange={(v) => {
            if (v === "Clear all") {
              closeApply({ ...initialFilters, sort: filters.sort });
              return;
            }
            const kind = v.toLowerCase() as "project" | "model" | "activity";
            setDraft(kind === "activity" ? "" : filters[kind]);
            setOverlay(kind);
          }}
        />
      </Box>
    );
  else if (overlay === "activity")
    content = (
      <Select
        options={options(activities)}
        defaultValue={filters.activity}
        onChange={(v) => closeApply({ ...filters, activity: v as Activity })}
      />
    );
  else if (overlay === "sort")
    content = (
      <Select
        options={[
          { label: "Last activity descending", value: "activity" },
          { label: "Total tokens descending", value: "tokens" },
          { label: "Requests descending", value: "requests" },
        ]}
        defaultValue={filters.sort}
        onChange={(v) => closeApply({ ...filters, sort: v as SessionSort })}
      />
    );
  else if (!data)
    content = error ? (
      <Row text={error} width={width} mono={mono} tone="warning" />
    ) : (
      <Spinner label="Reading archive…" />
    );
  else if (screen === "overview")
    content = (
      <Overview
        data={data}
        diagnostics={diagnostics}
        now={now}
        width={width}
        height={height}
        panel={panel}
        offsets={offsets}
        onRange={(p, max) => {
          overviewRanges.current[p] = max;
        }}
        selected={selectedRecent}
        mono={mono}
      />
    );
  else if (screen === "sessions")
    content = (
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
          text={`${total} matching · ${total ? scroll + 1 : 0}–${Math.min(total, scroll + visible.length)} visible`}
          width={width}
          mono={mono}
          tone="muted"
        />
        {total ? (
          <SessionTable
            rows={visible}
            costs={costs}
            selected={currentId}
            width={width}
            height={height - 3}
            now={now}
            mono={mono}
          />
        ) : (
          <Row
            text={
              data.inventory.requests
                ? "No matching sessions. f clears filters."
                : "Archive is empty. Run cusage sync."
            }
            width={width}
            mono={mono}
          />
        )}
      </Box>
    );
  else
    content = (
      <Box flexDirection="column">
        <Row
          text={`Session: ${detail?.session.slug ?? detail?.session.session_id ?? "unavailable"} / ${detail?.session.project ?? "—"}`}
          width={width}
          mono={mono}
          tone="accent"
        />
        <Row
          text={`${num(detail?.session.requests ?? 0)} requests · ${num(detail?.session.total_tokens ?? 0)} tokens · ${costLabel(detailCost)} whole-session`}
          width={width}
          mono={mono}
        />
        <Row
          text={
            sections
              .map((s, i) => `${i === section ? "▸" : ""}${s}`)
              .join("  ") + (section === 2 ? ` · ${dimensions[dimension]}` : "")
          }
          width={width}
          mono={mono}
          tone="muted"
        />
        <Viewport
          lines={lines}
          offset={detailOffsets[detailKey] ?? 0}
          width={width}
          height={height - 3}
          mono={mono}
        />
      </Box>
    );
  if (width < 80 || terminalRows < 24)
    return (
      <Box width={width} height={terminalRows} flexDirection="column">
        <Row
          text="Resize to at least 80×24. q / Ctrl+C quit."
          width={width}
          mono={mono}
        />
      </Box>
    );
  const binding = data?.limits?.binding;
  const bAge = binding ? now - binding.tsMs : 0;
  const header = binding
    ? `${age(binding.tsMs, now)}${bAge > FRESH_MS ? " · STALE" : ""} · ${binding.source} · ${binding.percent ?? "—"}% ${binding.kind} ${binding.scope_model || "all"}`
    : "Binding limit unavailable";
  const meter = (r: LimitReading | null) =>
    r
      ? `${r.percent ?? "—"}% ${age(r.tsMs, now)}${now - r.tsMs > FRESH_MS ? " STALE" : ""}`
      : "unavailable";
  return (
    <Box
      width={width}
      height={terminalRows}
      flexDirection="column"
      overflow="hidden"
    >
      <Row
        text={`cusage ▸ ${header}`}
        width={width}
        mono={mono}
        tone={bAge > FRESH_MS ? "warning" : "text"}
      />
      <Row
        text={`5h ${meter(data?.limits?.fiveHour ?? null)} · 7d ${meter(data?.limits?.sevenDay ?? null)} · ${num(data?.inventory.totals.total_tokens ?? 0)} tokens · ${num(data?.inventory.sessions ?? 0)} sessions`}
        width={width}
        mono={mono}
        tone="muted"
      />
      <Row
        text={`${screen === "overview" ? "▸" : " "} 1 Overview    ${screen === "sessions" ? "▸" : " "} 2 Sessions${screen === "detail" ? "    ▸ Session Detail" : ""}`}
        width={width}
        mono={mono}
        tone="accent"
      />
      <Box
        height={height}
        flexShrink={0}
        flexDirection="column"
        overflow="hidden"
      >
        <ThemeProvider theme={theme}>{content}</ThemeProvider>
      </Box>
      {fetching ? (
        <Spinner label="Fetching limits; archived readings retained…" />
      ) : (
        <Row
          text={
            error ||
            notice ||
            "Archive browser · ~ estimate · + partial · ? explains provenance"
          }
          width={width}
          mono={mono}
          tone={error ? "warning" : "muted"}
        />
      )}
      <Row
        text={
          overlay
            ? "Enter apply · Esc close/cancel · Ctrl+C quit"
            : screen === "detail"
              ? "Tab section · ←→ attribution · ↑↓ scroll · Esc back · r reread · R fetch · ? help · q quit"
              : screen === "sessions"
                ? "↑↓ select · Enter open · / search · f filters · s sort · r reread · R fetch · ? help · q quit"
                : "1/2 tabs · Tab panel · ↑↓ scroll/select · Enter open · r reread · R fetch · ? help · q quit"
        }
        width={width}
        mono={mono}
        tone="muted"
      />
    </Box>
  );
}
