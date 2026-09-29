/** Shell: header, tabs, status and key hints around the active screen or overlay. */
import React, { useRef, useState } from "react";
import { Box, useApp, useInput, useWindowSize } from "ink";
import { Spinner, ThemeProvider, defaultTheme, extendTheme } from "@inkjs/ui";
import type { LimitReading } from "../query.ts";
import type { OverviewData, TuiDependencies } from "./data.ts";
import { Row, palette } from "./components.tsx";
import { age, isStale, num } from "./text.ts";
import { useArchive } from "./useArchive.ts";
import { Overview, initialOverviewNav, panels } from "./overview.tsx";
import {
  SessionOverlayView,
  SessionsScreen,
  useSessions,
  type SessionOverlay,
} from "./sessions.tsx";
import { DetailScreen, useDetail } from "./detail.tsx";
import { Help } from "./help.tsx";
import { KeyTarget, type KeyHandler } from "./keys.ts";

type Screen = "overview" | "sessions" | "detail";
type Overlay = "help" | SessionOverlay | null;

/** Header (3 rows) and footer (2 rows) around the content, plus one spare. */
const CHROME_ROWS = 6;
const MIN_COLUMNS = 80;
const MIN_ROWS = 24;

const theme = (mono: boolean) =>
  extendTheme(defaultTheme, {
    components: {
      Select: {
        styles: {
          focusIndicator: () => ({ color: mono ? undefined : palette.accent }),
          selectedIndicator: () => ({ color: mono ? undefined : palette.ok }),
          label: ({ isFocused, isSelected }: { isFocused: boolean; isSelected: boolean }) => ({
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
const themes = { color: theme(false), mono: theme(true) };

const HINTS: Record<Screen, string> = {
  overview:
    "1/2 tabs · Tab panel · ↑↓ scroll/select · Enter open · r reread · R fetch · ? help · q quit",
  sessions:
    "↑↓ select · Enter open · / search · f filters · s sort · r reread · R fetch · ? help · q quit",
  detail:
    "Tab section · ←→ attribution · ↑↓ scroll · Esc back · r reread · R fetch · ? help · q quit",
};

export function App({
  deps,
  mono = false,
  dimensions,
  onQuit,
}: {
  deps: TuiDependencies;
  mono?: boolean;
  dimensions?: { columns: number; rows: number };
  onQuit?: () => void;
}) {
  const terminal = useWindowSize();
  const { columns: width, rows } = dimensions ?? terminal;
  const undersized = width < MIN_COLUMNS || rows < MIN_ROWS;
  const height = Math.max(1, rows - CHROME_ROWS);
  const pageHeight = Math.max(1, height - 5);
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("overview");
  const [origin, setOrigin] = useState<"overview" | "sessions">("overview");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [overviewNav, setOverviewNav] = useState(initialOverviewNav);
  const archive = useArchive(deps, () => {
    sessions.reload();
    if (screen === "detail") detail.reload();
  });
  const sessions = useSessions(deps, pageHeight, archive.report);
  const detail = useDetail(deps, archive.report);
  const { data, now } = archive;
  const keys = useRef<KeyHandler | null>(null);

  const quit = () => {
    archive.close();
    onQuit?.();
    exit();
  };
  const open = (id: string | undefined) => {
    if (!detail.open(id)) return;
    setOrigin(screen === "sessions" ? "sessions" : "overview");
    setScreen("detail");
  };

  // Global keys first; the rest go to the active screen or help (see useKeys).
  // Text inputs and selects in overlays read the keyboard themselves.
  useInput((input, key) => {
    if (key.ctrl && input === "c") return quit();
    if (undersized) {
      if (input === "q") quit();
      return;
    }
    if (overlay) {
      if (key.escape) return setOverlay(null);
      return keys.current?.(input, key);
    }
    if (input === "q") return quit();
    if (input === "?") return setOverlay("help");
    if (input === "r") return archive.reread();
    if (input === "R") return archive.refresh();
    if (input === "1") return setScreen("overview");
    if (input === "2") return setScreen("sessions");
    keys.current?.(input, key);
  });

  if (undersized)
    return (
      <Box width={width} height={rows} flexDirection="column">
        <Row
          text={`Resize to at least ${MIN_COLUMNS}×${MIN_ROWS}. q / Ctrl+C quit.`}
          width={width}
          mono={mono}
        />
      </Box>
    );

  let content: React.ReactNode;
  if (overlay === "help")
    content = (
      <Help
        title={
          screen === "detail"
            ? "Session Detail"
            : screen === "sessions"
              ? "Sessions"
              : `Overview · ${panels[overviewNav.panel]}`
        }
        width={width}
        height={height}
        mono={mono}
      />
    );
  else if (overlay)
    content = (
      <SessionOverlayView
        overlay={overlay}
        filters={sessions.filters}
        width={width}
        mono={mono}
        onOverlay={setOverlay}
        onApply={(next) => {
          sessions.apply(next);
          setOverlay(null);
        }}
      />
    );
  else if (!data)
    content = archive.error ? (
      <Row text={archive.error} width={width} mono={mono} tone="warning" />
    ) : (
      <Spinner label="Reading archive…" />
    );
  else if (screen === "overview")
    content = (
      <Overview
        data={data}
        diagnostics={archive.diagnostics}
        now={now}
        width={width}
        height={height}
        nav={overviewNav}
        setNav={setOverviewNav}
        mono={mono}
        onOpen={open}
      />
    );
  else if (screen === "sessions")
    content = (
      <SessionsScreen
        sessions={sessions}
        archiveEmpty={!data.inventory.requests}
        width={width}
        height={height}
        pageHeight={pageHeight}
        now={now}
        mono={mono}
        onOpen={open}
        onOverlay={setOverlay}
      />
    );
  else
    content = (
      <DetailScreen
        detail={detail}
        width={width}
        height={height}
        mono={mono}
        onBack={() => setScreen(origin)}
      />
    );

  return (
    <Box width={width} height={rows} flexDirection="column" overflow="hidden">
      <Header data={data} now={now} width={width} mono={mono} />
      <Row
        text={`${screen === "overview" ? "▸" : " "} 1 Overview    ${screen === "sessions" ? "▸" : " "} 2 Sessions${screen === "detail" ? "    ▸ Session Detail" : ""}`}
        width={width}
        mono={mono}
        tone="accent"
      />
      <Box height={height} flexShrink={0} flexDirection="column" overflow="hidden">
        <KeyTarget.Provider value={keys}>
          <ThemeProvider theme={mono ? themes.mono : themes.color}>{content}</ThemeProvider>
        </KeyTarget.Provider>
      </Box>
      {archive.fetching ? (
        <Spinner label="Fetching limits; archived readings retained…" />
      ) : (
        <Row
          text={
            archive.error ||
            archive.notice ||
            "Archive browser · ~ estimate · + partial · ? explains provenance"
          }
          width={width}
          mono={mono}
          tone={archive.error ? "warning" : "muted"}
        />
      )}
      <Row
        text={overlay ? "Enter apply · Esc close/cancel · Ctrl+C quit" : HINTS[screen]}
        width={width}
        mono={mono}
        tone="muted"
      />
    </Box>
  );
}

/** Binding limit first, then both meters and archive totals; every reading carries its age. */
function Header({
  data,
  now,
  width,
  mono,
}: {
  data: OverviewData | null;
  now: number;
  width: number;
  mono: boolean;
}) {
  const binding = data?.limits?.binding;
  const stale = binding ? isStale(binding.tsMs, now) : false;
  const meter = (r: LimitReading | null | undefined) =>
    r
      ? `${r.percent ?? "—"}% ${age(r.tsMs, now)}${isStale(r.tsMs, now) ? " STALE" : ""}`
      : "unavailable";
  return (
    <>
      <Row
        text={`cusage ▸ ${
          binding
            ? `${age(binding.tsMs, now)}${stale ? " · STALE" : ""} · ${binding.source} · ${binding.percent ?? "—"}% ${binding.kind} ${binding.scope_model || "all"}`
            : "Binding limit unavailable"
        }`}
        width={width}
        mono={mono}
        tone={stale ? "warning" : "text"}
      />
      <Row
        text={`5h ${meter(data?.limits?.fiveHour)} · 7d ${meter(data?.limits?.sevenDay)} · ${num(data?.inventory.totals.total_tokens ?? 0)} tokens · ${num(data?.inventory.sessions ?? 0)} sessions`}
        width={width}
        mono={mono}
        tone="muted"
      />
    </>
  );
}
