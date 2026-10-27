// The shelf's vessels as the browser build's DOM board drew them (js/ui.js
// renderBoard, css/style.css .vessel / .vessel-tube / .layer): a row of
// glass tubes (wrapping as the flex row did, centred, bottoms aligned) over
// the 3D shelf, each a ui.widget button with the old button's accessible
// name ("Vessel 2: 3 layers, top Emberwine, single color"), so Tab, the
// arrows, Enter/Space and a pad's D-pad and South move over and press them
// as they did the DOM buttons, and a tap or click on one lifts or pours.
// The look per tube: the glass (tinted gradient, rounded foot, inner and
// drop shadows), the liquid layers bottom first with their sheen, the
// colour's shape badge (shapes.ts) and, with Labels on liquids, its name;
// the selected tube lifting with an accent ring, legal targets ringed
// green, the hint's pair ringed for 2.4 s, an invalid try's red ring and
// shake, a pour's source tipping up while the new layers fill the target
// from the bottom (staggered), and at detailed quality the cylinder shading,
// the meniscus, the gloss streak and the slow caustic sweep over the glass
// and the soft shadow under each tube. Everything is drawn with
// starhermit:draw inside the widgets, in logical pixels times the UI's
// scale; a tipped tube is drawn turned about its centre piece by piece.
import { frame } from "starhermit:engine";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import * as rules from "../js/rules.js";
import { tr } from "./i18n.ts";
import { drawShape } from "./shapes.ts";
import { app, colorDef, onVessel, round, session, settings } from "./main.ts";
import { DANGER, FOCUS, INK, INK_DIM, OK, currentPalette, mix } from "./style.ts";

let detailed = true;
export function setDetailed(on: boolean): void { detailed = on; }

// --- per-round animation state (seconds of frame time) --------------------------------------
const lift = new Map<number, number>();
let invalidAt: { i: number; t: number } | null = null;
let hintAt: { from: number; to: number; t: number } | null = null;
let pourAt: { from: number; to: number; layers: number; t: number } | null = null;
let settledAt = -10;
let focused: number | null = null;
let lastLayout: BoardLayout | null = null;
const now = (): number => frame().time;

/** A new board (round start, undo, restart, a lesson step): no animation in flight. */
export function reset(): void { invalidAt = null; hintAt = null; pourAt = null; lift.clear(); }
export function invalid(i: number): void { invalidAt = { i, t: now() }; }
export function hint(from: number, to: number): void { hintAt = { from, to, t: now() }; }
export function pour(from: number, to: number, layers: number): void { pourAt = { from, to, layers, t: now() }; }
/** The pour's choreography ended (or was skipped). */
export function settle(): void { if (pourAt) settledAt = now(); pourAt = null; }
export function vesselId(i: number): string { return `vessel-${i}`; }
/** The vessel focused when the last frame was built, if any. */
export function focusedIndex(): number | null { return focused; }
/** The vessel `dx` along (wrapping) or `dy` rows away (clamped), as the browser build's focus keys moved. */
export function neighbor(i: number, dx: number, dy: number): number {
  const n = session?.state?.vessels.length ?? 0;
  if (!n) return 0;
  if (dx) return (i + dx + n) % n;
  const row = lastLayout?.perRow ?? n;
  return Math.max(0, Math.min(n - 1, i + dy * row));
}

// --- layout ----------------------------------------------------------------------------------
export interface BoardLayout { tubeW: number; slotH: number; gap: number; pad: number; perRow: number; rows: number; vesselW: number; vesselH: number; width: number; height: number; label: number }
const LIFT_ROOM = 18;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
/**
 * The board's size in `availW` × `availH` logical pixels for `n` vessels of
 * `cap` slots, as the CSS sized it: tubes clamp(2.9rem, 7.5vw, 4.2rem) wide,
 * slots clamp(1.6rem, 4.2vw, 2.6rem) tall (on short landscape screens 8vh
 * and 6vh), gaps clamp(0.6rem, 2.2vw, 1.4rem), the board's padding
 * clamp(1rem, 4vw, 2.5rem), wrapping into rows; shrunk to fit a short
 * playfield.
 */
