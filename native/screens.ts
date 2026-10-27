// The browser build's DOM shell (js/ui.js + css/style.css) as starhermit:ui,
// built every frame: the page background (the theme's fog over its dark
// base), the top bar (the brand, the play screen's Objective and Actions
// drawer toggles, the profile chip), the play layout (the Working rail, the
// playfield with the shelf and the vessels, the Actions rail with the clock
// and moves; the status strip and the action tray on small screens), the
// lesson card, the countdown, the toasts, the error banner, and the screens
// (title with its key art, modes, the six setups, results, how to pour,
// settings, the ledger) and overlays (pause, confirm, drawers). The
// browser's media queries are layouts picked by the window's logical size:
// wide (≥ 1024 px: both rails docked), compact (701–1023: the rails are
// drawers behind the top bar's toggles), phone (≤ 700: the status strip and
// the action tray) and short landscape (≤ 500 px tall: the Working rail
// beside the playfield, the strip and the tray). The shelf (render.ts) is
// framed into the playfield.
import { frame, files, openMenu, clipboard } from "starhermit:engine";
import { bindings, onPointerButton, onPointerMove, onTouch } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { requestSignIn } from "starhermit:platform";
import * as content from "../js/content.js";
import * as rules from "../js/rules.js";
import * as storage from "../js/storage.js";
import * as M from "../js/migrate.js";
import { tr, N, pt } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import * as audio from "./audio.ts";
import { buildBoard, layoutBoard } from "./board.ts";
import {
  app, round, session, settings, CHASE_BOARDS, ERROR_MESSAGES, TERMINAL_HEADLINES, askConfirm, backFromSub, cancelOrPause, challengeLevel, chaseBoard,
  closeOverlay, colorDef, confirmYes, constraintText, currentStep, dismissToast, doHint, doRestart, doUndo, fmtScore, fmtTime, freshSeed,
  goModes, goProgression, goTitle, journeyLevel, leaveRound, levelName, nextJourneyStage, notify, onPlay, openOverlay, openSetup, openSub,
  palette, pauseRound, playSubLabel, progression, refreshChase, replayLevel, resumeRound, skipPour, startChase, startDaily,
  startLesson, startLevel, startPractice, todayKey, toast, topOverlay, totalJourneyStars, type ModeKind,
} from "./main.ts";
import { DANGER, INK, INK_DIM, OK, PANEL_BORDER, currentPalette, mix } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; wide: boolean; compact: boolean; phone: boolean; shortLand: boolean; vw: number; vh: number }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const shortLand = lw > lh && lh <= 500;
  const wide = !shortLand && lw >= 1024;
  const phone = !shortLand && lw <= 700;
  return { lw, lh, sc, ox: sa.left / sc, oy: sa.top / sc, wide, compact: !wide && !phone && !shortLand, phone, shortLand, vw: lw / 100, vh: lh / 100 };
}
const lastHeight = new Map<string, number>();

function textWidth(text: string, style: string | readonly string[], kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / ui.preferences().scale;
}
const buttonWidth = (text: string, style: readonly string[]): number => textWidth(text, style, "button") + 2;

interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; selected?: boolean; act: () => void; content?: () => void }
const PLAIN = ["btn"];
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): boolean {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const s: ui.Style = width != null ? { width } : {};
  if (b.content) opts.content = b.content;
  else if (width != null && buttonWidth(b.text, style) > width) {
    const inner = width - 36;
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) { b.act(); return true; }
  return false;
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, align: "start" | "center" | "end" = "start", gap = 8): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b.text, b.style ?? PLAIN));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b.text, b.style ?? PLAIN) > width ? width : null);
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align, width });
}
/** A column of full-width buttons (the pause menu's groups, the rails). */
function stack(label: string, list: Btn[], width: number, gap = 8): void {
  ui.column(label, () => { for (const b of list) button(b, width); }, { spacing: gap, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls: string | readonly (string | ui.Style)[] = "body", id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = typeof cls === "string" ? [cls] : [...cls];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: "h1" | "h2" | "h3" | "results-h1" | "settings-h2", text: string, width: number, id?: string): void {
  if (ui.measureText(text, { kind: "heading", style: cls }).width / ui.preferences().scale <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
/** A grid of cards (CSS repeat(auto-fit, minmax(min, 1fr))) built by `cell(i, width)`. */
function cardGrid(label: string, count: number, width: number, min: number, gap: number, cell: (i: number, w: number) => void): void {
  const cols = Math.max(1, Math.min(count, Math.floor((width + gap) / (Math.min(min, width) + gap))));
  const cw = (width - gap * (cols - 1)) / cols;
  ui.column(label, () => {
    for (let i = 0; i < count; i += cols) {
      ui.row(`${label}-r${i}`, () => { for (let j = i; j < Math.min(count, i + cols); j++) cell(j, cw); }, { spacing: gap, align: "stretch" });
    }
  }, { spacing: gap, width });
}
const upper = (s: string): string => s.toLocaleUpperCase();

// ------------------------------------------------------------------ glyphs (no symbol fonts)
function starPts(cx: number, cy: number, r: number): [number, number][] {
  const p: [number, number][] = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rr = i % 2 ? r * 0.42 : r; p.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); }
  return p;
}
function drawStar(cx: number, cy: number, r: number, filled: boolean, color: string): void {
  const p = starPts(cx, cy, r);
  if (filled) { draw.polygon(p, color); return; }
  for (let i = 0; i < p.length; i++) { const a = p[i]!, b = p[(i + 1) % p.length]!; draw.line(a[0], a[1], b[0], b[1], color, Math.max(1, r * 0.14)); }
}
/** n of 3 stars `size` logical pixels each. */
function stars(n: number, size: number, color: string, label = ""): void {
  ui.widget(label, {
    role: label ? "image" : "none", size: { width: size * 3 + size * 0.5, height: size },
    draw: (r) => { const s = r.height; for (let i = 0; i < 3; i++) drawStar(r.x + s / 2 + i * s * 1.25, r.y + s / 2, s / 2, i < n, color); },
  });
}
function diamond(size: number, color: string): void {
  ui.widget("", { role: "none", size: { width: size, height: size }, draw: (r) => {
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2, h = r.width / 2;
    draw.polygon([[cx, cy - h], [cx + h * 0.8, cy], [cx, cy + h], [cx - h * 0.8, cy]], color);
  } });
}

// ------------------------------------------------------------------ the frame
let topH = 61;
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  const playing = app.screen === "play" && !!session;
  pageBackground(L, playing);
  topbar(L, playing);
  if (playing) playScreen(L);
  else {
    switch (app.screen) {
      case "title": titleScreen(L); break;
      case "modes": modesScreen(L); break;
      case "setup": setupScreen(L); break;
      case "results": resultsScreen(L); break;
      case "help": helpScreen(L); break;
      case "settings": settingsScreen(L); break;
      case "progression": progressionScreen(L); break;
      default: break;
    }
  }
  overlays(L);
  countdown(L);
  resolvingPill(L);
  toasts(L, playing);
  errorBanner(L);
  // a screen that just opened focuses its first control once laid out
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    ui.setFocus(app.focusNext);
    if (age >= 2) app.focusNext = null;
  }
}

/** The shell's background: radial-gradient(120% 90% at 50% 0%, fog, transparent 60%) over linear(bg → bg-2). Over the shelf in play, outside the playfield. */
let playfield: { x: number; y: number; w: number; h: number } | null = null;
function pageBackground(L: Layout, playing: boolean): void {
  const f = frame();
  const pal = currentPalette();
  const style: ui.Style = {
    background: [
      { type: "radial", center: { x: 0.5, y: 0 }, radius: { x: 0.6 * 2, y: 0.9 }, stops: [{ color: mix(pal.fog, 0.9, "transparent"), at: 0 }, { color: mix(pal.fog, 0, "transparent"), at: 0.6 }] },
      { type: "linear", angle: 180, stops: [pal.bg, pal.bg2] },
    ],
  };
  if (!playing || !playfield) { draw.box(0, 0, f.width, f.height, style); return; }
  // around the playfield: four clipped copies of the page, a rounded inner edge, the border
  const p = playfield;
  const parts = [
    { x: 0, y: 0, width: f.width, height: p.y },
    { x: 0, y: p.y + p.h, width: f.width, height: f.height - p.y - p.h },
    { x: 0, y: p.y, width: p.x, height: p.h },
    { x: p.x + p.w, y: p.y, width: f.width - p.x - p.w, height: p.h },
  ];
  for (const c of parts) if (c.width > 0 && c.height > 0) draw.box(0, 0, f.width, f.height, style, { clip: c });
  const k = L.sc, R = 19.6, B = 24;
  draw.box(p.x - B * k, p.y - B * k, p.w + 2 * B * k, p.h + 2 * B * k, { border: { width: B, color: pal.bg }, radius: R + B });
  draw.box(p.x, p.y, p.w, p.h, {
    radius: R, border: { width: 1, color: PANEL_BORDER },
    background: [{ type: "radial", center: { x: 0.5, y: 0.3 }, radius: { x: 0.8, y: 0.6 }, stops: [{ color: mix(pal.fog, 0.18, "transparent"), at: 0 }, { color: mix(pal.fog, 0, "transparent"), at: 0.7 }] }],
  });
}

