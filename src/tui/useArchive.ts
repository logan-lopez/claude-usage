/** Archive lifecycle: first read, change polling, the clock, reread, diagnostics and refresh. */
import { useEffect, useRef, useState } from "react";
import type { Diagnostics, OverviewData, TuiDependencies } from "./data.ts";

/** Status channel shared by every part of the TUI that reads the archive. */
export interface Report {
  error: (message: string) => void;
  notice: (message: string) => void;
  /** A successful read clears the outdated-data warning. */
  ok: () => void;
}

const HOUR = 3_600_000;
/**
 * Every label derived from `now` has minute resolution, so the clock only
 * commits a new value when this bucket changes. Checking each second and
 * committing every ten keeps ages prompt without redrawing the screen per tick.
 */
const CLOCK_BUCKET_MS = 10_000;

export function useArchive(deps: TuiDependencies, onReload: () => void) {
  const [now, setNow] = useState(deps.now);
  const [data, setData] = useState<OverviewData | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fetching, setFetching] = useState(false);
  const alive = useRef(true);
  const version = useRef<number | null>(null);
  const lastHour = useRef(Math.floor(deps.now() / HOUR));
  const refreshBusy = useRef(false);
  const diagnosticBusy = useRef(false);
  const report = useRef<Report>({
    error: setError,
    notice: setNotice,
    ok: () => setError(""),
  }).current;

  function reread() {
    try {
      // Sample the version first so a write that lands mid-read is seen next poll.
      const observed = deps.version();
      setData(deps.overview());
      setError("");
      version.current = observed;
    } catch {
      setError(
        "Archive unreadable; last successful data retained (outdated). Run cusage sync or check --db.",
      );
      return;
    }
    latest.current.onReload();
  }

  async function diagnose() {
    if (diagnosticBusy.current) return;
    diagnosticBusy.current = true;
    try {
      const result = await deps.diagnostics();
      if (alive.current) setDiagnostics(result);
    } catch {
      if (alive.current) setNotice("Diagnostics failed; previous checks retained.");
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
      if (result.ok) latest.current.reread();
    } catch {
      if (alive.current) setNotice("Refresh failed; archived limits retained.");
    } finally {
      refreshBusy.current = false;
      if (alive.current) setFetching(false);
    }
  }

  /** Timers and async completions call the latest render's functions, never a stale closure. */
  const latest = useRef({ reread, onReload });
  latest.current = { reread, onReload };

  useEffect(() => {
    alive.current = true;
    const first = setTimeout(() => {
      if (!alive.current) return;
      latest.current.reread();
      void diagnose();
    }, 0);
    const poll = setInterval(() => {
      if (!alive.current) return;
      try {
        const next = deps.version();
        const hour = Math.floor(deps.now() / HOUR);
        if (next !== version.current || hour !== lastHour.current) {
          latest.current.reread();
          lastHour.current = hour;
        }
      } catch {
        setError("Archive poll failed; data is outdated. r retries.");
      }
    }, deps.pollMs);
    const clock = setInterval(() => {
      if (!alive.current) return;
      const next = deps.now();
      setNow((prev) =>
        Math.floor(prev / CLOCK_BUCKET_MS) === Math.floor(next / CLOCK_BUCKET_MS)
          ? prev
          : next,
      );
    }, 1000);
    return () => {
      alive.current = false;
      deps.cancelPending?.();
      clearTimeout(first);
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [deps]);

  return {
    now,
    data,
    diagnostics,
    error,
    notice,
    fetching,
    report,
    /** r: reread the archive and rerun credential-free diagnostics. */
    reread: () => {
      reread();
      void diagnose();
      setNotice("Archive reread; no ingestion or limit fetch.");
    },
    /** R: explicit guarded limits fetch. */
    refresh: () => void refresh(),
    /** Stop late state updates and cancel pending keychain/network work. */
    close: () => {
      alive.current = false;
      deps.cancelPending?.();
    },
  };
}
