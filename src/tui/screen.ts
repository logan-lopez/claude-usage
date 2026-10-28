/** The contract between the shell and its screens. No rendering here. */
import type React from "react";
import type { Diagnostics, OverviewData } from "./data.ts";

/** What the shell needs from one screen. Its hook rebuilds it each render. */
export interface ScreenModel {
  /** The tab bar label and the help heading. */
  title: string;
  /** Appended to the help heading, e.g. Overview's focused panel. */
  context?: string;
  /** Footer key hints while no overlay is open. */
  hints: string;
  /** This screen's lines for `?`: its keys, and what its marks mean. */
  help: string[];
  /**
   * Rereads after an archive change, keeping browsing state. The shell calls it only while the
   * screen is showing, or just before it's shown again after a change passed it by.
   */
  reload?: () => void;
  /** True while this screen's own input or select owns the keyboard. */
  overlay: boolean;
  closeOverlay?: () => void;
  render: (frame: Frame) => React.ReactNode;
}

export type Frame = {
  width: number;
  height: number;
  now: number;
  data: OverviewData;
  diagnostics: Diagnostics | null;
};

/** Digit keys follow this order. A drilled Sessions list and Detail are pushed, not tabs. */
export const TABS = [
  { id: "overview", key: "1" },
  { id: "sessions", key: "2" },
  { id: "breakdown", key: "3" },
  { id: "timeline", key: "4" },
  { id: "limits", key: "5" },
] as const;
export type TabId = (typeof TABS)[number]["id"];
export type ScreenId = TabId | "drill" | "detail";

/** The digit keys, for a hint: `1/2/3`. */
export const tabKeys = TABS.map((t) => t.key).join("/");