// ------------------------------------------------------------------ top bar
function topbar(L: Layout, playing: boolean): void {
  const drawers = playing && L.compact;
  const r = ui.place("topbar", "top-start", () => {
    ui.row("topbar-row", () => {
      if (drawers) {
        if (ui.style("icon-btn").id("btn-drawer-left").button(tr("Toggle objective panel"), { content: () => menuGlyph() })) openOverlay("drawer-left");
      }
      ui.column("brand-col", () => { ui.style("brand").label("Chromatic Pour"); }, { grow: 1, align: "start" });
      if (drawers) {
        if (ui.style("icon-btn").id("btn-drawer-right").button(tr("Toggle actions panel"), { content: () => flaskGlyph() })) openOverlay("drawer-right");
      }
      profileChip(L);
    }, { width: L.lw - 24, height: 44, spacing: 8, align: "center" });
  }, { style: "topbar", width: L.lw });
  topH = r.height / L.sc;
}
function menuGlyph(): void {
  ui.widget("", { role: "none", size: { width: 18, height: 18 }, draw: (r) => {
    for (const dy of [0.2, 0.5, 0.8]) draw.line(r.x + r.width * 0.1, r.y + r.height * dy, r.x + r.width * 0.9, r.y + r.height * dy, INK, Math.max(1.5, r.height * 0.1));
  } });
}
function flaskGlyph(): void {
  ui.widget("", { role: "none", size: { width: 18, height: 18 }, draw: (r) => {
    const x = r.x, y = r.y, w = r.width, h = r.height, lw = Math.max(1.5, h * 0.09);
    draw.line(x + w * 0.38, y + h * 0.08, x + w * 0.38, y + h * 0.42, INK, lw);
    draw.line(x + w * 0.62, y + h * 0.08, x + w * 0.62, y + h * 0.42, INK, lw);
    draw.line(x + w * 0.38, y + h * 0.42, x + w * 0.1, y + h * 0.92, INK, lw);
    draw.line(x + w * 0.62, y + h * 0.42, x + w * 0.9, y + h * 0.92, INK, lw);
    draw.line(x + w * 0.1, y + h * 0.92, x + w * 0.9, y + h * 0.92, INK, lw);
    draw.line(x + w * 0.3, y + h * 0.08, x + w * 0.7, y + h * 0.08, INK, lw);
  } });
}
function profileChip(L: Layout): void {
  const name = platform.displayName();
  const text = name || tr("Guest — sign in");
  const label = name ? tr("Signed in as {name}. Account options", { name }) : tr("Playing as guest. Sign in");
  const maxW = Math.min(L.phone ? 180 : 260, L.lw * 0.45);
  if (ui.style("chip", { text: { overflow: "ellipsis" }, width: Math.min(maxW, buttonWidth(text, ["chip"]) + 16) }).id("btn-profile").button(label, { content: () => ui.style({ text: { overflow: "ellipsis" } }).label(text) })) {
    audio.play("ui");
    if (platform.signedIn()) notify(() => tr("Signed in as {name}.", { name: platform.displayName() }));
    else void requestSignIn().catch(() => notify(() => tr("Sign-in is unavailable right now — playing as guest. Progress stays on this device.")));
  }
}

// ------------------------------------------------------------------ play
function hud(): { objective: string; progress: string; strip: string; moves: string; timer: string; danger: boolean; limit: string | null; limitDanger: boolean } {
  const s = session!;
  const st = s.state;
  const level = round.level!;
  const total = st?.vessels.length ?? 0;
  const done = st ? st.vessels.filter((_v: number[], i: number) => rules.isVesselComplete(st, i)).length : 0;
  const moves = st?.moves ?? 0;
  const elapsed = s.elapsedMs();
  const lim = st?.constraints?.timeLimitMs;
  const remaining = lim ? lim - elapsed : 0;
  let limit: string | null = null, limitDanger = false;
  const c = (st?.constraints || {}) as { moveLimit?: number; timeLimitMs?: number };
  if (c.moveLimit) { limit = tr("Moves {n} / {limit}", { n: moves, limit: c.moveLimit }); limitDanger = moves >= c.moveLimit - 3; }
  else if (c.timeLimitMs) limit = tr("Time limit {time}", { time: fmtTime(c.timeLimitMs) });
  return {
    objective: tr("Unify every vessel — {n} colors", { n: level.colorCount }),
    progress: tr("Harmonized {done} of {total} vessels", { done, total }),
    strip: tr("{done}/{total} unified", { done, total }),
    moves: tr(moves === 1 ? "{n} move" : "{n} moves", { n: moves }),
    timer: lim ? `−${fmtTime(Math.max(0, remaining))}` : fmtTime(elapsed),
    danger: !!lim && remaining < 15000,
    limit, limitDanger,
  };
}
interface Action { id: string; text: string; enabled: boolean; act: () => void; hidden?: boolean }
function actions(): Action[] {
  const s = session!;
  const busy = round.inputLocked || !(app.phase === "active" || app.phase === "tutorial");
  const list: Action[] = [
    { id: "btn-undo", text: tr("Undo"), enabled: !!s.canUndo && !busy, act: doUndo },
    { id: "btn-hint", text: tr("Hint"), enabled: !busy, act: doHint, hidden: !settings.hintsEnabled },
    { id: "btn-restart", text: tr("Restart"), enabled: !busy, act: doRestart },
    { id: "btn-pause", text: tr("Pause"), enabled: app.phase === "active", act: pauseRound },
  ];
  return list.filter((a) => !a.hidden);
}
function railLeft(w: number): void {
  const h = hud();
  ui.style("rail-title").label(upper(tr("Working")));
  para(h.objective, w, "objective", "hud-objective");
  para(h.progress, w, "progress", "hud-progress");
  if (h.limit) ui.style(h.limitDanger ? "limit-danger" : "limit-badge").id("hud-limit").label(h.limit);
  para(levelName(round.level), w, "levelname", "hud-level");
}
function railRight(w: number): void {
  const h = hud();
  ui.style("rail-title").label(upper(tr("Actions")));
  ui.column("rail-actions", () => {
    for (const a of actions()) button({ id: a.id, text: a.text, style: ["btn", "btn-ghost"], disabled: !a.enabled, act: () => { ui.setFocus(null); a.act(); } }, w);
  }, { spacing: 9.6, width: w });
  ui.row("rail-status", () => {
    ui.style(h.danger ? "timer-danger" : "timer").id("hud-timer").label(h.timer);
    ui.spacer();
    ui.style("moves").id("hud-moves").label(h.moves);
  }, { style: "rail-status", width: w, align: "center" });
}
function statusStrip(L: Layout, w: number): void {
  const h = hud();
  ui.row("strip", () => {
    ui.style("strip-objective").id("strip-objective").label(h.strip);
    ui.spacer();
    ui.style("strip-item").id("strip-moves").label(h.moves);
    ui.style(h.danger ? "strip-danger" : "strip-item").id("strip-timer").label(h.timer);
    if (h.limit) ui.style(h.limitDanger ? "strip-danger" : "strip-item").id("strip-limit").label(h.limit);
  }, { style: "strip", width: w, spacing: L.shortLand ? 12.8 : 14.4, align: "center" });
}
function tray(L: Layout): number {
  const acts = actions();
  const gap = 8;
  const w = L.lw;
  const bw = (w - 16 - gap * (acts.length - 1)) / acts.length;
  const r = ui.place("tray", "bottom-start", () => {
    ui.row("tray-row", () => {
      const list = settings.leftHanded ? [...acts].reverse() : acts;
      for (const a of list) button({ id: `tray-${a.id}`, text: a.text, style: ["btn", "btn-ghost", "tray-btn"], disabled: !a.enabled, act: () => { ui.setFocus(null); a.act(); } }, bw);
    }, { spacing: gap, width: w - 16 });
  }, { style: "tray", width: w });
  return r.height / L.sc;
}

