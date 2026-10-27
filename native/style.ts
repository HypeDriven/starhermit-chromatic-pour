// The look of the menus, HUD and board: the browser build's style sheet,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start. The browser build painted its accent from the shelf theme's CSS
// custom properties (--theme-accent, --theme-bg, --theme-fog) and mixed it
// with color-mix(); here the theme's colours and those mixes are tokens
// computed per theme and set with ui.setTokens, and the page background,
// the playfield and the vessels (screens.ts, board.ts) read the same
// palette. High contrast is the runtime's (it forces the UI's colours); the
// vessels draw their own high-contrast outlines.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { THEMES } from "../js/content.js";

export type Theme = (typeof THEMES)[number];

/** "#rrggbb" or "#rrggbbaa" → [r, g, b, a] 0–255. */
function rgba(hex: string): [number, number, number, number] {
  const h = hex.replace("#", "");
  const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) : 255];
}
const hex2 = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
/** CSS color-mix(in srgb, a k, b): `b` may be "transparent". */
export function mix(a: string, k: number, b: string): string {
  if (b === "transparent") {
    const [r, g, bl, al] = rgba(a);
    return `#${hex2(r)}${hex2(g)}${hex2(bl)}${hex2(al * k)}`;
  }
  const x = rgba(a), y = rgba(b);
  return `#${hex2(x[0] * k + y[0] * (1 - k))}${hex2(x[1] * k + y[1] * (1 - k))}${hex2(x[2] * k + y[2] * (1 - k))}`;
}

export interface Palette {
  theme: Theme;
  accent: string;
  accentSoft: string;
  bg: string;
  bg2: string;
  fog: string;
}
export const INK = "#ece2cf";
export const INK_DIM = "#b3a488";
export const DANGER = "#e05d4f";
export const OK = "#8fce6e";
export const FOCUS = "#ffd97a";
export const PANEL_BORDER = "#ece2cf29";

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}
let palette: Palette = makePalette("ember");
export function currentPalette(): Palette { return palette; }

function makePalette(themeId: string): Palette {
  const t = themeById(themeId);
  return { theme: t, accent: t.accent, accentSoft: mix(t.accent, 0.3, "transparent"), bg: t.bg, bg2: "#1c1611", fog: t.fog };
}

function tokensFor(p: Palette): Record<string, string> {
  return {
    bg: p.bg, accent: p.accent, "accent-soft": p.accentSoft,
    "accent-light": mix(p.accent, 0.88, "#ffffff"), "accent-dark": mix(p.accent, 0.7, "#000000"),
  };
}

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 8, radius: 14,
    text: INK, muted: INK_DIM, panel: "#211a14", control: "#29201a", hovered: "#33281f",
    pressed: "#3d3025", field: "#0f0b08", accent: "#ff9e4a", focus: FOCUS, outline: PANEL_BORDER,
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: INK } },
    paragraph: { text: { color: INK } },
    heading: { text: { color: INK } },
    widget: { focusRing: { color: FOCUS, width: 3, offset: 2 } },
    checkbox: {
      text: { color: INK, font: "serif" }, minHeight: 44,
      parts: { box: { background: "#0000004d", border: { width: 1, color: "#ece2cf66" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: INK, font: "sans-serif" }, background: "#0000004d", border: { width: 1, color: PANEL_BORDER }, radius: 10, minHeight: 44 },
    textField: { text: { color: INK, font: "sans-serif" }, background: "#0000004d", border: { width: 1, color: PANEL_BORDER }, radius: 10, minHeight: 44, padding: { start: 12, end: 12 } },
    dialog: {
      background: "#211a14", radius: 14, padding: 20, border: { width: 1, color: PANEL_BORDER }, shadow: { y: 12, blur: 40, color: "#00000080" },
      parts: { backdrop: { background: "#0a0806a8" } },
    },
    scrollArea: { parts: { bar: { background: INK_DIM, radius: 4 } } },
    tooltip: { background: INK, text: { color: "#14100e" }, radius: 6, padding: 6 },
  });
  applyTheme("ember");
}

let key = "";
/** The shelf theme's palette and tokens. */
export function applyTheme(themeId: string): void {
  if (themeId === key) return;
  key = themeId;
  palette = makePalette(themeId);
  ui.setTokens(tokensFor(palette));
}