export function layoutBoard(n: number, cap: number, availW: number, availH: number, vw: number, vh: number, shortLand: boolean): BoardLayout {
  let tubeW = shortLand ? clamp(vh * 8, 35.2, 48) : clamp(vw * 7.5, 46.4, 67.2);
  let slotH = shortLand ? clamp(vh * 6, 17.6, 28.8) : clamp(vw * 4.2, 25.6, 41.6);
  const gap = clamp(vw * 2.2, 9.6, 22.4);
  const pad = shortLand ? 8 : clamp(vw * 4, 16, 40);
  const label = 14;
  let out: BoardLayout | null = null;
  for (let iter = 0; iter < 8; iter++) {
    const vesselW = tubeW + 12.8;
    const vesselH = 6.4 + LIFT_ROOM + slotH * cap + 6 + 5.6 + label + 6.4;
    const perRow = Math.max(1, Math.min(n, Math.floor((availW - pad * 2 + gap) / (vesselW + gap))));
    const rows = Math.ceil(n / perRow);
    const width = perRow * vesselW + (perRow - 1) * gap;
    const height = rows * vesselH + (rows - 1) * gap;
    out = { tubeW, slotH, gap, pad, perRow, rows, vesselW, vesselH, width, height, label };
    const k = Math.min(1, (availH - pad * 2) / height, (availW - pad * 2) / width);
    if (k >= 0.999) break;
    tubeW = Math.max(26, tubeW * Math.max(0.8, k));
    slotH = Math.max(12, slotH * Math.max(0.8, k));
  }
  lastLayout = out;
  return out!;
}

// --- descriptions ----------------------------------------------------------------------------
type State = NonNullable<NonNullable<typeof session>["state"]>;
export function vesselLabel(state: State, i: number): string {
  const v = state.vessels[i] as number[];
  if (!v.length) return tr("Vessel {n}: empty", { n: i + 1 });
  const top = colorDef(v[v.length - 1]!);
  let label = tr(v.length === 1 ? "Vessel {n}: {layers} layer, top {color}" : "Vessel {n}: {layers} layers, top {color}", { n: i + 1, layers: v.length, color: top.name });
  if (v.every((c) => c === v[0])) label += v.length === state.capacity ? tr(", harmonized") : tr(", single color");
  return label;
}

// --- drawing ---------------------------------------------------------------------------------
type Fill = ui.Fill;
/** A rigid transform for a tipped tube: turn `deg` clockwise about (px, py), then move (tx, ty). */
interface Tf { px: number; py: number; tx: number; ty: number; deg: number; c: number; s: number }
function tfOf(px: number, py: number, tx: number, ty: number, deg: number): Tf {
  const r = (deg * Math.PI) / 180;
  return { px, py, tx, ty, deg, c: Math.cos(r), s: Math.sin(r) };
}
function pt(t: Tf, x: number, y: number): [number, number] {
  const dx = x - t.px, dy = y - t.py;
  return [t.px + dx * t.c - dy * t.s + t.tx, t.py + dx * t.s + dy * t.c + t.ty];
}
function box(t: Tf, x: number, y: number, w: number, h: number, style: ui.Style): void {
  const [cx, cy] = pt(t, x + w / 2, y + h / 2);
  draw.box(cx - w / 2, cy - h / 2, w, h, t.deg ? { ...style, rotate: t.deg } : style);
}
function easeOutBack(k: number): number {
  // cubic-bezier(0.2, 0.9, 0.3, 1.2): an overshooting ease-out
  const c1 = 1.2, c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
}

const SHAPE_INK = "#140e088c";
const LABEL_INK = "#140e08bf";
const GLASS_EDGE = "#ece2cf57";