function playScreen(L: Layout): void {
  const pad = L.shortLand ? 8 : 16;
  let top = topH + pad, bottom = L.lh - pad;
  let left = pad, right = L.lw - pad;
  if (L.phone || L.shortLand) {
    // the status strip under the top bar, the tray along the bottom
    const r = ui.place("strip-place", { anchor: "top-start", x: 0, y: topH }, () => statusStrip(L, L.lw), { width: L.lw });
    top = topH + r.height / L.sc + (L.shortLand ? 6 : 16);
    bottom = L.lh - tray(L) - (L.shortLand ? 6 : 12);
  }
  if (L.wide) {
    const railW = Math.min(256, Math.max(192, (L.lw - 64) * 0.2));
    const leftX = settings.leftHanded ? L.lw - pad - railW : pad;
    const rightX = settings.leftHanded ? pad : L.lw - pad - railW;
    ui.place("rail-left", { anchor: "top-start", x: leftX, y: top }, () => railLeft(railW - 32), { style: "rail", width: railW, spacing: 9.6 });
    ui.place("rail-right", { anchor: "top-start", x: rightX, y: top }, () => railRight(railW - 32), { style: "rail", width: railW, spacing: 9.6 });
    left = pad + railW + 16;
    right = L.lw - pad - railW - 16;
  } else if (L.shortLand) {
    const railW = Math.min(176, Math.max(144, L.lw * 0.2));
    const x = settings.leftHanded ? L.lw - pad - railW : pad;
    ui.place("rail-left", { anchor: "top-start", x, y: top }, () => railLeft(railW - 20), { style: ["rail", "rail-tight"], width: railW, spacing: 6 });
    if (settings.leftHanded) right = L.lw - pad - railW - 9.6; else left = pad + railW + 9.6;
  }
  const pw = Math.max(80, right - left), ph = Math.max(80, bottom - top);
  playfield = { x: (L.ox + left) * L.sc, y: (L.oy + top) * L.sc, w: pw * L.sc, h: ph * L.sc };
  render.setPlayfield(playfield.x, playfield.y, playfield.w, playfield.h, frame().width, frame().height);
  // the vessels, centred in the playfield
  const st = session!.state;
  if (st) {
    const BL = layoutBoard(st.vessels.length, st.capacity, pw, ph, L.vw, L.vh, L.shortLand);
    ui.place("board-place", { anchor: "top-start", x: left + (pw - BL.width) / 2, y: top + (ph - BL.height) / 2 }, () => buildBoard(BL));
  }
  // Skip animation (the pour's choreography)
  if (round.inputLocked && round.pour) {
    const text = tr("Skip animation");
    const bw = buttonWidth(text, ["btn", "btn-primary", "skip-btn"]);
    ui.place("skip", { anchor: "top-start", x: right - bw - 16, y: bottom - 60 }, () => {
      button({ id: "btn-skip", text, style: ["btn", "btn-primary", "skip-btn"], act: skipPour });
    });
  }
  lessonCard(L, left, pw, bottom);
  playfieldDrag(L, left, top, pw, ph);
}
function lessonCard(L: Layout, left: number, pw: number, bottom: number): void {
  const t = round.tutorial;
  const step = currentStep();
  if (!t || !step) return;
  const w = L.shortLand ? Math.min(L.lw * 0.46, 352) : Math.min(544, L.lw - 32);
  const x = L.shortLand ? 8 : Math.max(16, left + (pw - w) / 2);
  const pad = L.phone || L.shortLand ? 12 : 20;
  ui.place("lesson-card", { anchor: "top-start", x, y: bottom - (lastHeight.get("lesson-card") ?? 90) - 8 }, () => {
    const r = ui.column("lesson-body", () => {
      para(upper(tr("{lesson} — step {n} of {total}", { lesson: tr(t.lesson.title || "Lesson"), n: t.stepIndex + 1, total: t.lesson.steps.length })), w - pad * 2, ["card-kicker", ...(L.phone || L.shortLand ? [{ text: { size: 11 } } as ui.Style] : [])], "lesson-kicker");
      para(step.text ? tr(step.text) : "", w - pad * 2, ["tutorial-text", ...(L.phone || L.shortLand ? [{ text: { size: L.shortLand ? 13.6 : 14.7 } } as ui.Style] : [])], "lesson-text");
    }, { spacing: 6, width: w - pad * 2 });
    lastHeight.set("lesson-card", r.height / L.sc + pad * 2);
  }, { style: ["tutorial-card", ...(pad < 20 ? ["tutorial-tight"] : [])], width: w });
}
// A drag on the playfield outside the vessels pans the shelf a little (js/render.js).
let drag: { x: number; y: number; moved: boolean } | null = null;
let fieldRect = { x: 0, y: 0, w: 0, h: 0 };
function playfieldDrag(L: Layout, x: number, y: number, w: number, h: number): void {
  fieldRect = { x: (L.ox + x) * L.sc, y: (L.oy + y) * L.sc, w: w * L.sc, h: h * L.sc };
}
function inField(x: number, y: number): boolean {
  return app.screen === "play" && !!session && !app.overlays.length && x >= fieldRect.x && y >= fieldRect.y && x <= fieldRect.x + fieldRect.w && y <= fieldRect.y + fieldRect.h;
}
onPointerButton((e) => {
  if (e.button !== 0) return;
  if (e.pressed) drag = inField(e.x, e.y) && !ui.pointerOver() ? { x: e.x, y: e.y, moved: false } : null;
  else drag = null;
});
onPointerMove((x, y) => {
  if (!drag) return;
  const k = ui.preferences().scale;
  if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) > 8 * k) drag.moved = true;
  if (drag.moved) render.dragPan((x - drag.x) / k, (y - drag.y) / k);
  drag.x = x; drag.y = y;
});
onTouch((e) => {
  if (!e.primary) return;
  if (e.phase === "start") drag = inField(e.x, e.y) && !ui.pointerOver() ? { x: e.x, y: e.y, moved: false } : null;
  else if (e.phase === "end" || e.phase === "cancel") drag = null;
});

