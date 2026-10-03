import React from "react";
import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { renderToString } from "ink";
import chalk from "chalk";
import { PaletteContext, Row } from "../src/tui/components.tsx";
import {
  BACKGROUNDS,
  contrast,
  palettes,
  parseOsc11,
  parseThemePreference,
  queryBackground,
  resolveTheme,
  themeForBackground,
  type Tone,
  type ThemeName,
} from "../src/tui/theme.ts";

const themes = Object.keys(palettes) as ThemeName[];
const coloured = (name: ThemeName) =>
  (Object.entries(palettes[name]) as [Tone, string | undefined][]).filter(
    (entry): entry is [Tone, string] => entry[1] !== undefined,
  );

test("both palettes define the same tones, and body text follows the terminal foreground", () => {
  expect(Object.keys(palettes.light).sort()).toEqual(Object.keys(palettes.dark).sort());
  for (const name of themes) expect(palettes[name].text).toBeUndefined();
});

test("every tone clears WCAG AA against every representative background of its theme", () => {
  for (const name of themes)
    for (const [tone, hex] of coloured(name))
      for (const bg of BACKGROUNDS[name])
        expect(
          contrast(hex, bg),
          `${name} ${tone} ${hex} on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
});

test("each palette is checked against backgrounds it would actually be shown on", () => {
  // Guards the guard: a light palette 'tested' on dark backgrounds would prove nothing.
  for (const bg of BACKGROUNDS.light) expect(themeForBackground(hexRgb(bg))).toBe("light");
  for (const bg of BACKGROUNDS.dark) expect(themeForBackground(hexRgb(bg))).toBe("dark");
});

test("a palette is unreadable on the opposite background, which is why detection exists", () => {
  // The reported bug: the dark palette's muted grey on white.
  expect(contrast(palettes.dark.muted!, "#ffffff")).toBeLessThan(4.5);
  expect(contrast(palettes.light.muted!, "#000000")).toBeLessThan(4.5);
});

test("tones stay distinguishable from each other within a theme", () => {
  // Accent and warning are the close pair: both warm. Measured as CIE76 ΔE, so this is about
  // perceived difference rather than hex distance.
  for (const name of themes) {
    const tones = coloured(name);
    for (let i = 0; i < tones.length; i++)
      for (let j = i + 1; j < tones.length; j++)
        expect(
          deltaE(tones[i]![1], tones[j]![1]),
          `${name} ${tones[i]![0]} vs ${tones[j]![0]}`,
        ).toBeGreaterThanOrEqual(28);
  }
});

test("Row takes its colour from the palette in context, and only there", () => {
  // `chalk` is Ink's own (hoisted) copy: setting its level makes renderToString emit colour. If
  // that ever stops being the same instance, the assertions below fail rather than pass vacuously.
  const level = chalk.level;
  chalk.level = 3;
  try {
    const render = (name: ThemeName) =>
      renderToString(
        React.createElement(
          PaletteContext.Provider,
          { value: palettes[name] },
          React.createElement(Row, { text: "muted", width: 10, tone: "muted" }),
        ),
      );
    expect(render("dark")).toContain("38;2;153;152;143");
    expect(render("light")).toContain("38;2;102;101;93");
    expect(render("light")).not.toContain("38;2;153;152;143");
    // Body text emits no colour at all, on either theme.
    const plain = renderToString(
      React.createElement(
        PaletteContext.Provider,
        { value: palettes.light },
        React.createElement(Row, { text: "body", width: 10 }),
      ),
    );
    expect(plain).not.toContain("\x1b[38");
  } finally {
    chalk.level = level;
  }
});

test("parseOsc11 reads 1–4 digit channels, either terminator, and ignores everything else", () => {
  expect(parseOsc11("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")).toEqual([255, 255, 255]);
  expect(parseOsc11("\x1b]11;rgb:0000/0000/0000\x07")).toEqual([0, 0, 0]);
  expect(parseOsc11("\x1b]11;rgb:f/0/8\x07")).toEqual([255, 0, 136]);
  expect(parseOsc11("\x1b]11;rgba:ffff/ffff/ffff/ffff\x07")).toEqual([255, 255, 255]);
  expect(parseOsc11("\x1b[?62;c")).toBeNull();
  expect(parseOsc11("")).toBeNull();
  // Foreground reply (OSC 10) must not be mistaken for the background.
  expect(parseOsc11("\x1b]10;rgb:ffff/ffff/ffff\x07")).toBeNull();
});

test("themeForBackground splits at the point where black and white text read equally well", () => {
  expect(themeForBackground([255, 255, 255])).toBe("light");
  expect(themeForBackground([0, 0, 0])).toBe("dark");
  expect(themeForBackground([253, 246, 227])).toBe("light"); // solarized light
  expect(themeForBackground([0, 43, 54])).toBe("dark"); // solarized dark
  expect(themeForBackground([40, 44, 52])).toBe("dark");
  expect(themeForBackground([128, 128, 128])).toBe("light"); // dark text wins on mid-grey
});

test("parseThemePreference accepts only auto, light and dark", () => {
  expect(parseThemePreference("LIGHT")).toBe("light");
  expect(parseThemePreference(" auto ")).toBe("auto");
  expect(parseThemePreference("solarized")).toBeUndefined();
  expect(parseThemePreference("")).toBeUndefined();
  expect(parseThemePreference(undefined)).toBeUndefined();
});

test("resolveTheme: flag beats env beats detection, and detection only runs for auto", async () => {
  let asked = 0;
  const detect = async () => {
    asked++;
    return [255, 255, 255] as [number, number, number];
  };
  expect((await resolveTheme({ flag: "dark", env: "light", detect })).name).toBe("dark");
  expect((await resolveTheme({ env: "dark", detect })).name).toBe("dark");
  expect(asked).toBe(0);
  const detected = await resolveTheme({ detect });
  expect(detected.name).toBe("light");
  expect(detected.note).toContain("detected");
  expect(asked).toBe(1);
  expect((await resolveTheme({ flag: "auto", env: "dark", detect })).name).toBe("light");
});

test("resolveTheme falls back to dark, and says so, when the terminal never answers", async () => {
  const resolved = await resolveTheme({ detect: async () => null });
  expect(resolved.name).toBe("dark");
  expect(resolved.note).toContain("assumed");
});

function fakeTerminal() {
  const input = Object.assign(new EventEmitter(), {
    isRaw: false,
    raw: [] as boolean[],
    paused: 0,
    setRawMode(mode: boolean) {
      this.raw.push(mode);
      this.isRaw = mode;
    },
    resume() {},
    pause() {
      this.paused++;
    },
  });
  const written: string[] = [];
  return { input, output: { write: (s: string) => (written.push(s), true) }, written };
}

test("queryBackground asks for OSC 11 plus a DA1 sentinel and waits for the sentinel", async () => {
  const { input, output, written } = fakeTerminal();
  const pending = queryBackground(input as never, output as never, 1000);
  expect(written.join("")).toBe("\x1b]11;?\x1b\\\x1b[c");
  expect(input.raw).toEqual([true]);
  // The colour reply alone must not resolve: the DA1 reply would then leak into Ink as keys.
  input.emit("data", Buffer.from("\x1b]11;rgb:ffff/ffff/ffff\x1b\\"));
  let settled = false;
  pending.then(() => (settled = true));
  await Promise.resolve();
  expect(settled).toBe(false);
  input.emit("data", Buffer.from("\x1b[?62;4c"));
  expect(await pending).toEqual([255, 255, 255]);
  expect(input.raw).toEqual([true, false]); // raw mode restored
  expect(input.listenerCount("data")).toBe(0);
});

test("queryBackground resolves null on a DA1-only reply and on silence", async () => {
  const answered = fakeTerminal();
  const a = queryBackground(answered.input as never, answered.output as never, 1000);
  answered.input.emit("data", Buffer.from("\x1b[?1;2c"));
  expect(await a).toBeNull();

  const silent = fakeTerminal();
  const started = Date.now();
  expect(await queryBackground(silent.input as never, silent.output as never, 30)).toBeNull();
  expect(Date.now() - started).toBeLessThan(500);
  expect(silent.input.listenerCount("data")).toBe(0);
});

function hexRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** CIE76 colour difference; enough to tell "two warm colours" from "two different colours". */
function deltaE(a: string, b: string) {
  const lab = (hex: string) => {
    const [r, g, b] = hexRgb(hex).map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)] as const;
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