function drawVessel(r: ui.Rect, st: ui.WidgetState, i: number, layers: number[], cap: number, L: BoardLayout, flags: {
  selected: boolean; target: boolean; hintFrom: boolean; hintTo: boolean; invalidK: number; lifting: number; receiving: boolean; newFrom: number; pourK: number;
}): void {
  const k = st.scale;
  const pal = currentPalette();
  const t = now();
  const reduced = st.reducedMotion;
  const tubeW = L.tubeW * k, slotH = L.slotH * k;
  const tubeH = slotH * cap + 6 * k;
  const tx0 = r.x + (r.width - tubeW) / 2;
  const ty0 = r.y + (6.4 + LIFT_ROOM) * k;
  // the floor shadow under the tube (detailed)
  if (detailed) {
    draw.box(r.x, ty0 + tubeH - 6 * k, r.width, 14 * k, { background: { type: "radial", center: { x: 0.5, y: 0.5 }, radius: "closest-side", stops: ["#00000073", "#00000000"] } });
  }
  // transforms: the selection lift (eased), the pour's tip, the invalid shake
  const lv = lift.get(i) ?? 0;
  let shakeX = 0;
  if (flags.invalidK >= 0 && flags.invalidK < 1 && !reduced) {
    const kk = flags.invalidK;
    shakeX = kk < 0.25 ? -6 * (kk / 0.25) : kk < 0.55 ? -6 + 11 * ((kk - 0.25) / 0.3) : kk < 0.8 ? 5 - 8 * ((kk - 0.55) / 0.25) : -3 + 3 * ((kk - 0.8) / 0.2);
  }
  const liftPx = -(10.4 * lv + 17.6 * flags.lifting) * k;
  const tf = tfOf(tx0 + tubeW / 2, ty0 + tubeH / 2, shakeX * k, liftPx, -4 * flags.lifting);
  // rings and glows (the CSS box-shadows outside the tube): drawn as outset borders, since
  // a box's outer shadow would show through the translucent glass
  const rings: [number, string][] = [];
  if (flags.invalidK >= 0 && flags.invalidK < 1) rings.push([3, DANGER], ...(reduced ? [] : [[5, mix(DANGER, 0.3, "transparent")] as [number, string]]));
  else if (flags.hintFrom) rings.push([3, FOCUS], [5, pal.accentSoft]);
  else if (flags.hintTo) rings.push([3, OK], [5, mix(OK, 0.3, "transparent")]);
  else if (flags.selected) rings.push([3, pal.accent], [6, pal.accentSoft]);
  else if (flags.target) rings.push([2, mix(OK, 0.7, "transparent")]);
  else if (flags.receiving) rings.push([2, pal.accentSoft]);
  const footR = tubeW / 2 / k;
  const corners = [10, 10, footR, footR] as const;
  const hc = st.highContrast;
  let out = 0;
  for (const [wd, color] of rings) {
    const o = out * k, b = wd * k;
    box(tf, tx0 - o - b, ty0 - o - b, tubeW + 2 * (o + b), tubeH + 2 * (o + b), { border: { width: wd, color }, radius: [10 + out + wd, 10 + out + wd, footR + out + wd, footR + out + wd] });
    out += wd;
  }
  box(tf, tx0, ty0, tubeW, tubeH, {
    background: { type: "linear", angle: 105, stops: [{ color: "#ffffff1a", at: 0 }, { color: "#ffffff05", at: 0.45 }, { color: "#0000002e", at: 1 }] },
    border: { width: { top: 1, end: 2, bottom: 2, start: 2 }, color: hc ? INK : GLASS_EDGE },
    radius: corners, shadow: [{ inset: true, blur: 12, color: "#00000059" }],
  });
  // the layers, bottom first, inside the border
  const ix = tx0 + 2 * k, iw = tubeW - 4 * k;
  const bottom = ty0 + tubeH - 2 * k;
  const innerFoot = Math.max(0, footR - 2);
  const topIndex = layers.length - 1;
  for (let s = 0; s < layers.length; s++) {
    const color = layers[s]!;
    const def = colorDef(color);
    let hk = 1, alpha = 1;
    if (s >= flags.newFrom && flags.pourK >= 0) {
      const local = (flags.pourK * 0.56 - (s - flags.newFrom) * 0.07) / 0.42;
      const kk = Math.max(0, Math.min(1, local));
      hk = Math.max(0, easeOutBack(kk));
      alpha = 0.4 + 0.6 * kk;
    }
    if (hk <= 0.001) continue;
    const h = slotH * hk;
    const y = bottom - (s + 1) * slotH + (slotH - h);
    const fills: Fill[] = [];
    if (detailed) fills.push({ type: "linear", angle: 90, stops: [{ color: "#00000042", at: 0 }, { color: "#ffffff12", at: 0.28 }, { color: "#ffffff00", at: 0.55 }, { color: "#0000004d", at: 1 }] });
    fills.push({ type: "linear", angle: 180, stops: [{ color: detailed ? "#ffffff38" : "#ffffff4d", at: 0 }, { color: detailed ? "#ffffff08" : "#ffffff0a", at: 0.35 }, { color: detailed ? "#0000002e" : "#00000038", at: 1 }] });
    fills.push(def.hex + (alpha < 1 ? Math.round(alpha * 255).toString(16).padStart(2, "0") : ""));
    const bottomR = s === 0 ? innerFoot : 0;
    box(tf, ix, y, iw, h, {
      background: fills, radius: [0, 0, bottomR, bottomR],
      ...(detailed ? { shadow: { inset: true, blur: 10, color: mix(def.hex, 0.6, "transparent") } } : {}),
    });
    if (s > 0) box(tf, ix, y, iw, Math.max(1, k), { background: "#ffffff24" });
    if (detailed && s === topIndex) {
      box(tf, ix + iw * 0.06, y, iw * 0.88, 4 * k, { background: { type: "radial", center: { x: 0.5, y: 0.5 }, radius: "closest-side", stops: ["#ffffff8c", "#ffffff00"] } });
    }
    if (hk > 0.6) {
      const size = Math.min(iw * 0.42, h * 0.6);
      const [cx, cy] = pt(tf, ix + iw / 2, y + h / 2);
      drawShape(color % 10, cx, cy, size, (tf.deg * Math.PI) / 180, SHAPE_INK);
      if (settings.labelsOnLiquids && !tf.deg) {
        const fs = 8.8 * k * (ui.preferences().textScale ?? 1);
        draw.text(def.name, ix + iw * 0.04, y + (h - fs * 1.2) / 2, { size: fs, color: LABEL_INK, font: "sans-serif", clip: { x: ix, y, width: iw * 0.96, height: h } });
      }
    }
  }
  // the glass over the liquid: gloss streak, caustic sweep, lip and foot (detailed)
  if (detailed) {
    box(tf, tx0 + tubeW * 0.11, ty0 + 6 * k, tubeW * 0.11, tubeH - 20 * k, {
      background: { type: "linear", angle: 180, stops: [{ color: "#ffffff57", at: 0 }, { color: "#ffffff1f", at: 0.6 }, { color: "#ffffff00", at: 1 }] }, radius: 999,
    });
    if (!reduced) {
      const cyc = ((t + (i % 3) * 2.3) % 7) / 7;
      if (cyc > 0.6) {
        const p = (cyc - 0.6) / 0.4;
        const c0 = 1.2 - p * 1.7;
        box(tf, tx0, ty0, tubeW, tubeH, {
          background: { type: "linear", angle: 115, stops: [{ color: "#ffffff00", at: clamp(c0 - 0.1, 0, 1) }, { color: "#ffffff1a", at: clamp(c0, 0, 1) }, { color: "#ffffff00", at: clamp(c0 + 0.1, 0, 1) }] },
          radius: corners,
        });
      }
    }
    box(tf, tx0, ty0, tubeW, tubeH, { radius: corners, shadow: [{ inset: true, y: 2, color: "#ffffff47" }, { inset: true, y: -8, blur: 14, color: "#00000047" }] });
  }
  // the vessel's number under the tube
  const fsn = 11.2 * k * (ui.preferences().textScale ?? 1);
  draw.text(String(i + 1), r.x + r.width / 2, ty0 + tubeH + 5.6 * k, { size: fsn, color: INK_DIM, font: "sans-serif", align: "center" });
}

