import { createContext, useContext, useLayoutEffect, type RefObject } from "react";
import type { Key } from "ink";

export type KeyHandler = (input: string, key: Key) => void;

/** The shell's slot for the active screen's handler. */
export const KeyTarget = createContext<RefObject<KeyHandler | null>>({
  current: null,
});

/**
 * Receive the keys the shell does not handle itself. Ink's own useInput
 * subscribes in a passive effect, so a screen that has just mounted would miss
 * a key arriving before that effect runs (a paste, or a key queued behind a
 * screen switch). A layout effect registers in the same commit as the mount.
 */
export function useKeys(handler: KeyHandler) {
  const target = useContext(KeyTarget);
  useLayoutEffect(() => {
    target.current = handler;
    return () => {
      if (target.current === handler) target.current = null;
    };
  });
}

/**
 * The shared list/scroll keys: ↑↓ j/k, PageUp/PageDown, Home/End. Returns a
 * clamped `(current, max) => next`, or null when the key is not a movement.
 * Callers apply it to the latest state (functional updates or a ref), so keys
 * delivered in one stdin chunk compose instead of reading a stale render.
 */
export function movement(
  input: string,
  key: Key,
  page: number,
): ((current: number, max: number) => number) | null {
  if (key.home) return () => 0;
  if (key.end) return (_, max) => Math.max(0, max);
  // Ink delivers printable keys that queued behind a slow frame as one string
  // ("jjj"); count them instead of dropping the whole chunk.
  const repeat = /^(?:j+|k+)$/.test(input) ? input.length : 0;
  const step = key.pageDown
    ? page
    : key.pageUp
      ? -page
      : key.downArrow
        ? 1
        : key.upArrow
          ? -1
          : input[0] === "j"
            ? repeat
            : -repeat;
  if (!step) return null;
  return (current, max) =>
    Math.max(0, Math.min(max, Math.min(current, max) + step));
}

/** Cycle through `count` items with wrap-around. */
export const cycle = (current: number, delta: number, count: number) =>
  (current + delta + count) % count;
