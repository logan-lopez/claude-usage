/** Shared harness for the TUI tests: a fixture-backed archive, a mounted App, and timing helpers. */
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { freshDb } from "../helpers.ts";
import { App } from "../../src/tui/App.tsx";
import { readBreakdown, readLimits, readOverview, readTimeline, type TuiDependencies } from "../../src/tui/data.ts";
import { sessionPage, sessionCosts, getSession } from "../../src/query.ts";
import type { RefreshOutcome } from "../../src/limits.ts";

export const NOW = Date.UTC(2026, 8, 11, 16);
export const outcome: RefreshOutcome = {
  mode: "force",
  attempted: false,
  ok: false,
  reason: "guard",
  ageMs: 0,
  waitMs: 180000,
  tsMs: NOW,
  tokenSource: null,
  httpStatus: null,
  error: null,
};
export const closers: (() => void)[] = [];
/** Each test file registers this with `afterEach`. */
export function teardown() {
  cleanup();
  for (const close of closers.splice(0)) close();
}
export function dependencies() {
  const db = freshDb();
  closers.push(() => db.close());
  const counts = { overview: 0, diagnostics: 0, refresh: 0, version: 0, breakdown: 0, timeline: 0, limits: 0 };
  let version = 1;
  let now = NOW;
  const deps: TuiDependencies = {
    now: () => now,
    overview: () => {
      counts.overview++;
      return readOverview(db, now);
    },
    page: (opts) => sessionPage(db, opts),
    costs: (ids) => sessionCosts(db, ids),
    detail: (id) => getSession(db, id),
    breakdown: (by, opts) => {
      counts.breakdown++;
      return readBreakdown(db, by, opts);
    },
    timeline: (bucket, by) => {
      counts.timeline++;
      return readTimeline(db, bucket, by, now);
    },
    limits: (since, bucketMs) => {
      counts.limits++;
      return readLimits(db, since, bucketMs, now);
    },
    version: () => {
      counts.version++;
      return version;
    },
    pollMs: 40,
    diagnostics: async () => {
      counts.diagnostics++;
      return {
        checkedAt: now,
        build: {} as any,
        repo: "fixture",
        checks: [{ name: "integrity", level: "ok", detail: "ok" }],
        exitCode: 0,
      };
    },
    refresh: async () => {
      counts.refresh++;
      return outcome;
    },
  };
  return {
    db,
    deps,
    counts,
    change: () => version++,
    tick: (ms: number) => (now += ms),
  };
}
export async function settle() {
  await new Promise((r) => setTimeout(r, 35));
}
export async function until(predicate: () => boolean) {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Timed out waiting for frame");
}
export function mount(
  deps: TuiDependencies,
  width = 120,
  height = 40,
  onQuit?: () => void,
) {
  const app = render(
    <App
      deps={deps}
      mono
      dimensions={{ columns: width, rows: height }}
      onQuit={onQuit}
    />,
  );
  Object.defineProperty(app.stdout, "columns", {
    value: width,
    configurable: true,
  });
  const frame = () => app.lastFrame() ?? "";
  const key = async (s: string) => {
    app.stdin.write(s);
    await settle();
  };
  return {
    ...app,
    frame,
    key,
    resize: async (w: number, h: number) => {
      Object.defineProperty(app.stdout, "columns", {
        value: w,
        configurable: true,
      });
      app.rerender(
        <App
          deps={deps}
          mono
          dimensions={{ columns: w, rows: h }}
          onQuit={onQuit}
        />,
      );
      await settle();
    },
  };
}
