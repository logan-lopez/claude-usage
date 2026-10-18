/** Shell: header, tabs, status and key hints around the active screen or help. */
import React, { useRef, useState } from "react";
import { Box, useApp, useInput, useWindowSize } from "ink";
import { Spinner, ThemeProvider, defaultTheme, extendTheme } from "@inkjs/ui";
import type { LimitReading } from "../query.ts";
import type { OverviewData, TuiDependencies } from "./data.ts";
import { PaletteContext, Row } from "./components.tsx";
import { MONO, palettes, type Palette, type ThemeName } from "./theme.ts";
import { age, isStale, num } from "./text.ts";
import { useArchive } from "./useArchive.ts";
import { useOverviewScreen } from "./overview.tsx";
import { useSessionsScreen } from "./sessions.tsx";
import { useDetailScreen } from "./detail.tsx";
import { Help } from "./help.tsx";
import { KeyTarget, type KeyHandler } from "./keys.ts";
import { MIN_COLUMNS, MIN_ROWS, contentHeight } from "./layout.ts";
import { TABS, type ScreenId, type ScreenModel, type TabId } from "./screen.ts";

/** `MONO` has no colour overrides, so the terminal's own styling applies. */
const theme = (palette: Palette) =>
  extendTheme(defaultTheme, {
    components: {
      Select: {
        styles: {
          focusIndicator: () => ({ color: palette.accent }),
          selectedIndicator: () => ({ color: palette.ok }),
          label: ({ isFocused, isSelected }: { isFocused: boolean; isSelected: boolean }) => ({
            color: isFocused
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
const themes = { dark: theme(palettes.dark), light: theme(palettes.light), mono: theme(MONO) };

const isTab = (id: ScreenId): id is TabId => TABS.some((t) => t.id === id);

export function App({
  deps,
  mono = false,
  theme: themeName = "dark",
  themeNote,
  dimensions,
  onQuit,
}: {
  deps: TuiDependencies;
  mono?: boolean;
  theme?: ThemeName;
  /** Which theme was chosen and why; shown in help so a wrong detection is diagnosable. */
  themeNote?: string;
  dimensions?: { columns: number; rows: number };
  onQuit?: () => void;
}) {
  const terminal = useWindowSize();
  const { columns: width, rows } = dimensions ?? terminal;
  const undersized = width < MIN_COLUMNS || rows < MIN_ROWS;
  const height = contentHeight(rows);
  const palette = mono ? MONO : palettes[themeName];
  const { exit } = useApp();
  const [screen, setScreen] = useState<ScreenId>(TABS[0].id);
  const [origin, setOrigin] = useState<TabId>(TABS[0].id);
  const [help, setHelp] = useState(false);
  const keys = useRef<KeyHandler | null>(null);
  // The models of the last render; an archive change reloads every one of them.
  const models = useRef<ScreenModel[]>([]);
  const archive = useArchive(deps, () => {
    for (const model of models.current) model.reload?.();
  });
  const { data, now, report } = archive;

  const detail = useDetailScreen({ deps, report, back: () => setScreen(origin) });
  const open = (id: string | undefined) => {
    if (!detail.open(id)) return;
    if (isTab(screen)) setOrigin(screen);
    setScreen("detail");
  };
  const overview = useOverviewScreen({ open });
  const sessions = useSessionsScreen({ deps, report, height, open });
  const screens: Record<ScreenId, ScreenModel> = { overview, sessions, detail };
  models.current = Object.values(screens);
  const current = screens[screen];

  const quit = () => {
    archive.close();
    onQuit?.();
    exit();
  };

  // Global keys first; the rest go to the active screen or help (see useKeys).
  // Text inputs and selects in overlays read the keyboard themselves.
  useInput((input, key) => {
    if (key.ctrl && input === "c") return quit();
    if (undersized) {
      if (input === "q") quit();
      return;
    }
    if (help) {
      if (key.escape) return setHelp(false);
      return keys.current?.(input, key);
    }
    if (current.overlay) {
      if (key.escape) return current.closeOverlay?.();
      return keys.current?.(input, key);
    }
    if (input === "q") return quit();
    if (input === "?") return setHelp(true);
    if (input === "r") return archive.reread();
    if (input === "R") return archive.refresh();
    const tab = TABS.find((t) => t.key === input);
    if (tab) return setScreen(tab.id);
    keys.current?.(input, key);
  });

  if (undersized)
    return (
      <PaletteContext.Provider value={palette}>
        <Box width={width} height={rows} flexDirection="column">
          <Row
            text={`Resize to at least ${MIN_COLUMNS}×${MIN_ROWS}. q / Ctrl+C quit.`}
            width={width}
          />
        </Box>
      </PaletteContext.Provider>
    );

  const content = help ? (
    <Help
      title={`${current.title}${current.context ? ` · ${current.context}` : ""}`}
      lines={current.help}
      tabs={TABS.map((t) => `${t.key} ${screens[t.id].title}`).join(" · ")}
      width={width}
      height={height}
      themeNote={themeNote}
    />
  ) : !data ? (
    archive.error ? (
      <Row text={archive.error} width={width} tone="warning" />
    ) : (
      <Spinner label="Reading archive…" />
    )
  ) : (
    current.render({ width, height, now, data, diagnostics: archive.diagnostics })
  );
  const tabs = TABS.map((t) => `${t.id === screen ? "▸" : " "} ${t.key} ${screens[t.id].title}`);
  if (!isTab(screen)) tabs.push(`▸ ${current.title}`);

  return (
    <PaletteContext.Provider value={palette}>
      <Box width={width} height={rows} flexDirection="column" overflow="hidden">
        <Header data={data} failed={!!archive.error} now={now} width={width} />
        <Row text={tabs.join("    ")} width={width} tone="accent" />
        <Box height={height} flexShrink={0} flexDirection="column" overflow="hidden">
          <KeyTarget.Provider value={keys}>
            <ThemeProvider theme={mono ? themes.mono : themes[themeName]}>{content}</ThemeProvider>
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
            tone={archive.error ? "warning" : "muted"}
          />
        )}
        <Row
          text={
            help
              ? "↑↓ scroll · Esc close · Ctrl+C quit"
              : current.overlay
                ? "Enter apply · Esc close/cancel · Ctrl+C quit"
                : current.hints
          }
          width={width}
          tone="muted"
        />
      </Box>
    </PaletteContext.Provider>
  );
}

/**
 * Binding limit first, then both meters and archive totals; every reading carries its age. Until
 * the first read lands there are no totals to show, so it says so rather than showing zeros.
 */
function Header({
  data,
  failed,
  now,
  width,
}: {
  data: OverviewData | null;
  /** The last read failed; with no data yet, the header says so instead of "Reading archive…". */
  failed: boolean;
  now: number;
  width: number;
}) {
  if (!data)
    return (
      <>
        <Row
          text={`cusage ▸ ${failed ? "Archive not read yet" : "Reading archive…"}`}
          width={width}
        />
        {/* A Text holding "" renders no row at all. */}
        <Row text=" " width={width} />
      </>
    );
  const binding = data.limits?.binding;
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
        tone={stale ? "warning" : "text"}
      />
      <Row
        text={`5h ${meter(data.limits?.fiveHour)} · 7d ${meter(data.limits?.sevenDay)} · ${num(data.inventory.totals.total_tokens)} tokens · ${num(data.inventory.sessions)} sessions`}
        width={width}
        tone="muted"
      />
    </>
  );
}