// --- the board -------------------------------------------------------------------------------
/** Builds the board at the current place in the UI (`L` from layoutBoard). */
export function buildBoard(L: BoardLayout): void {
  const s = session;
  const state = s?.state;
  if (!s || !state) return;
  const t = now();
  const busy = round.inputLocked || !(app.phase === "active" || app.phase === "tutorial") || app.overlays.length > 0;
  const roundOver = state.status !== "active";
  const selected = s.selected;
  const targets = new Set<number>();
  if (selected != null && state.status === "active") {
    for (const p of rules.legalPours(state, { includePointless: true })) if (p.from === selected) targets.add(p.to);
  }
  const reduced = ui.preferences().reducedMotion;
  const dt = Math.min(0.1, frame().delta);
  if (hintAt && t - hintAt.t > 2.4) hintAt = null;
  if (invalidAt && t - invalidAt.t > (reduced ? 0.35 : 0.32)) invalidAt = null;
  const pourK = pourAt ? Math.min(1, (t - pourAt.t) / 0.56) : -1;
  const settleK = Math.min(1, (t - settledAt) / 0.2);
  const n = state.vessels.length;
  focused = null;
  ui.column("board", () => {
    for (let row = 0; row < L.rows; row++) {
      ui.row(`board-r${row}`, () => {
        for (let i = row * L.perRow; i < Math.min(n, (row + 1) * L.perRow); i++) {
          const layers = state.vessels[i] as number[];
          const want = selected === i ? 1 : 0;
          let lv = lift.get(i) ?? 0;
          lv = reduced ? want : lv + (want - lv) * Math.min(1, dt * 18);
          lift.set(i, lv);
          let lifting = 0;
          if (pourAt && pourAt.from === i && !reduced) lifting = Math.min(1, (t - pourAt.t) / 0.2);
          else if (!pourAt && !reduced && settleK < 1 && lastPourFrom === i) lifting = 1 - settleK;
          const receiving = !!pourAt && pourAt.to === i;
          const flags = {
            selected: selected === i, target: targets.has(i),
            hintFrom: !!hintAt && hintAt.from === i, hintTo: !!hintAt && hintAt.to === i,
            invalidK: invalidAt && invalidAt.i === i ? (t - invalidAt.t) / (reduced ? 0.35 : 0.32) : -1,
            lifting, receiving,
            newFrom: receiving ? layers.length - pourAt!.layers : 999, pourK: receiving ? pourK : -1,
          };
          const res = ui.id(vesselId(i)).widget(vesselLabel(state, i), {
            role: "button", size: { width: L.vesselW, height: L.vesselH }, disabled: roundOver,
            draw: (r, st) => drawVessel(r, st, i, layers, state.capacity, L, flags),
          });
          if (res.focused) focused = i;
          holdToConfirm(i, res, busy);
        }
      }, { spacing: L.gap, align: "end", justify: "center" });
    }
  }, { spacing: L.gap, align: "center" });
  if (pourAt) lastPourFrom = pourAt.from;
}
let lastPourFrom = -1;

// Hold to confirm: a pointer press must be held 320 ms; plain clicks are
// ignored (keyboard and pad presses still act at once).
const holds = new Map<number, number>();
function holdToConfirm(i: number, res: ui.WidgetResult, busy: boolean): void {
  const pressedBefore = holds.has(i);
  if (!settings.holdToConfirm) {
    holds.delete(i);
    if (res.activated && !busy) onVessel(i);
    return;
  }
  if (res.pressed && res.hovered) {
    const t0 = holds.get(i);
    if (t0 === undefined) holds.set(i, now());
    else if (t0 >= 0 && now() - t0 >= 0.32) { holds.set(i, -1); if (!busy) onVessel(i); }
    return;
  }
  holds.delete(i);
  // an activation without a pointer press before it came from the keyboard or a pad
  if (res.activated && !pressedBefore && !busy) onVessel(i);
}
