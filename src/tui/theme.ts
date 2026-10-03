/**
 * Palettes and terminal-background detection. No React or Ink imports, so `tui.ts` can resolve the
 * theme before Ink takes over stdin, and tests can exercise it without rendering.
 */
export type ThemeName = "dark" | "light";
export type ThemePreference = ThemeName | "auto";
export type Tone = "text" | "muted" | "accent" | "warning" | "ok";
/** `undefined` means the terminal's own foreground, which is right on any background. */
export type Palette = Record<Tone, string | undefined>;
export type Rgb = [number, number, number];

/**
 * Every non-default tone must clear WCAG AA (4.5:1) on `BACKGROUNDS[theme]`; `tests/theme.test.ts`
 * enforces it. `text` stays undefined: hard-coding body text is what made the light theme unreadable.
 */
export const palettes: Record<ThemeName, Palette> = {
  dark: {
    text: undefined,
    muted: "#99988f",
    accent: "#dc7c5c",
    warning: "#cfae6e",
    ok: "#94b87a",
  },
  light: {
    text: undefined,
    muted: "#66655d",
    accent: "#b04a28",
    warning: "#8a6208",
    ok: "#367020",
  },
};

/** Representative terminal backgrounds each palette is checked against: plain, tinted and grey. */
export const BACKGROUNDS: Record<ThemeName, string[]> = {
  dark: ["#000000", "#1e1e1e", "#2b2b2b", "#282c34"],
  light: ["#ffffff", "#f5f2eb", "#fdf6e3", "#eeeeee"],
};

const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export const parseHex = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** WCAG relative luminance, 0 (black) to 1 (white). */
export const luminance = ([r, g, b]: Rgb) =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** WCAG contrast ratio between two `#rrggbb` colours, 1 to 21. */
export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(parseHex(a)), luminance(parseHex(b))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * The luminance at which black and white text have equal contrast (~4.58:1). Above it, dark text
 * reads better than light text, which is the only question the palette choice is asking.
 */
const LIGHT_ABOVE = 0.179;
export const themeForBackground = (rgb: Rgb): ThemeName =>
  luminance(rgb) > LIGHT_ABOVE ? "light" : "dark";

/** Parses `OSC 11 ; rgb:RRRR/GGGG/BBBB` (1–4 hex digits per channel) out of a terminal reply. */
export function parseOsc11(reply: string): Rgb | null {
  const m = /\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
  if (!m) return null;
  const channel = (hex: string) =>
    Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);
  return [channel(m[1]!), channel(m[2]!), channel(m[3]!)];
}

export function parseThemePreference(value: string | undefined): ThemePreference | undefined {
  const v = value?.trim().toLowerCase();
  return v === "auto" || v === "light" || v === "dark" ? v : undefined;
}

type QueryInput = Pick<NodeJS.ReadStream, "on" | "off" | "resume" | "pause"> & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

/**
 * Asks the terminal for its background colour. A DA1 query (`CSI c`) rides along as a sentinel:
 * terminals answer in order, so its reply means any OSC 11 reply has already arrived, and waiting
 * for it also keeps that reply from leaking into Ink as keypresses. Terminals and multiplexers that
 * answer neither are covered by the timeout, which resolves null.
 */
export function queryBackground(
  input: QueryInput,
  output: Pick<NodeJS.WriteStream, "write">,
  timeoutMs = 250,
): Promise<Rgb | null> {
  return new Promise((resolve) => {
    let buffer = "";
    const wasRaw = input.isRaw ?? false;
    const finish = () => {
      clearTimeout(timer);
      input.off("data", onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      resolve(parseOsc11(buffer));
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (/\x1b\[\?[\d;]*c/.test(buffer)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    input.setRawMode?.(true);
    input.on("data", onData);
    input.resume();
    output.write("\x1b]11;?\x1b\\\x1b[c");
  });
}

export type ResolvedTheme = { name: ThemeName; note: string };

/**
 * `flag` beats `env`; both beat detection. Detection only runs for `auto` and falls back to dark,
 * the terminal default, when the terminal does not answer.
 */
export async function resolveTheme(options: {
  flag?: ThemePreference;
  env?: ThemePreference;
  detect: () => Promise<Rgb | null>;
}): Promise<ResolvedTheme> {
  const source = options.flag ? "--theme" : options.env ? "CUSAGE_THEME" : null;
  const preference = options.flag ?? options.env ?? "auto";
  if (preference !== "auto") return { name: preference, note: `${preference} (${source})` };
  const rgb = await options.detect();
  return rgb
    ? { name: themeForBackground(rgb), note: `${themeForBackground(rgb)} (detected from terminal background)` }
    : { name: "dark", note: "dark (terminal did not report its background; assumed)" };
}