// ------------------------------------------------------------------ screens
/** A screen: its column under the top bar (max `maxW`, the old `.screen`), scrolling when taller than the room. */
function screen(key: string, L: Layout, maxW: number, build: (inner: number) => void, align: "start" | "center" = "start"): void {
  const avail = Math.max(80, L.lh - topH);
  const width = Math.max(200, Math.min(maxW, L.lw - 32));
  const h = lastHeight.get(key) ?? 0;
  ui.place(`scr-${key}`, { anchor: "top-start", x: 0, y: topH }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-panel`, () => build(width), { width, spacing: 16, align, padding: { top: 16, bottom: 24 } });
      lastHeight.set(key, r.height / L.sc);
    };
    if (h > avail) {
      ui.scrollArea(`${key}-scroll`, { width: L.lw, height: avail }, () => {
        ui.column(`${key}-scroll-col`, body, { width: L.lw - 12, align: "center" });
      });
    } else ui.column(`${key}-center`, body, { width: L.lw, align: "center" });
  }, { width: L.lw, height: avail });
}

function msToNextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - nowMs;
}
function dailyCountdown(): string {
  const ms = msToNextUtcMidnight(platform.nowMs());
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return tr("Next draught in {h}h {m}m {s}s", { h, m: String(m).padStart(2, "0"), s: String(s).padStart(2, "0") });
}
/** The key art (object-fit: cover, rounded, framed; its foot fading into the page as the CSS mask did). */
function art(path: string, w: number, h: number, id: string, fade: boolean): void {
  const pal = currentPalette();
  ui.style({
    width: w, height: h, radius: 14, border: { width: 1, color: PANEL_BORDER },
    background: [{ image: path, size: "cover" }, "#1c1611"],
    shadow: fade ? [{ y: 12, blur: 40, color: "#00000073" }, { blur: 48, color: pal.accentSoft }] : { y: 10, blur: 30, color: "#00000066" },
    decorations: fade ? [{ fill: { type: "linear", angle: 180, stops: [{ color: mix(pal.bg, 0, "transparent"), at: 0 }, pal.bg] }, start: 0, end: 0, bottom: 0, height: h * 0.3, over: true }] : [],
  }).id(id).column(`${id}-box`, () => undefined, { width: w, height: h });
}

function titleScreen(L: Layout): void {
  const p = progression();
  screen("title", L, 1152, (w) => {
    // hero
    const artW = Math.min(w, 896);
    const artH = Math.min(L.shortLand ? 72 : Math.max(144, Math.min(L.vh * 30, 320)), artW * 9 / 16);
    art("assets/title-art.webp", artW, artH, "title-art", true);
    const wm = L.shortLand ? 38.4 : Math.max(41.6, Math.min(L.vw * 9, 80));
    ui.row("wordmark", () => {
      ui.style("wordmark-a", { text: { size: wm } }).label("Chromatic");
      ui.style("wordmark-b", { text: { size: wm } }).label("Pour");
    }, { align: "end" });
    para(tr("An alchemist’s sorting ritual. Pour every hue home."), w, "tagline", "tagline", true);
    const playW = Math.min(Math.max(320, buttonWidth(playSubLabel(), ["btn", "btn-primary", "btn-play"]) + 20), L.vw * 80 + 40, w);
    button({
      id: "btn-play", text: tr("Play"), style: ["btn", "btn-primary", "btn-play"],
      act: () => { audio.play("ui"); onPlay(); },
      content: () => ui.column("play-face", () => {
        ui.style("play-label").label(upper(tr("Play")));
        para(playSubLabel(), playW - 70, "play-sub", "play-sub", true);
      }, { align: "center", spacing: 2 }),
    }, playW);
    // cards
    const dailyBest = storage.loadBestScore(`daily-${todayKey()}`) as { score?: number } | null;
    const next = nextJourneyStage(p);
    const cards: { id: string; label: string; act: () => void; face: (cw: number) => void }[] = [
      { id: "card-daily", label: tr("Daily draught"), act: () => openSetup("daily"), face: (cw) => {
        ui.style("card-kicker").label(upper(tr("Daily draught")));
        ui.style("card-title").label(todayKey());
        para(dailyBest ? tr("Best score {score}", { score: fmtScore(dailyBest.score ?? 0) }) : tr("Not attempted yet"), cw, "card-line");
        para(dailyCountdown(), cw, "card-countdown", "daily-countdown");
      } },
      { id: "card-journey", label: tr("Journey"), act: () => openSetup("journey"), face: (cw) => {
        ui.style("card-kicker").label(upper(tr("Journey")));
        para(tr("{n} / {total} stars", { n: totalJourneyStars(p), total: content.JOURNEY.length * 3 }), cw, "card-title");
        para(next ? tr("Next: {name}", { name: levelName(next) }) : tr("The whole shelf glows. Mastery awaits."), cw, "card-line");
      } },
      ...([[N("Practice"), "practice"], [N("Challenge"), "challenge"], [N("Score chase"), "score-chase"]] as const).map(([label, mode]) => ({
        id: `card-${mode}`, label: tr(label), act: () => openSetup(mode as ModeKind), face: (cw: number) => { para(tr(label), cw, "small-label", undefined, true); },
      })),
    ];
    cardGrid("title-cards", cards.length, w, 208, 14.4, (i, cw) => {
      const c = cards[i]!;
      const small = i >= 2;
      if (ui.style("card", ...(small ? ["card-small"] : []), { width: cw }).id(c.id).button(c.label, {
        content: () => ui.column(`${c.id}-face`, () => c.face(cw - 36), { spacing: 4.8, width: cw - 36, align: small ? "center" : "start", justify: "center" }),
      })) { audio.play("ui"); c.act(); }
    });
    const nav: Btn[] = [
      { id: "btn-title-help", text: tr("Help"), style: ["btn", "btn-ghost"], act: () => openSub("help") },
      { id: "btn-title-settings", text: tr("Settings"), style: ["btn", "btn-ghost"], act: () => openSub("settings") },
      { id: "btn-title-progress", text: tr("Progress"), style: ["btn", "btn-ghost"], act: goProgression },
      { id: "btn-title-modes", text: tr("All modes"), style: ["btn", "btn-ghost"], act: goModes },
    ];
    const link = platform.inviteLink();
    if (link) nav.push({ id: "btn-title-invite", text: pt("invite"), style: ["btn", "btn-ghost"], act: () => {
      audio.play("ui");
      try { clipboard.writeText(link); notify(() => pt("inviteCopied")); } catch { notify(() => pt("inviteFailed")); }
    } });
    if (!platform.signedIn()) nav.push({ id: "btn-title-signin", text: pt("signIn"), style: ["btn", "btn-primary"], act: () => { void requestSignIn().catch(() => undefined); } });
    flow("title-nav", nav, w, "center");
    if (platform.signedIn()) para(pt("signedInAs", { name: platform.displayName() }), w, "dim", "title-signed-in", true);
    else if (app.signedOut) para(pt("signedOut"), w, "dim", "title-signed-out", true);
  }, "center");
}

const MODE_CARDS: { kind: ModeKind; name: string; rules: string; duration: string; ranked: boolean; assists: string }[] = [
  { kind: "lesson", name: N("Learn"), rules: N("Guided lessons that teach one rule at a time — you perform each move."), duration: N("~5 minutes"), ranked: false, assists: N("Hints always on") },
  { kind: "journey", name: N("Journey"), rules: N("Forty authored stages of growing subtlety. Earn up to three stars each."), duration: N("2–4 min per stage"), ranked: false, assists: N("Undo & hints allowed") },
  { kind: "daily", name: N("Daily draught"), rules: N("One shared seed per UTC day. Same shelf for every alchemist."), duration: N("~3 minutes"), ranked: true, assists: N("Assists allowed, recorded") },
  { kind: "practice", name: N("Practice"), rules: N("Your difficulty, your seed. Experiment freely."), duration: N("You choose"), ranked: false, assists: N("Undo & hints allowed") },
  { kind: "challenge", name: N("Challenge"), rules: N("Constrained brews: move limits, time limits, no undo."), duration: N("2–5 minutes"), ranked: true, assists: N("As the constraint allows") },
  { kind: "score-chase", name: N("Score chase"), rules: N("One board, endless rivalry. Climb the global or friends ladder."), duration: N("~3 minutes"), ranked: true, assists: N("Assists allowed, recorded") },
];
function badge(ranked: boolean, text: string): void {
  ui.style("badge", ...(ranked ? ["badge-ranked"] : [])).label(upper(text));
}
function modesScreen(L: Layout): void {
  screen("modes", L, 1152, (w) => {
    heading("h1", tr("Choose your working"), w, "modes-h");
    para(tr("Every mode uses the same rule: pour contiguous color layers until each vessel is empty or holds one color."), w, "lede");
    cardGrid("mode-grid", MODE_CARDS.length, w, 256, 14.4, (i, cw) => {
      const m = MODE_CARDS[i]!;
      const ci = cw - 36;
      if (ui.style("card", { width: cw, minHeight: 136 }).id(`mode-${m.kind === "score-chase" ? "chase" : m.kind}`).button(tr(m.name), {
        content: () => ui.column(`mode-${m.kind}-face`, () => {
          ui.style("card-title").label(tr(m.name));
          badge(m.ranked, m.ranked ? tr("Ranked") : tr("Unranked"));
          para(tr(m.rules), ci, "card-line");
          para(`${tr(m.duration)} · ${tr(m.assists)}`, ci, "card-dim");
        }, { spacing: 4.8, width: ci }),
      })) { audio.play("ui"); openSetup(m.kind); }
    });
    button({ id: "btn-modes-back", text: tr("Back to title"), style: ["btn", "btn-ghost"], act: goTitle });
  });
}

// --- setups ---
function setupHeader(w: number, title: string, lede: string, ranked: boolean): void {
  heading("h1", title, w, "setup-title");
  para(lede, w, "lede", "setup-lede");
  badge(ranked, ranked ? tr("Ranked — validated by replay") : tr("Unranked — no effect on ratings"));
}
function setupScreen(L: Layout): void {
  const kind = app.setupKind;
  screen("setup", L, 1152, (w) => {
    switch (kind) {
      case "journey": setupJourney(w); break;
      case "practice": setupPractice(w); break;
      case "challenge": setupChallenge(w); break;
      case "daily": setupDaily(w); break;
      case "score-chase": setupChase(w); break;
      case "lesson": setupLearn(w); break;
    }
    button({ id: "btn-setup-back", text: tr("All modes"), style: ["btn", "btn-ghost"], act: goModes }, w);
  });
}
function setupJourney(w: number): void {
  setupHeader(w, tr("The Journey"), tr("Forty stages of growing subtlety. Mastery stages (◆) test combined mechanics."), false);
  const p = progression();
  const J = content.JOURNEY;
  const firstOpen = Math.max(0, J.findIndex((e) => !(p.journey as Record<string, unknown>)[e.id]));
  const allDone = J.every((e) => (p.journey as Record<string, unknown>)[e.id]);
  const accent = currentPalette().accent;
  const gap = 9.6;
  const cols = Math.max(1, Math.floor((w + gap) / (67.2 + gap)));
  const cw = (w - gap * (cols - 1)) / cols;
  ui.column("stage-grid", () => {
    for (let i = 0; i < J.length; i += cols) {
      ui.row(`stage-r${i}`, () => {
        for (let j = i; j < Math.min(J.length, i + cols); j++) {
          const e = J[j]!;
          const rec = (p.journey as Record<string, { stars?: number }>)[e.id];
          const locked = !allDone && j > firstOpen;
          const n = rec ? rec.stars || 0 : 0;
          const label = locked ? tr("Stage {n}, locked", { n: j + 1 })
            : tr(e.mastery ? "Stage {n}, {name}, mastery, {stars} of 3 stars" : "Stage {n}, {name}, {stars} of 3 stars", { n: j + 1, name: levelName(e), stars: n });
          if (ui.style(e.mastery ? "stage-mastery" : "stage-cell", { width: cw }).id(`stage-${j}`).button(label, {
            disabled: locked,
            content: () => ui.stack(`stage-${j}-face`, () => {
              ui.column(`stage-${j}-col`, () => {
                ui.style("stage-num").label(String(j + 1));
                stars(n, 10.4, accent);
              }, { align: "center", spacing: 2.4, width: cw - 10, justify: "center" });
              if (e.mastery) ui.column(`stage-${j}-m`, () => diamond(10, accent), { align: "end", width: cw - 14 });
            }),
          })) { audio.play("ui"); startLevel(journeyLevel(e), { ranked: false, boardKey: null }); }
        }
      }, { spacing: gap, align: "stretch" });
    }
  }, { spacing: gap, width: w });
}
let seedDraft: string | null = null;
function setupPractice(w: number): void {
  setupHeader(w, tr("Practice bench"), tr("Pick a difficulty and a seed. The seed is the recipe — share it to share the exact shelf."), false);
  const diffs = content.DIFFICULTIES;
  cardGrid("diff-grid", diffs.length, w, 208, 14.4, (i, cw) => {
    const d = diffs[i]!;
    const chosen = d.id === app.practiceDifficulty;
    if (ui.style("card", { width: cw }).id(`diff-${d.id}`).button(tr(d.label || d.id), {
      selected: chosen,
      content: () => ui.column(`diff-${d.id}-face`, () => {
        ui.style("card-title").label(tr(d.label || d.id));
        para(tr("{colors} colors · {empty} empty vessels", { colors: d.colorCount, empty: d.emptyVessels }), cw - 36, "card-line");
        if (d.desc) para(tr(d.desc), cw - 36, "card-dim");
      }, { spacing: 4.8, width: cw - 36 }),
    })) { app.practiceDifficulty = d.id; audio.play("ui"); }
  });
  if (seedDraft === null) seedDraft = app.practiceSeed;
  ui.row("seed-row", () => {
    ui.column("seed-col", () => {
      ui.style("dim", { text: { font: "sans-serif", size: 13.6 } }).label(tr("Seed"));
      seedDraft = ui.textField("practice-seed", seedDraft ?? "", { maxChars: 48, width: Math.min(288, w - 120), placeholder: tr("Practice seed") });
      app.practiceSeed = (seedDraft ?? "").trim() || app.practiceSeed;
    }, { spacing: 4.8 });
    button({ id: "btn-reroll", text: tr("Re-roll"), style: ["btn", "btn-ghost"], act: () => { app.practiceSeed = freshSeed(); seedDraft = app.practiceSeed; audio.play("ui"); } });
  }, { spacing: 8, align: "end" });
  button({ id: "btn-practice-start", text: tr("Begin practice"), style: ["btn", "btn-primary"], act: () => { seedDraft = null; startPractice(); } });
}
function setupChallenge(w: number): void {
  setupHeader(w, tr("Challenges"), tr("Constrained brews for exacting alchemists. Constraints are part of the leaderboard recipe."), true);
  cardGrid("challenge-grid", content.CHALLENGES.length, w, 256, 14.4, (i, cw) => {
    const c = content.CHALLENGES[i]!;
    if (ui.style("card", { width: cw, minHeight: 136 }).id(`challenge-${c.id}`).button(tr(c.name), {
      content: () => ui.column(`challenge-${c.id}-face`, () => {
        ui.style("card-title").label(tr(c.name));
        if (c.desc) para(tr(c.desc), cw - 36, "card-line");
        para(constraintText(c.constraints), cw - 36, "card-dim");
      }, { spacing: 4.8, width: cw - 36 }),
    })) startLevel(challengeLevel(c), { ranked: true, boardKey: c.id });
  });
}
function setupDaily(w: number): void {
  const date = todayKey();
  const level = content.dailyLevel(date);
  try { content.parFor(level); } catch { /* par shown once resolved */ }
  setupHeader(w, tr("Daily draught — {date}", { date }), tr("One shared shelf per UTC day, synchronized to the host clock. Identical recipe for every alchemist."), true);
  const best = storage.loadBestScore(level.id) as { score?: number } | null;
  ui.column("daily-panel", () => {
    para(`${tr("{colors} colors · par {par} moves", { colors: level.colorCount, par: level.parMoves ?? "—" })} · ${constraintText(level.constraints)}`, w - 40, "body", "daily-info");
    para(best ? tr("Your best today: {score}", { score: fmtScore(best.score ?? 0) }) : tr("You have not attempted today’s draught."), w - 40, "card-dim", "daily-best");
  }, { style: "panel", width: w, spacing: 8 });
  button({ id: "btn-daily-start", text: tr("Pour today’s draught"), style: ["btn", "btn-primary"], act: startDaily });
}
function setupChase(w: number): void {
  setupHeader(w, tr("Score chase"), tr("One board, endless rivalry. Boards marked daily rotate at UTC midnight; the evergreen board never changes."), true);
  ui.row("chase-picker", () => {
    CHASE_BOARDS.forEach((b, i) => {
      button({ id: `chase-board-${i}`, text: tr(b.label), style: ["btn", "btn-ghost", { selected: { border: { color: "$accent" } } }] as unknown as string[], selected: app.chase.board === i, act: () => { audio.play("ui"); refreshChase(i); } });
    });
  }, { spacing: 8, role: "radiogroup" });
  const c = app.chase;
  ui.column("chase-table", () => {
    if (c.loading || !c.rows) para(tr("Consulting the ledger…"), w, "card-dim", "chase-status");
    else {
      const best = storage.loadBestScore(chaseBoard().key) as { score?: number; moves?: number } | null;
      const rows: { name: string; score: number; you: boolean }[] = c.ok ? c.rows.map((r) => ({ name: r.mine ? `${r.name}` : r.name, score: r.score, you: r.mine })) : best ? [{ name: tr("you"), score: best.score ?? 0, you: true }] : [];
      if (!c.ok && !best) para(tr("The ledger is unreachable — ranked submission resumes when the host responds."), w, "card-dim", "chase-status");
      else if (!rows.length) para(tr("No scores yet. The first name on this board could be yours."), w, "card-dim", "chase-status");
      else table("chase", [["#", tr("Alchemist"), tr("Score")], ...rows.slice(0, 10).map((r, i) => [String(i + 1), r.name, fmtScore(r.score)])], w, true);
    }
  }, { width: w, spacing: 4, padding: { top: 4, bottom: 4 } });
  const best = storage.loadBestScore(chaseBoard().key) as { score?: number } | null;
  para(best ? tr("Your best on this board: {score}", { score: fmtScore(best.score ?? 0) }) : tr("No local best on this board yet."), w, "card-dim", "chase-best");
  button({ id: "btn-chase-start", text: tr("Chase the score"), style: ["btn", "btn-primary"], act: startChase });
}
function setupLearn(w: number): void {
  setupHeader(w, tr("Lessons"), tr("Short guided brews. Each lesson asks you to perform the rule yourself."), false);
  if (settings.tutorialDone) para(tr("All lessons completed. Replay any time — the shelf is patient."), w, "card-dim");
  cardGrid("lesson-grid", content.LESSONS.length, w, 256, 14.4, (i, cw) => {
    const l = content.LESSONS[i]!;
    const title = l.title ? tr(l.title) : tr("Lesson {n}", { n: i + 1 });
    if (ui.style("card", { width: cw, minHeight: 100 }).id(`lesson-${l.id}`).button(title, {
      content: () => ui.column(`lesson-${l.id}-face`, () => {
        ui.style("card-title").label(title);
        para(tr(l.steps.length === 1 ? "{n} step" : "{n} steps", { n: l.steps.length }), cw - 36, "card-line");
      }, { spacing: 4.8, width: cw - 36 }),
    })) startLesson(l);
  });
}
/** A table (the old .cp-table): header row optional, the last column right-aligned, rules between rows. */
function table(label: string, rows: string[][], w: number, header: boolean, totalRow = false, negRows: Set<number> = new Set()): void {
  ui.column(`${label}-table`, () => {
    rows.forEach((row, ri) => {
      const isHead = header && ri === 0;
      const isTotal = totalRow && ri === rows.length - 1;
      ui.row(`${label}-row${ri}`, () => {
        row.forEach((cell, ci) => {
          const last = ci === row.length - 1;
          const cls = isHead || isTotal ? "th" : last ? (negRows.has(ri) ? "td-neg" : "td") : ci === 0 && !header ? "th" : "body";
          if (last) { ui.spacer(); ui.style(cls).label(cell); }
          else if (ci === 0 && row.length === 3) ui.style(cls, { width: 32 }).label(cell);
          else ui.style(cls, { text: { overflow: "ellipsis" } }).label(cell);
        });
      }, {
        width: w, spacing: 12.8, align: "center", padding: { top: 6.4, bottom: 6.4, start: 12.8, end: 12.8 },
        style: isTotal ? "trow-total" : "trow",
      });
    });
  }, { width: w });
}

// --- results ---
function resultsScreen(L: Layout): void {
  const v = app.results;
  if (!v) { goTitle(); return; }
  const r = v.result;
  const pal = currentPalette();
  screen("results", L, 704, (w) => {
    const headlineKey = TERMINAL_HEADLINES[v.reason || ""] || (v.complete ? N("Shelf harmonized!") : N("The shelf resists"));
    heading("results-h1", tr(headlineKey), w, "results-headline");
    art(v.complete ? "assets/results-harmonized.webp" : "assets/results-resists.webp", w, Math.min(w * 9 / 16, Math.max(112, Math.min(L.vh * 26, 240))), "results-art", false);
    if (v.complete && round.modeKind === "journey" || (v.complete && v.stars > 0)) stars(v.stars, 28.8, pal.accent, tr("{n} of 3 stars", { n: v.stars }));
    const bd = (r.score.breakdown || []) as { label: string; value: number }[];
    const neg = new Set<number>();
    const rows: string[][] = bd.map((row, i) => { if (row.value < 0) neg.add(i); return [tr(row.label), `${row.value < 0 ? "−" : ""}${fmtScore(Math.abs(row.value))}`]; });
    rows.push([tr("Total"), fmtScore(r.score.total)]);
    table("score", rows, Math.min(w, 640), false, true, neg);
    para(`${tr(r.moves === 1 ? "{n} move" : "{n} moves", { n: r.moves })} · ${fmtTime(r.elapsedMs)} · ${tr(r.invalidActions === 1 ? "{n} invalid action" : "{n} invalid actions", { n: r.invalidActions })}`, w, "result-stats", "results-stats");
    const a = r.assists || { hints: 0, undos: 0 };
    para(a.hints || a.undos
      ? tr("Assists used: {hints}, {undos}", { hints: tr(a.hints === 1 ? "{n} hint" : "{n} hints", { n: a.hints }), undos: tr(a.undos === 1 ? "{n} undo" : "{n} undos", { n: a.undos }) })
      : tr("No assists used — a clean pair of hands."), w, "card-dim", "results-assists");
    if (v.newAchievements.length) {
      ui.column("results-ach", () => {
        heading("h2", tr("Achievements unlocked"), w - 40);
        for (const key of v.newAchievements) {
          const meta = storage.ACHIEVEMENTS.find((x) => x.key === key);
          para(meta ? `${tr(meta.name)} — ${tr(meta.desc)}` : key, w - 40, "body", `ach-${key}`);
        }
      }, { style: "panel", width: w, spacing: 8 });
    }
    if (v.lb) {
      const lb = v.lb;
      para(lb.pending ? pt("lbPosting") : !lb.posted ? pt("lbNotPosted") : lb.rank ? pt("lbRank", { rank: lb.rank }) : pt("lbPosted"), w, lb.posted || lb.pending ? "ranked-note" : "card-dim", "results-lb");
    }
    if (v.bestBefore != null) {
      const prev = v.bestBefore.score ?? 0;
      const delta = r.score.total - prev;
      para(delta > 0 && v.complete
        ? tr("A new personal best — {delta} above your previous {prev}.", { delta: fmtScore(delta), prev: fmtScore(prev) })
        : tr("Your best remains {prev}.", { prev: fmtScore(prev) }), w, "card-dim", "results-best");
    }
    flow("results-actions", [
      { id: "btn-results-replay", text: tr("Replay"), style: ["btn", "btn-ghost"], act: replayLevel },
      { id: "results-next", text: v.next.label(), style: ["btn", "btn-primary"], act: v.next.run },
      { id: "btn-results-modes", text: tr("Change mode"), style: ["btn", "btn-ghost"], act: goModes },
      { id: "btn-results-progress", text: tr("View progress"), style: ["btn", "btn-ghost"], act: goProgression },
    ], w);
  });
}

// --- how to pour ---
function miniVessel(layers: number[], cap = 4): void {
  ui.widget("", { role: "none", size: { width: 27.2 + 4, height: 16.8 * cap + 6 + 4 }, draw: (r, st) => {
    const k = st.scale;
    const tw = 27.2 * k, sh = 16.8 * k, th = sh * cap + 6 * k;
    const x = r.x + 2 * k, y = r.y + 2 * k;
    const foot = 27.2 / 2;
    draw.box(x, y, tw, th, { background: { type: "linear", angle: 105, stops: [{ color: "#ffffff1a", at: 0 }, { color: "#ffffff05", at: 0.45 }, { color: "#0000002e", at: 1 }] }, border: { width: { top: 1, end: 2, bottom: 2, start: 2 }, color: st.highContrast ? INK : "#ece2cf57" }, radius: [10, 10, foot, foot], shadow: [{ inset: true, blur: 12, color: "#00000059" }, { y: 6, blur: 14, color: "#00000066" }] });
    for (let s = 0; s < layers.length; s++) {
      const def = colorDef(layers[s]!);
      const ly = y + th - 2 * k - (s + 1) * sh;
      draw.box(x + 2 * k, ly, tw - 4 * k, sh, { background: [{ type: "linear", angle: 180, stops: [{ color: "#ffffff4d", at: 0 }, { color: "#ffffff0a", at: 0.35 }, { color: "#00000038", at: 1 }] }, def.hex], radius: s === 0 ? [0, 0, foot - 2, foot - 2] : 0 });
    }
  } });
}
const RULE_CARDS: [string, number[][], string][] = [
  [N("A legal pour"), [[0, 0], [0], []], N("Liquid pours onto a matching color, or into an empty vessel. The whole contiguous top run moves together.")],
  [N("Colors must match"), [[1], [2]], N("Emberwine will not settle on Tidewater. A mismatched pour is refused with an explanation.")],
  [N("Contiguous runs"), [[3, 1, 1], [1]], N("Two touching layers of one color travel as a single pour — deep runs are efficient.")],
  [N("Full vessels refuse"), [[2, 2, 2, 2], [2]], N("A full vessel accepts nothing. Finished, harmonized vessels may still pour out.")],
];
const BINDING_LABELS: [string, string][] = [
  ["focus_next", N("Focus next vessel")], ["focus_prev", N("Focus previous vessel")], ["focus_up", N("Focus vessel above")], ["focus_down", N("Focus vessel below")],
  ["confirm", N("Select / pour")], ["cancel", N("Cancel selection")], ["pause", N("Pause")], ["undo", N("Undo")], ["hint", N("Hint")],
  ["restart", N("Restart round")], ["camera_reset", N("Recenter view")],
];
function keysOf(action: string): string {
  return bindings(action).filter((b) => b.device === "keyboard").map((b) => b.label).join(" / ");
}
function controlsTable(w: number): void {
  const keyW = Math.min(w * 0.45, 240);
  ui.grid("bindings", () => {
    for (const [action, label] of BINDING_LABELS) {
      para(tr(label), w - keyW - 16, "th");
      ui.row(`keys-${action}`, () => { ui.style("kbd").label(keysOf(action) || "—"); }, { justify: "end", width: keyW });
    }
  }, { columns: [{ fr: 1 }, { width: keyW, align: "end" }], gap: { row: 8, column: 16 }, width: w });
}
function helpScreen(L: Layout): void {
  screen("help", L, 1152, (w) => {
    heading("h1", tr("How to pour"), w, "help-h");
    para(tr("The keys below reflect your current control mappings. Change them in Settings."), w, "lede");
    cardGrid("rule-grid", RULE_CARDS.length, w, 256, 14.4, (i, cw) => {
      const [title, vessels, caption] = RULE_CARDS[i]!;
      ui.column(`rule-${i}`, () => {
        heading("h3", tr(title), cw - 40);
        ui.row(`rule-${i}-board`, () => { vessels.forEach((v) => miniVessel(v)); }, { spacing: 12.8, align: "end", padding: { top: 8, bottom: 8 } });
        para(tr(caption), cw - 40, ["dim", { text: { size: 14.4 } } as ui.Style]);
      }, { style: "panel", width: cw, spacing: 8 });
    });
    heading("h2", tr("Controls"), w);
    controlsTable(w);
    para(tr("Escape also cancels a selection or pauses. Gamepad: stick or D-pad moves focus, A pours, B cancels, Start pauses, X undoes, Y hints."), w, "card-dim");
    stack("help-actions", [
      { id: "btn-help-lessons", text: settings.tutorialDone ? tr("Replay the lessons") : tr("Start the lessons"), style: ["btn", "btn-primary"], act: () => openSetup("lesson") },
      { id: "btn-help-back", text: tr("Back"), style: ["btn", "btn-ghost"], act: backFromSub },
    ], Math.min(w, 416));
  });
}

// --- settings ---
const PALETTE_NAMES: Record<string, string> = { standard: N("Standard"), deuteranopia: N("Deuteranopia"), protanopia: N("Protanopia"), tritanopia: N("Tritanopia"), contrast: N("Contrast") };
function section(label: string, title: string, w: number, build: (iw: number) => void): void {
  ui.column(label, () => { heading("settings-h2", tr(title), w - 40); build(w - 40); }, { style: "panel", width: w, spacing: 11.2 });
}
function toggle(key: "labelsOnLiquids" | "hintsEnabled" | "leftHanded" | "holdToConfirm" | "cameraWide", label: string): void {
  const cur = !!settings[key];
  const next = ui.id(`set-${key}`).checkbox(tr(label), cur);
  if (next !== cur) platform.setSetting(key, next);
}
function optionsNote(w: number, note: string): void {
  para(tr(note), w, "card-dim");
  button({ id: `btn-options-${note.length}`, text: tr("Open Options"), style: ["btn", "btn-ghost"], act: () => openMenu() });
}
function settingsScreen(L: Layout): void {
  screen("settings", L, 1152, (w) => {
    heading("h1", tr("Settings"), w, "settings-h");
    section("set-audio", N("Audio"), w, (iw) => optionsNote(iw, N("Music, effects and voice volumes and mute are set in the StarHermit Options (F1).")));
    section("set-graphics", N("Graphics"), w, (iw) => {
      ui.style("field-label").label(tr("Shelf theme"));
      flow("theme-list", content.THEMES.map((t) => ({
        id: `theme-${t.id}`, text: tr(t.name || t.id), style: ["swatch-option"], selected: settings.theme === t.id,
        act: () => { audio.play("ui"); platform.setSetting("theme", t.id); },
        content: () => ui.row(`theme-${t.id}-face`, () => {
          ui.widget("", { role: "none", size: { width: 16, height: 16 }, draw: (r) => draw.box(r.x, r.y, r.width, r.height, { background: { type: "linear", angle: 135, stops: [t.bg, t.shelf, t.accent] }, radius: 4, border: { width: 1, color: "#00000066" } }) });
          ui.label(tr(t.name || t.id));
        }, { spacing: 8, align: "center" }),
      })), iw);
      toggle("cameraWide", N("Wide camera"));
      optionsNote(iw, N("Graphics quality, render scale and the frame rate are set in the StarHermit Options (F1)."));
    });
    section("set-controls", N("Controls"), w, (iw) => {
      controlsTable(iw);
      optionsNote(iw, N("Change keys and gamepad buttons in the StarHermit Options (F1)."));
      toggle("leftHanded", N("Left-handed tray"));
      toggle("holdToConfirm", N("Hold to confirm selection"));
    });
    section("set-a11y", N("Accessibility"), w, (iw) => {
      ui.style("field-label").label(tr("Color palette"));
      const sets = content.COLOR_SETS as Record<string, { hex: string }[]>;
      flow("palette-list", Object.keys(sets).map((key) => ({
        id: `palette-${key}`, text: PALETTE_NAMES[key] ? tr(PALETTE_NAMES[key]!) : key, style: ["swatch-option"], selected: settings.palette === key,
        act: () => { audio.play("ui"); platform.setSetting("palette", key); },
        content: () => ui.column(`palette-${key}-face`, () => {
          ui.widget("", { role: "none", size: { width: 5 * 16 + 4 * 3, height: 16 }, draw: (r, st) => {
            const s = 16 * st.scale, g = 3 * st.scale;
            sets[key]!.slice(0, 5).forEach((c, i) => draw.box(r.x + i * (s + g), r.y, s, s, { background: c.hex, radius: 4, border: { width: 1, color: "#00000066" } }));
          } });
          ui.label(PALETTE_NAMES[key] ? tr(PALETTE_NAMES[key]!) : key);
        }, { spacing: 5.6, align: "center" }),
      })), iw);
      toggle("labelsOnLiquids", N("Labels on liquids"));
      optionsNote(iw, N("Reduced motion, high contrast and text size are set in the StarHermit Options (F1)."));
    });
    section("set-gameplay", N("Gameplay"), w, () => { toggle("hintsEnabled", N("Hints enabled")); });
    section("set-data", N("Data"), w, (iw) => {
      const sync = platform.syncState();
      para(sync === "offline" ? tr("Offline — progress saves on this device.") : sync === "synced" ? tr("Cloud save synced.") : sync === "saving" ? tr("Saving to cloud…") : tr("Cloud sync unavailable — local copy is current."), iw, "card-dim", "settings-sync");
      flow("data-actions", [
        { id: "btn-export", text: tr("Export save"), style: ["btn", "btn-ghost"], act: exportSave },
        { id: "btn-import", text: tr("Import save"), style: ["btn", "btn-ghost"], act: importSave },
        { id: "btn-reset", text: tr("Reset all progress"), style: ["btn", "btn-danger"], act: resetProgress },
      ], iw);
    });
    button({ id: "btn-settings-back", text: tr("Back"), style: ["btn", "btn-ghost"], act: backFromSub });
  });
}
function exportSave(): void {
  try {
    const text = M.exportText(settings, progression(), new Date(platform.nowMs()).toISOString());
    files.saveAs("chromatic-pour-save.json", text, { type: "application/json" }).then((name) => {
      if (name) notify(() => tr("Save exported — keep the file somewhere safe."));
    }, () => { app.error = { key: "storage", until: frame().time + 8 }; });
  } catch { app.error = { key: "storage", until: frame().time + 8 }; }
}
function importSave(): void {
  files.open({ accept: [".json"] }).then((file) => {
    if (!file) return;
    const data = M.importText(new TextDecoder().decode(file.bytes));
    if (!data) { notify(() => tr("That save file failed its checksum — nothing was imported.")); return; }
    askConfirm(N("Import save?"), N("This replaces the settings and progress stored on this device. Your current local save will be overwritten."), N("Import and replace"), () => {
      platform.importSettings(data.settings as Record<string, unknown>);
      if (data.progression) platform.replaceProgression(data.progression);
      notify(() => tr("Save imported. The shelf remembers."));
    });
  }, () => notify(() => tr("That file could not be read as a Chromatic Pour save.")));
}
function resetProgress(): void {
  askConfirm(N("Reset all progress?"), N("Stars, streaks, achievements and bests on this device will be erased."), N("Erase progress"), () => {
    askConfirm(N("Are you certain?"), N("This cannot be undone. Exported saves can restore it later."), N("Yes, erase everything"), () => {
      platform.replaceProgression({});
      platform.clearBests();
      try { storage.clearLocalProgress(); } catch { /* best-effort */ }
      platform.setSetting("tutorialDone", false);
      notify(() => tr("Progress erased. A blank ledger, a clean shelf."));
    });
  });
}

// --- the ledger ---
function progressionScreen(L: Layout): void {
  const p = progression();
  const J = content.JOURNEY;
  const accent = currentPalette().accent;
  screen("progression", L, 1152, (w) => {
    heading("h1", tr("The ledger of the shelf"), w, "progress-h");
    const masteryStages = J.filter((e) => e.mastery);
    const masteryDone = masteryStages.filter((e) => (p.journey as Record<string, unknown>)[e.id]);
    const masteryList = (p.mastery && p.mastery.completed) || [];
    const bestDaily = Object.entries(p.dailies || {}).sort((a, b) => ((b[1] as { score?: number }).score || 0) - ((a[1] as { score?: number }).score || 0))[0];
    const next = nextJourneyStage(p);
    const panels: ((cw: number) => void)[] = [
      (cw) => {
        heading("h2", tr("Journey"), cw);
        ui.row("big-journey", () => { ui.style("big-stat").label(`${totalJourneyStars(p)} / ${J.length * 3}`); stars(1, 22, accent); }, { spacing: 8, align: "center" });
        para(tr("{n} of {total} stages harmonized.", { n: Object.keys(p.journey || {}).length, total: J.length }), cw, "body");
        para(next ? tr("Next stage: {name}", { name: levelName(next) }) : tr("Every stage complete. The shelf is yours."), cw, "card-dim");
      },
      (cw) => {
        heading("h2", tr("Mastery track"), cw);
        ui.row("big-mastery", () => { ui.style("big-stat").label(`${masteryDone.length} / ${masteryStages.length}`); diamond(20, accent); }, { spacing: 8, align: "center" });
        para(masteryStages.length ? `${tr("Mastery stages test combined mechanics.")} ${masteryList.length ? tr("{n} recorded on the mastery roll.", { n: masteryList.length }) : tr("None recorded yet.")}` : tr("Mastery stages appear as the journey grows."), cw, "card-dim");
      },
      (cw) => {
        heading("h2", tr("Achievements"), cw);
        for (const a of storage.ACHIEVEMENTS) {
          const on = !!(p.achievements as Record<string, unknown>)[a.key];
          ui.column(`ach-${a.key}`, () => {
            ui.style(on ? "ach-name-on" : "ach-name").label(tr(a.name));
            para(on ? tr("{desc} (unlocked)", { desc: tr(a.desc) }) : tr(a.desc), cw, "card-dim");
          }, { spacing: 1, ...(on ? {} : { style: "panel-locked" }) });
        }
      },
      (cw) => {
        heading("h2", tr("Figures"), cw);
        para(tr((p.sessionsPlayed || 0) === 1 ? "{n} round played" : "{n} rounds played", { n: p.sessionsPlayed || 0 }), cw, "body");
        para(tr((p.streak || 0) === 1 ? "Daily streak: {n} day" : "Daily streak: {n} days", { n: p.streak || 0 }), cw, "body");
        para(bestDaily ? tr("Best daily: {score} ({date})", { score: fmtScore((bestDaily[1] as { score?: number }).score || 0), date: bestDaily[0] }) : tr("No daily draught poured yet."), cw, "body");
      },
    ];
    cardGrid("progress-grid", panels.length, w, 272, 14.4, (i, cw) => {
      ui.column(`progress-panel-${i}`, () => panels[i]!(cw - 40), { style: "panel", width: cw, spacing: 8 });
    });
    stack("progress-actions", [
      { id: "btn-progress-primary", text: next ? tr("Continue the Journey") : tr("Practice a shelf"), style: ["btn", "btn-primary"], act: () => {
        const n = nextJourneyStage();
        if (n) { app.setupKind = "journey"; startLevel(journeyLevel(n), { ranked: false, boardKey: null }); } else openSetup("practice");
      } },
      { id: "btn-progress-back", text: tr("Back to title"), style: ["btn", "btn-ghost"], act: goTitle },
    ], Math.min(w, 416));
  });
}

// ------------------------------------------------------------------ overlays
function dialogFrame(label: string, title: string, L: Layout, maxW: number, build: (w: number) => void): void {
  const w = Math.min(maxW, L.lw - (L.phone ? 40 : 56));
  const avail = L.lh - (L.phone ? 56 : 64);
  const h = lastHeight.get(`dlg-${label}`) ?? 0;
  const body = (): void => {
    const r = ui.column(`${label}-body`, () => {
      if (title) heading("h2", title, w, `${label}-h`);
      build(w);
    }, { spacing: 16, width: w });
    lastHeight.set(`dlg-${label}`, r.height / L.sc);
  };
  const open = ui.dialog(label, "", true, () => {
    if (h > avail) ui.scrollArea(`${label}-scroll`, { width: w + 14, height: avail }, body);
    else body();
  });
  // The Escape (or East) that opened it must not close it the same frame.
  if (!open && frame().frame !== app.overlayOpenedFrame) closeOverlay();
}
function overlays(L: Layout): void {
  const top = topOverlay();
  if (!top) return;
  switch (top) {
    case "pause": pauseOverlay(L); break;
    case "confirm": confirmOverlay(L); break;
    case "drawer-left": drawerOverlay(L, "left"); break;
    case "drawer-right": drawerOverlay(L, "right"); break;
  }
}
function pauseOverlay(L: Layout): void {
  dialogFrame("pause", tr("Paused — the alembic rests"), L, 416, (w) => {
    stack("pause-g1", [{ id: "btn-resume", text: tr("Resume"), style: ["btn", "btn-primary"], act: resumeRound }], w);
    ui.column("pause-g2", () => stack("pause-g2-btns", [
      { id: "btn-pause-restart", text: tr("Restart round"), style: ["btn", "btn-ghost"], act: () => { resumeRound(); doRestart(); } },
      { id: "btn-pause-settings", text: tr("Settings"), style: ["btn", "btn-ghost"], act: () => openSub("settings") },
      { id: "btn-pause-help", text: tr("Help"), style: ["btn", "btn-ghost"], act: () => openSub("help") },
    ], w), { style: "pause-group", width: w });
    ui.column("pause-g3", () => stack("pause-g3-btns", [
      { id: "btn-pause-leave", text: tr("Leave to title"), style: ["btn", "btn-danger"], act: () => leaveRound() },
    ], w), { style: "pause-group", width: w });
  });
}
function confirmOverlay(L: Layout): void {
  const c = app.confirm;
  if (!c) { closeOverlay(); return; }
  dialogFrame("confirm", tr(c.title), L, 416, (w) => {
    para(tr(c.body), w, "body", "confirm-body");
    stack("confirm-buttons", [
      { id: "btn-confirm-yes", text: tr(c.confirm), style: ["btn", "btn-danger"], act: confirmYes },
      { id: "btn-confirm-no", text: tr("Cancel"), style: ["btn", "btn-ghost"], act: closeOverlay },
    ], w);
  });
}
function drawerOverlay(L: Layout, side: "left" | "right"): void {
  if (!session || app.screen !== "play") { closeOverlay(); return; }
  dialogFrame(`drawer-${side}`, "", L, 288, (w) => {
    if (side === "left") railLeft(w);
    else railRight(w);
    button({ id: `btn-drawer-${side}-close`, text: tr("Close"), style: ["btn", "btn-ghost"], act: closeOverlay }, w);
  });
}

// ------------------------------------------------------------------ countdown, resolving, toasts, errors
function countdown(L: Layout): void {
  const c = app.countdown;
  if (!c) return;
  const label = c.labels[c.i]!;
  const text = label === "Go" ? tr("Go") : label;
  const age = frame().time - c.startedAt;
  const k = Math.min(1, age / 0.64);
  const reduced = ui.preferences().reducedMotion;
  const scale = reduced ? 1 : k < 0.35 ? 1.45 - 0.45 * (k / 0.35) : 1 - 0.04 * ((k - 0.35) / 0.65);
  const opacity = reduced ? 1 : k < 0.35 ? k / 0.35 : 1 - 0.08 * ((k - 0.35) / 0.65);
  const size = Math.max(64, Math.min(L.vw * 18, 144));
  ui.place("countdown", { anchor: "center" }, () => {
    ui.style("countdown", { text: { size }, scale, opacity, shadow: [] }).id("countdown").label(text);
  });
}
function resolvingPill(L: Layout): void {
  if (app.phase !== "resolving") return;
  void L;
  ui.place("resolving", { anchor: "bottom", y: 16 }, () => { ui.style("resolving").id("resolving").label(tr("Settling the shelf…")); });
}
function toasts(L: Layout, playing: boolean): void {
  if (!app.toasts.length) return;
  const w = Math.min(L.lw - 32, 480);
  const y = playing && (L.phone || L.shortLand) ? 76 : 16;
  ui.place("toasts", { anchor: "bottom", y }, () => {
    for (const t of app.toasts) {
      const text = t.text();
      const cls = ["toast", ...(t.kind === "achievement" ? ["toast-achievement"] : t.kind === "hint" ? ["toast-hint"] : [])];
      const fits = textWidth(text, cls) + 40 <= w;
      if (ui.style(...cls).id(`toast-${t.id}`).button(text, fits ? {} : { content: () => ui.style({ text: { align: "center" } }).paragraph(text, w - 40) })) dismissToast(t.id);
    }
  }, { spacing: 8, align: "center", width: w });
}
function errorBanner(L: Layout): void {
  const e = app.error;
  if (!e) return;
  const w = L.lw - 24;
  ui.place("error-banner", { anchor: "top", y: 12 }, () => {
    ui.row("error-row", () => {
      para(tr(ERROR_MESSAGES[e.key] || ERROR_MESSAGES.content!), w - 100, "body", "error-text");
      ui.spacer();
      if (ui.style("icon-btn").id("btn-error-dismiss").button(tr("Dismiss"), { content: () => ui.label("×") })) app.error = null;
    }, { width: w - 36, spacing: 16, align: "center" });
  }, { style: "error-banner", width: w });
}

// exported for main's Escape on the play screen
export { cancelOrPause, OK, DANGER, INK_DIM, toast, palette };
