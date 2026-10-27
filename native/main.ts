// Chromatic Pour on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content, session and store are the
// browser build's js/*.js (ES modules) unchanged; this module is what
// js/main.js and js/ui.js did around them — the state machine (title →
// modes → setup → preparing → lesson / countdown → active ⇄ paused →
// resolving → results → progression), the vessel selection and pour intent
// with its sounds and announcements, the pour's input lock and Skip, undo,
// hints and restart, the lessons gated step by step, the timed challenges'
// clock and fifteen-second warning, outcomes (journey stars and records,
// dailies, achievements and the local bests through storage.recordResult,
// the replay archive), posting a finished ranked round to the high-score
// board, and the lifecycle. The screens, HUD and overlays are drawn by
// screens.ts, the vessels by board.ts (starhermit:ui), the shelf behind
// them by render.ts (starhermit:scene).
//
// The session's clock is the runtime's fixed steps (60 a second): pauses,
// a hidden window and slow frames never cost time, and play scripts replay
// exactly. Cosmetic timings (the countdown, the pour, the settle before
// results) count fixed steps too.
import { frame, onFixedUpdate, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, onPreferencesChange, preferences, setFixedRate, openMenu } from "starhermit:engine";
import { isKeyDown, onAction } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, onPlayerChange, requestSignIn } from "starhermit:platform";
import * as rules from "../js/rules.js";
import { GameSession } from "../js/session.js";
import * as content from "../js/content.js";
import * as storage from "../js/storage.js";
import * as audio from "./audio.ts";
import { tr, N, pt, onLocaleChange } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import * as board from "./board.ts";
import { drawScreens } from "./screens.ts";
import { applyTheme, initStyles, themeById } from "./style.ts";

export type Level = ReturnType<typeof content.dailyLevel> & {
  kind: string; vessels?: number[][]; mastery?: boolean; nameParts?: string[]; difficulty?: string; desc?: string;
  parMoves: number | null; constraints: { moveLimit?: number; timeLimitMs?: number; noUndo?: boolean }; theme?: string;
};
export type Lesson = (typeof content.LESSONS)[number];
export type ModeKind = "journey" | "daily" | "practice" | "challenge" | "score-chase" | "lesson";
export type ScreenName = "title" | "modes" | "setup" | "play" | "results" | "help" | "settings" | "progression";
export type Phase = "menu" | "tutorial" | "countdown" | "active" | "paused" | "resolving" | "results";
export type OverlayName = "pause" | "confirm" | "drawer-left" | "drawer-right";
type State = ReturnType<typeof rules.createGame>;
type Result = ReturnType<GameSession["result"]>;
export interface Toast { text: () => string; kind: "info" | "achievement" | "hint" | "warn"; until: number; id: number }
export interface ConfirmView { title: string; body: string; confirm: string; run: () => void }
export interface ResultsView {
  result: Result; stars: number; newAchievements: string[]; complete: boolean; reason: string | null;
  bestBefore: { score?: number } | null; ranked: boolean;
  lb: { pending?: boolean; posted?: boolean; rank?: number | null } | null;
  next: { label: () => string; run: () => void };
}

const STEP_MS = 1000 / 60;
const POUR_LOCK_STEPS = 34;          // the browser build's 560 ms pour choreography
const CELEBRATE_STEPS = 101;         // its ambient celebration (6 bursts · 130 ms + 650 + 250)
const FAIL_STEPS = 57;               // its fail dim (950 ms)

export const ERROR_MESSAGES: Record<string, string> = {
  content: N("The level ledger failed to load. Reload to try again."),
  network: N("The host is unreachable. Ranked features are paused; local play continues."),
  storage: N("Progress could not be saved locally on this device."),
};
export const TERMINAL_HEADLINES: Record<string, string> = {
  "all-uniform": N("Shelf harmonized!"),
  "move-limit-exceeded": N("Out of moves"),
  "time-limit-exceeded": N("Time ran out"),
  abandoned: N("Round abandoned"),
};

export const app = {
  phase: "menu" as Phase,
  screen: "title" as ScreenName,
  /** The screen a sub-screen (help, settings) returns to. */
  back: "title" as ScreenName,
  openedFrame: 0,
  focusNext: null as string | null,
  overlays: [] as OverlayName[],
  overlayOpenedFrame: 0,
  confirm: null as ConfirmView | null,
  setupKind: "journey" as ModeKind,
  results: null as ResultsView | null,
  toasts: [] as Toast[],
  error: null as { key: string; until: number } | null,
  countdown: null as { labels: string[]; i: number; left: number; stepSteps: number; startedAt: number } | null,
  resolvingAt: -1,
  signedOut: false,
  practiceSeed: freshSeed(),
  practiceDifficulty: "apprentice",
  chase: { board: 0, loading: false, rows: null as platform.BoardRow[] | null, ok: false },
};
export const round = {
  level: null as Level | null,
  modeKind: "journey" as ModeKind,
  ranked: false,
  boardKey: null as string | null,
  tutorial: null as { lesson: Lesson; stepIndex: number } | null,
  inputLocked: false,
  lockLeft: 0,
  pour: null as { from: number; to: number; layers: number; harmonized: boolean; terminal: { type: string; reason?: string } | null } | null,
  settling: false,
  settleLeft: -1,
  timeWarned: false,
};
export let session: GameSession | null = null;
export const settings = platform.settings;
/** The session clock: fixed steps × 1000/60 ms. */
let clockMs = 0;
const now = (): number => frame().time;
let toastSeq = 0;
let suspendedAt = 0;

// ------------------------------------------------------------------ helpers
export function freshSeed(): string { return `brew-${Math.random().toString(36).slice(2, 8)}`; }
export function palette(): { name: string; hex: string }[] {
  const sets = content.COLOR_SETS as Record<string, { name: string; hex: string }[]>;
  return sets[settings.palette] || sets.standard!;
}
export function colorDef(i: number): { name: string; hex: string } {
  const p = palette();
  return p[i % Math.max(1, p.length)] || { name: tr("Color {n}", { n: i + 1 }), hex: "#888888" };
}
/** The shelf theme: the level's, else the setting's. */
export function activeThemeId(): string {
  return themeById(round.level?.theme || settings.theme).id;
}
export function todayKey(): string { return new Date(platform.nowMs()).toISOString().slice(0, 10); }
export function fmtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
export function fmtScore(n: number): string {
  const s = String(Math.round(Math.abs(n)));
  return (n < 0 ? "-" : "") + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtAway(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return tr("{n} seconds", { n: Math.round(ms / 1000) });
  if (mins < 60) return tr(mins === 1 ? "{n} minute" : "{n} minutes", { n: mins });
  return tr("{h} h {m} min", { h: Math.floor(mins / 60), m: mins % 60 });
}
export function announce(msg: string, assertive = false): void {
  if (msg) ui.announce(msg.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
/** A transient toast; `text` re-reads in the current language. */
export function toast(text: () => string, kind: Toast["kind"] = "info"): void {
  while (app.toasts.length >= 4) app.toasts.shift();
  app.toasts.push({ text, kind, until: now() + 4.2, id: ++toastSeq });
}
export function notify(text: () => string): void { toast(text, "info"); announce(text()); }
export function dismissToast(id: number): void { app.toasts = app.toasts.filter((t) => t.id !== id); }
export function showError(key: string): void {
  app.error = { key, until: now() + 8 };
  announce(tr(ERROR_MESSAGES[key] || ERROR_MESSAGES.content!), true);
}
export function progression(): ReturnType<typeof storage.loadProgression> { return storage.loadProgression(); }
export function totalJourneyStars(p = progression()): number {
  let sum = 0;
  for (const k of Object.keys(p.journey || {})) sum += (p.journey as Record<string, { stars?: number }>)[k]!.stars || 0;
  return sum;
}
export function nextJourneyStage(p = progression()): (typeof content.JOURNEY)[number] | null {
  return content.JOURNEY.find((e) => !(p.journey as Record<string, unknown>)[e.id]) || null;
}
const JOURNEY_SUFFIX: Record<string, string> = {
  Prelude: N("{name} Prelude"), Draught: N("{name} Draught"), Crucible: N("{name} Crucible"),
  Alembic: N("{name} Alembic"), Tincture: N("{name} Tincture"),
};
/** A level's name in the current language (level data stays English). */
export function levelName(def: { kind?: string; nameParts?: string[] | null; id?: string; difficulty?: string; name?: string } | null): string {
  if (!def) return "";
  if (def.kind === "journey" && def.nameParts) return tr(JOURNEY_SUFFIX[def.nameParts[1]!] || "{name}", { name: def.nameParts[0]! });
  if (def.kind === "daily" && /^daily-/.test(def.id || "")) return tr("Daily Draught {date}", { date: String(def.id).slice(6) });
  if (def.kind === "practice" && def.difficulty) {
    const d = content.DIFFICULTIES.find((x) => x.id === def.difficulty);
    return tr("{level} Practice", { level: tr(d ? d.label : def.difficulty) });
  }
  return tr(def.name || "");
}
export function modeTitle(kind: string): string {
  return tr(({
    journey: N("Journey"), daily: N("Daily draught"), practice: N("Practice"),
    challenge: N("Challenge"), "score-chase": N("Score chase"), lesson: N("Learn"),
  } as Record<string, string>)[kind] || N("Play"));
}
export function playSubLabel(): string {
  if (!settings.tutorialDone) return tr("Begin with a lesson");
  const next = nextJourneyStage();
  if (settings.lastMode && settings.lastMode !== "journey") return tr("Return to {mode}", { mode: modeTitle(settings.lastMode) });
  if (next) return tr("Continue the Journey — {name}", { name: levelName(next) });
  return tr("Choose a mode");
}
export function constraintText(c: Level["constraints"] = {}): string {
  const parts: string[] = [];
  if (c.moveLimit) parts.push(tr("Move limit {n}", { n: c.moveLimit }));
  if (c.timeLimitMs) parts.push(tr("Time limit {time}", { time: fmtTime(c.timeLimitMs) }));
  if (c.noUndo) parts.push(tr("No undo"));
  return parts.length ? parts.join(" · ") : tr("No special constraints");
}

// ------------------------------------------------------------------ screens and overlays
export function showScreen(name: ScreenName, focus: string | null = null): void {
  app.screen = name;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  if (name !== "play") ui.setFocus(null);
}
export function topOverlay(): OverlayName | null { return app.overlays[app.overlays.length - 1] ?? null; }
export function openOverlay(name: OverlayName): void {
  if (topOverlay() === name) return;
  app.overlays.push(name);
  app.overlayOpenedFrame = frame().frame;
}
export function closeOverlay(): void {
  const top = app.overlays.pop();
  if (top === "confirm") app.confirm = null;
  if (top === "pause") resumeRound();
}
/** A confirm dialog (the browser build's confirmDialog): `run` on confirm. */
export function askConfirm(title: string, body: string, confirm: string, run: () => void): void {
  app.confirm = { title, body, confirm, run };
  openOverlay("confirm");
}
export function confirmYes(): void {
  const c = app.confirm;
  app.overlays = app.overlays.filter((o) => o !== "confirm");
  app.confirm = null;
  c?.run();
}

export function goTitle(): void {
  teardownRound();
  app.phase = "menu";
  applyTheme(themeById(settings.theme).id);
  render.setTheme(themeById(settings.theme).id, palette().map((c) => c.hex));
  showScreen("title", "btn-play");
}
export function goModes(): void { teardownRound(); app.phase = "menu"; showScreen("modes", "mode-journey"); }
export function goProgression(): void { teardownRound(); app.phase = "menu"; showScreen("progression", "btn-progress-primary"); }
/** Help or Settings, from the title or the pause menu (Back returns there). */
export function openSub(name: "help" | "settings"): void {
  app.back = app.phase === "paused" ? "play" : app.screen === "results" ? "results" : "title";
  app.overlays = [];
  showScreen(name, `btn-${name}-back`);
}
export function backFromSub(): void {
  if (app.back === "play" && session && app.phase === "paused") {
    showScreen("play");
    app.overlays = ["pause"];
    app.overlayOpenedFrame = frame().frame;
    return;
  }
  if (app.back === "results" && app.results) { showScreen("results", "results-next"); return; }
  goTitle();
}

// ------------------------------------------------------------------ mode setup
export function onPlay(): void {
  if (!settings.tutorialDone) { openSetup("lesson"); return; }
  if (settings.lastMode && settings.lastMode !== "journey") { openSetup(settings.lastMode as ModeKind); return; }
  openSetup("journey");
}
export function openSetup(kind: ModeKind): void {
  // Reached mid-round (Help → Replay the lessons while paused): leave the round first.
  if (session) leaveRound(false);
  app.setupKind = kind;
  if (kind !== "lesson") platform.setSetting("lastMode", kind);
  app.phase = "menu";
  const focus: Record<ModeKind, string> = {
    journey: `stage-${Math.max(0, content.JOURNEY.findIndex((e) => !(progression().journey as Record<string, unknown>)[e.id]))}`,
    practice: `diff-${app.practiceDifficulty}`, challenge: `challenge-${content.CHALLENGES[0]!.id}`,
    daily: "btn-daily-start", "score-chase": "btn-chase-start", lesson: `lesson-${content.LESSONS[0]!.id}`,
  };
  showScreen("setup", focus[kind]);
  if (kind === "score-chase") refreshChase();
}
export function journeyLevel(entry: (typeof content.JOURNEY)[number]): Level {
  return { ...entry, kind: "journey", capacity: 4, constraints: entry.constraints || {}, contentVersion: content.CONTENT_VERSION ?? 1 } as unknown as Level;
}
export function challengeLevel(c: (typeof content.CHALLENGES)[number]): Level {
  return { ...c, kind: "challenge", capacity: 4, constraints: c.constraints || {}, contentVersion: content.CONTENT_VERSION ?? 1 } as unknown as Level;
}
export function lessonLevel(lesson: Lesson, index: number): Level {
  const step = lesson.steps[index]!;
  const setup = (step.setup || {}) as { seed?: string; colorCount?: number; emptyVessels?: number; vessels?: number[][] };
  return {
    id: `lesson-${lesson.id || "x"}-${index}`, name: lesson.title || "Lesson", kind: "lesson",
    seed: setup.seed ?? `lesson-${lesson.id || "x"}-${index}`, colorCount: setup.colorCount ?? 3, capacity: 4,
    emptyVessels: setup.emptyVessels ?? 1, vessels: setup.vessels || undefined, constraints: {}, parMoves: 0,
    theme: undefined, contentVersion: content.CONTENT_VERSION ?? 1,
  } as unknown as Level;
}
export const CHASE_BOARDS = [
  { scope: "global", label: N("Global daily"), daily: true },
  { scope: "global", label: N("Global all-time"), daily: false },
  { scope: "friends", label: N("Friends"), daily: false },
];
export function chaseBoard(i = app.chase.board): { key: string; seed: string; scope: string; label: string } {
  const b = CHASE_BOARDS[i] ?? CHASE_BOARDS[1]!;
  // Board keys are the level ids themselves (server.js requires board === levelId).
  const seed = b.daily ? `chase-${todayKey()}` : "chase-evergreen";
  return { key: `practice-master-${seed}`, seed, scope: b.scope, label: b.label };
}
export function refreshChase(i = app.chase.board): void {
  app.chase.board = i;
  app.chase.loading = true;
  app.chase.rows = null;
  void platform.fetchLeaderboard(chaseBoard(i).scope === "friends").then((r) => {
    if (app.chase.board !== i) return;
    app.chase.loading = false;
    app.chase.ok = r.ok;
    app.chase.rows = r.entries;
  });
}
export function startPractice(): void {
  const seed = app.practiceSeed.trim() || freshSeed();
  app.practiceSeed = seed;
  startLevel(content.practiceLevel(app.practiceDifficulty, seed) as Level, { ranked: false, boardKey: `practice-${app.practiceDifficulty}` });
}
export function startChase(): void {
  const b = chaseBoard();
  const level = content.practiceLevel("master", b.seed) as Level;
  startLevel({ ...level, name: b.label }, { ranked: true, boardKey: b.key });
}
export function startDaily(): void {
  const level = content.dailyLevel(todayKey()) as Level;
  startLevel({ ...level, kind: "daily" }, { ranked: true, boardKey: level.id });
}
export function startLesson(lesson: Lesson): void {
  round.tutorial = { lesson, stepIndex: 0 };
  startLevel(lessonLevel(lesson, 0), { ranked: false, boardKey: null, tutorial: true });
}

// ------------------------------------------------------------------ round lifecycle
export function startLevel(level: Level, opts: { ranked: boolean; boardKey: string | null; tutorial?: boolean }): void {
  const keepTutorial = !!opts.tutorial;
  teardownRound(keepTutorial);
  round.level = level;
  round.ranked = !!opts.ranked;
  round.boardKey = opts.boardKey || null;
  lastLevel = level;
  lastRanked = round.ranked;
  lastBoard = round.boardKey;
  round.settling = false;
  round.settleLeft = -1;
  round.inputLocked = false;
  round.pour = null;
  round.timeWarned = false;
  app.results = null;
  try {
    session = new GameSession(level, { now: () => clockMs });
  } catch (e) {
    console.warn(`session: ${String(e)}`);
    showError("content");
    session = null;
    return;
  }
  // Resolve par (solver depth + slack) before the HUD and scoring need it; lessons skip it.
  if (level.kind !== "lesson" && !Number.isInteger(level.parMoves)) {
    try { content.parFor(level); } catch { /* scoring falls back to a default par */ }
  }
  round.modeKind = (level.kind === "lesson" ? "lesson" : app.setupKind) as ModeKind;
  if (level.kind !== "lesson" && app.setupKind !== "lesson") platform.setSetting("lastMode", app.setupKind);
  app.overlays = [];
  const th = activeThemeId();
  applyTheme(th);
  render.setTheme(th, palette().map((c) => c.hex));
  render.settle();
  board.reset();
  showScreen("play");
  // preparing → lesson or countdown
  if (round.tutorial) enterTutorial();
  else startCountdown();
}
function startCountdown(): void {
  app.phase = "countdown";
  const reduced = preferences().reducedMotion;
  const labels = reduced ? ["Go"] : ["3", "2", "1", "Go"];
  const stepSteps = reduced ? 30 : 42;
  app.countdown = { labels, i: 0, left: stepSteps, stepSteps, startedAt: now() };
  countdownTick();
}
function countdownTick(): void {
  const c = app.countdown!;
  const label = c.labels[c.i]!;
  const go = label === "Go";
  announce(go ? tr("Go!") : label);
  audio.play(go ? "ui" : "tick");
  c.startedAt = now();
}
function beginActiveRound(): void {
  app.countdown = null;
  if (!session) return;
  session.start();
  audio.startAmbience(activeThemeId());
  app.phase = "active";
  app.focusNext = board.vesselId(firstPlayableVessel());
  updateMusic();
}
function enterTutorial(): void {
  app.phase = "tutorial";
  if (session && !session.state) session.start();
  audio.startAmbience(activeThemeId());
  app.focusNext = board.vesselId(firstPlayableVessel());
  showTutorialStep();
  updateMusic();
}
export function firstPlayableVessel(): number {
  const st = session?.state;
  if (!st) return 0;
  const idx = st.vessels.findIndex((v: number[]) => v.length > 0);
  return idx === -1 ? 0 : idx;
}
function teardownRound(keepTutorial = false): void {
  audio.stopAmbience();
  session = null;
  round.level = null;
  if (!keepTutorial) round.tutorial = null;
  round.inputLocked = false;
  round.pour = null;
  round.settling = false;
  round.settleLeft = -1;
  app.countdown = null;
  app.resolvingAt = -1;
  app.overlays = [];
}
export function playing(): boolean { return app.phase === "active" || app.phase === "tutorial"; }

export function pauseRound(): void {
  if (!session || app.phase !== "active") return;
  app.phase = "paused";
  session.pause();
  app.overlays = ["pause"];
  app.overlayOpenedFrame = frame().frame;
  audio.setPaused(true);
}
export function resumeRound(): void {
  app.overlays = app.overlays.filter((o) => o !== "pause");
  if (app.phase !== "paused") return;
  session?.resume();
  app.phase = "active";
  audio.setPaused(false);
  app.focusNext = board.vesselId(firstPlayableVessel());
}
/** Leave to the title (the round is abandoned, as the browser build's Leave did). */
export function leaveRound(toTitle = true): void {
  app.overlays = [];
  audio.setPaused(false);
  teardownRound();
  if (toTitle) goTitle();
}

// ------------------------------------------------------------------ selection and pours
const lastVessel = { i: -1, t: -Infinity };
function canAct(): boolean { return !!session && !round.inputLocked && (app.phase === "active" || app.phase === "tutorial") && !app.overlays.length; }
/** A vessel was activated (click, tap, Enter/Space or South on its widget, or the confirm key). */
export function onVessel(i: number): void {
  if (!canAct() || !session) return;
  // One press, one activation: Enter on a focused vessel reaches both its
  // widget and the confirm action, and on a slow frame the key is already up
  // when the action is read (the confirm path then cannot tell it was Enter).
  // A second activation of the same vessel within 100 ms is that same press.
  const t = now();
  if (i === lastVessel.i && t - lastVessel.t < 0.1) return;
  lastVessel.i = i; lastVessel.t = t;
  if (round.tutorial) { tutorialVesselIntent(i); return; }
  handleSelectResult(session.selectVessel(i));
}
type SelectResult = ReturnType<GameSession["selectVessel"]>;
function handleSelectResult(res: SelectResult): void {
  const s = session!;
  const r = res as { kind: string; index?: number; from?: number; to?: number; events?: { type: string }[]; message?: string; reselected?: boolean };
  if (r.kind === "selected") {
    const run = rules.topRun(s.state, r.index!);
    const def = run ? colorDef(run.color) : null;
    audio.play("select");
    announce(def
      ? tr(run!.layers === 1 ? "Vessel {n} selected, {color}, {layers} layer." : "Vessel {n} selected, {color}, {layers} layers.", { n: r.index! + 1, color: def.name, layers: run!.layers })
      : tr("Vessel {n} selected.", { n: r.index! + 1 }));
    return;
  }
  if (r.kind === "deselected") {
    audio.play("deselect");
    announce(tr("Selection cleared."));
    return;
  }
  if (r.kind === "pour") { doPour(r.events || [], r.from!, r.to!); return; }
  const idx = r.index ?? s.selected ?? 0;
  audio.play("invalid");
  showInvalidOnVessel(idx, r.message ? tr(r.message) : tr("That pour is not allowed."));
}
function showInvalidOnVessel(i: number, message: string): void {
  announce(message, true);
  board.invalid(i);
}
function doPour(events: { type: string; color?: number; layers?: number; reason?: string }[], from: number, to: number): void {
  const pourEvt = events.find((e) => e.type === "pour");
  const terminal = events.find((e) => e.type === "complete" || e.type === "failed") || null;
  const def = pourEvt ? colorDef(pourEvt.color!) : null;
  round.inputLocked = true;
  audio.play("pour-start");
  const motion = !preferences().reducedMotion;
  const st = session!.state;
  const harmonized = !!(pourEvt && !terminal && st.vessels[to].length === st.capacity && rules.isVesselComplete(st, to));
  round.pour = { from, to, layers: pourEvt?.layers ?? 0, harmonized, terminal: terminal as { type: string; reason?: string } | null };
  if (motion && pourEvt) board.pour(from, to, pourEvt.layers!);
  if (pourEvt && def) {
    announce(tr(pourEvt.layers === 1 ? "Poured {layers} layer of {color} from Vessel {from} to Vessel {to}." : "Poured {layers} layers of {color} from Vessel {from} to Vessel {to}.",
      { layers: pourEvt.layers!, color: def.name, from: from + 1, to: to + 1 }));
  }
  updateMusic();
  round.lockLeft = motion ? POUR_LOCK_STEPS : 0;
  if (!motion) settlePour();
}
function settlePour(): void {
  const p = round.pour;
  round.inputLocked = false;
  round.pour = null;
  board.settle();
  audio.play("pour-end");
  if (p?.harmonized) audio.play("layer-complete");
  // In lessons the lesson flow owns advancement; rounds never "end" there.
  if (p?.terminal && !round.tutorial) endRound(p.terminal);
}
/** Skip animation: settle the pour now. */
export function skipPour(): void {
  if (!round.inputLocked) return;
  render.settle();
  settlePour();
}
export function doUndo(): void {
  if (!canAct() || !session) return;
  if (round.tutorial && !tutorialGate("undo")) return;
  if (session.undo()) {
    audio.play("undo");
    board.reset();
    announce(tr("Last pour undone."));
    updateMusic();
    if (round.tutorial) advanceTutorial();
  } else {
    announce(round.level?.constraints?.noUndo ? tr("This challenge forbids undo.") : tr("Nothing to undo yet."), true);
    audio.play("invalid");
  }
}
export function doHint(): void {
  if (!canAct() || !session || !settings.hintsEnabled) return;
  const h = session.hint();
  if (!h) { announce(tr("No helpful pour found — the shelf may already be settled."), true); return; }
  audio.play("hint");
  board.hint(h.from, h.to);
  announce(tr("The ledger suggests: pour {color} from Vessel {from} to Vessel {to}.", { color: colorDef(h.color).name, from: h.from + 1, to: h.to + 1 }));
}
export function doRestart(): void {
  if (!canAct() || !session) return;
  if (round.tutorial && !tutorialGate("restart")) return;
  session.restart();
  round.timeWarned = false;
  audio.play("ui");
  board.reset();
  announce(tr("Round restarted — same recipe, fresh shelf."));
  updateMusic();
  if (round.tutorial) advanceTutorial();
}
/** Escape / B: drop the selection, else pause (resume when paused). */
export function cancelOrPause(): void {
  if (app.phase === "paused") { resumeRound(); return; }
  if (!playing() || !session) return;
  if (session.selected != null) {
    session.clearSelection();
    audio.play("deselect");
    announce(tr("Selection cleared."));
    return;
  }
  if (app.phase === "active") pauseRound();
}
export function recenterView(): void {
  render.recenter();
  announce(tr("View recentered on the shelf."));
}
function updateMusic(): void {
  const st = session?.state;
  if (!st) { audio.setMusicIntensity(0); return; }
  const done = st.vessels.filter((_v: number[], i: number) => rules.isVesselComplete(st, i)).length;
  audio.setMusicIntensity(st.vessels.length ? done / st.vessels.length : 0);
}

// ------------------------------------------------------------------ lessons
export function currentStep(): Lesson["steps"][number] | null {
  const t = round.tutorial;
  return t ? t.lesson.steps[t.stepIndex] || null : null;
}
function showTutorialStep(): void {
  const step = currentStep();
  if (step) announce(step.text ? tr(step.text) : "");
}
function tutorialVesselIntent(i: number): void {
  const s = session!;
  const step = currentStep();
  if (!step) { handleSelectResult(s.selectVessel(i)); return; }
  const req = (step.require || {}) as { kind?: string; from?: number; to?: number; color?: number };
  const selected = s.selected;
  if (req.kind === "select") {
    if (req.from == null || i === req.from) {
      const res = s.selectVessel(i);
      handleSelectResult(res);
      if (res.kind === "selected") advanceTutorial();
    } else denyTutorial(i, step, tr("That is not the vessel the lesson asks for."));
    return;
  }
  if (req.kind === "pour" || req.kind === "pour-color") {
    if (selected == null) {
      if (req.from == null || i === req.from) handleSelectResult(s.selectVessel(i));
      else denyTutorial(i, step, tr("Start with the vessel the lesson names."));
      return;
    }
    if (i === selected) { handleSelectResult(s.selectVessel(i)); return; }
    if (req.to != null && i !== req.to) { denyTutorial(i, step, tr("Pour into the vessel the lesson names.")); return; }
    if (req.kind === "pour-color" && req.color != null) {
      const run = rules.topRun(s.state, selected);
      if (!run || run.color !== req.color) { denyTutorial(i, step, tr("The lesson asks for a specific color.")); return; }
    }
    const res = s.selectVessel(i);
    handleSelectResult(res);
    if (res.kind === "pour") advanceTutorial();
    return;
  }
  if (req.kind === "undo" || req.kind === "restart") {
    denyTutorial(i, step, req.kind === "undo" ? tr("Use the Undo button for this step.") : tr("Use the Restart button for this step."));
    return;
  }
  handleSelectResult(s.selectVessel(i));
}
function tutorialGate(kind: string): boolean {
  const step = currentStep();
  if (!step) return true;
  if ((step.require as { kind?: string } | undefined)?.kind === kind) return true;
  announce(tr("The lesson asks for something else first — follow the instruction card."), true);
  audio.play("invalid");
  return false;
}
function denyTutorial(i: number, step: Lesson["steps"][number], prefix: string): void {
  audio.play("invalid");
  showInvalidOnVessel(i, prefix);
  if (step.hintText) {
    announce(`${prefix} ${tr(step.hintText)}`, true);
    toast(((k) => () => tr(k))(step.hintText), "hint");
  }
}
function advanceTutorial(): void {
  const t = round.tutorial!;
  audio.play("layer-complete");
  t.stepIndex += 1;
  const step = currentStep();
  if (step && (step as { continues?: boolean }).continues && session) {
    // The next instruction builds on the current board and selection.
    showTutorialStep();
    return;
  }
  if (step) {
    // The next step gets its own seeded board.
    round.level = lessonLevel(t.lesson, t.stepIndex);
    session = new GameSession(round.level, { now: () => clockMs });
    session.start();
    round.inputLocked = false;
    round.pour = null;
    board.reset();
    showTutorialStep();
    app.focusNext = board.vesselId(firstPlayableVessel());
    return;
  }
  // Lesson complete.
  platform.setSetting("tutorialDone", true);
  toast(() => tr("Lesson complete — the shelf approves."), "achievement");
  announce(tr("Lesson complete."));
  round.tutorial = null;
  goTitle();
}

// ------------------------------------------------------------------ outcomes
function endRound(terminal: { type: string; reason?: string }): void {
  if (round.settling || !session) return;
  round.settling = true;
  round.inputLocked = true;
  app.phase = "resolving";
  app.resolvingAt = now();
  const complete = terminal.type === "complete";
  audio.play(complete ? "win" : "fail");
  const reduced = preferences().reducedMotion;
  if (complete) render.celebrate(); else render.fail();
  round.settleLeft = reduced ? 1 : complete ? CELEBRATE_STEPS : FAIL_STEPS;
  const reason = terminal.reason || (complete ? "all-uniform" : null);
  app.results = buildResults(complete, reason);
}
function buildResults(complete: boolean, reason: string | null): ResultsView {
  const s = session!;
  const level = round.level!;
  const result = s.result();
  const env = s.replayEnvelope();
  let record: { newAchievements: string[]; stars: number } = { newAchievements: [], stars: 0 };
  try {
    record = storage.recordResult(level, result, { now: platform.nowMs() }) as typeof record;
  } catch { showError("storage"); }
  // Personal-best comparison (before this round is written).
  let bestBefore: { score?: number } | null = null;
  if (round.boardKey) { try { bestBefore = storage.loadBestScore(round.boardKey); } catch { bestBefore = null; } }
  const view: ResultsView = {
    result, stars: record.stars || 0, newAchievements: record.newAchievements || [], complete, reason, bestBefore,
    ranked: round.ranked, lb: null, next: nextAction(),
  };
  // Ranked rounds keep their replay envelope; completed ones keep a local best
  // and, signed in, post their total to the StarHermit high-score board.
  if (round.ranked && round.boardKey) { try { storage.saveReplayEnvelope(env); } catch { /* best-effort */ } }
  if (round.boardKey && result.complete) {
    try { storage.saveBestScore(round.boardKey, { score: result.score.total, moves: result.moves, ms: result.elapsedMs }); } catch { /* best-effort */ }
    if (round.ranked && platform.signedIn()) {
      view.lb = { pending: true };
      void platform.postLeaderboard(result.score.total).then((r) => {
        view.lb = r;
        if (!r.posted) showError("network");
      });
    }
  }
  return view;
}
function showResults(): void {
  const v = app.results;
  if (!v) { goTitle(); return; }
  round.settling = false;
  round.inputLocked = false;
  app.phase = "results";
  app.resolvingAt = -1;
  audio.stopAmbience();
  if (v.newAchievements.length) audio.play("achievement");
  for (const key of v.newAchievements) {
    const meta = storage.ACHIEVEMENTS.find((a) => a.key === key);
    announce(tr("Achievement unlocked: {name}", { name: meta ? tr(meta.name) : key }));
  }
  if (v.bestBefore != null && v.complete && v.result.score.total > (v.bestBefore.score ?? 0)) audio.play("new-best");
  const headline = tr(TERMINAL_HEADLINES[v.reason || ""] || (v.complete ? N("Shelf harmonized!") : N("The shelf resists")));
  announce(tr("{headline} Score {score}.", { headline, score: fmtScore(v.result.score.total) }));
  showScreen("results", "results-next");
}
function nextAction(): ResultsView["next"] {
  const level = round.level;
  if (level?.kind === "journey") {
    const idx = content.JOURNEY.findIndex((e) => e.id === level.id);
    const n = content.JOURNEY[idx + 1];
    if (n) return { label: () => tr("Next: {name}", { name: levelName(n) }), run: () => startLevel(journeyLevel(n), { ranked: false, boardKey: null }) };
  }
  if (level?.kind === "challenge") {
    const idx = content.CHALLENGES.findIndex((c) => c.id === level.id);
    const n = content.CHALLENGES[idx + 1];
    if (n) return { label: () => tr("Next: {name}", { name: tr(n.name) }), run: () => startLevel(challengeLevel(n), { ranked: true, boardKey: n.id }) };
  }
  if (level?.kind === "practice") {
    return { label: () => tr("Fresh practice seed"), run: () => { app.practiceSeed = freshSeed(); startPractice(); } };
  }
  const nextStage = nextJourneyStage();
  if (nextStage) return { label: () => tr("Journey: {name}", { name: levelName(nextStage) }), run: () => startLevel(journeyLevel(nextStage), { ranked: false, boardKey: null }) };
  return { label: () => tr("Practice a fresh shelf"), run: () => {
    app.practiceSeed = freshSeed();
    startLevel(content.practiceLevel(app.practiceDifficulty, app.practiceSeed) as Level, { ranked: false, boardKey: null });
  } };
}
/** Replay the level just played. */
export function replayLevel(): void {
  const v = app.results;
  const level = lastLevel;
  if (!v || !level) return;
  audio.play("ui");
  startLevel(level, { ranked: lastRanked, boardKey: lastBoard });
}
let lastLevel: Level | null = null;
let lastRanked = false;
let lastBoard: string | null = null;

// ------------------------------------------------------------------ input
function focusedVessel(): number | null {
  const f = ui.focused();
  const m = f ? /^vessel-(\d+)$/.exec(f) : null;
  return m ? Number(m[1]) : board.focusedIndex();
}
const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const fresh = frame().frame !== app.openedFrame && frame().frame !== app.overlayOpenedFrame;
  const top = topOverlay();
  if (top) {
    if ((e.action === "cancel" || e.action === "pause") && fresh) {
      if (top === "pause") resumeRound(); else closeOverlay();
    }
    return;
  }
  if (app.screen !== "play") {
    if (e.action === "cancel" && fresh) {
      if (app.screen === "help" || app.screen === "settings") backFromSub();
      else if (app.screen === "setup") goModes();
      else if (app.screen === "results") goTitle();
      else if (app.screen !== "title") goTitle();
    }
    return;
  }
  switch (e.action) {
    case "cancel": if (fresh) cancelOrPause(); return;
    case "pause": if (app.phase === "active") pauseRound(); else if (app.phase === "paused") resumeRound(); return;
    case "undo": doUndo(); return;
    case "hint": doHint(); return;
    case "restart": doRestart(); return;
    case "camera_reset": recenterView(); return;
    default: break;
  }
  if (!playing()) return;
  // The arrows and the pad's D-pad move the UI's focus themselves (over the
  // vessels and the action buttons); WASD and other rebound keys move it
  // over the vessels here, as the browser build's focus keys did.
  const moves: Record<string, [number, number]> = { focus_next: [1, 0], focus_prev: [-1, 0], focus_up: [0, -1], focus_down: [0, 1] };
  const mv = moves[e.action];
  const uiNav = e.source === "gamepad" || (e.source === "keyboard" && ARROWS.some((k) => isKeyDown(k)));
  if (mv) {
    const cur = focusedVessel();
    if (cur == null) { app.focusNext = board.vesselId(firstPlayableVessel()); return; }
    if (!uiNav) app.focusNext = board.vesselId(board.neighbor(cur, mv[0], mv[1]));
    return;
  }
  if (e.action === "confirm") {
    // Enter, Space and South press the focused widget themselves; a rebound key pours too.
    const native = e.source === "gamepad" || (e.source === "keyboard" && ["Enter", "Space", "NumpadEnter"].some((k) => isKeyDown(k)));
    const cur = focusedVessel();
    if (cur == null) app.focusNext = board.vesselId(firstPlayableVessel());
    else if (!native) onVessel(cur);
  }
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  const look = lookFor(f.quality, f.levelIndex);
  render.applyLook(look);
  board.setDetailed(look.detailed);
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  render.setWide(!!settings.cameraWide);
  applyLook();
  goTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onSettingsChange(() => {
  render.setWide(!!settings.cameraWide);
  const th = activeThemeId();
  applyTheme(th);
  render.setTheme(th, palette().map((c) => c.hex));
});
onLocaleChange(() => { /* every string is read with tr() as it is drawn */ });
onSessionEnded(() => { app.signedOut = true; notify(() => pt("signedOut")); });
onPlayerChange((p) => { if (p) app.signedOut = false; });
onSuspend(() => {
  suspendedAt = Date.now();
  session?.pause();
  audio.setPaused(true);
  platform.flush();
});
onResume(() => {
  const awayMs = suspendedAt ? Date.now() - suspendedAt : 0;
  suspendedAt = 0;
  if (app.phase !== "paused") { audio.setPaused(false); if (playing() || app.phase === "resolving") session?.resume(); }
  if (awayMs >= 5000 && session) notify(() => tr("Welcome back to the shelf — away for {time}. The round clock was paused.", { time: fmtAway(awayMs) }));
});
onQuit(() => platform.flush());

onFixedUpdate(() => {
  clockMs += STEP_MS;
  if (app.countdown) {
    const c = app.countdown;
    if (--c.left <= 0) {
      c.i++;
      if (c.i >= c.labels.length) beginActiveRound();
      else { c.left = c.stepSteps; countdownTick(); }
    }
  }
  if (round.inputLocked && round.pour && round.lockLeft > 0) {
    if (--round.lockLeft <= 0) settlePour();
  }
  if (app.phase === "resolving" && round.settleLeft >= 0) {
    if (--round.settleLeft <= 0) { round.settleLeft = -1; showResults(); }
  }
  const s = session;
  if (s && app.phase === "active" && !round.inputLocked) {
    // A time limit binds even when the player stops pouring.
    if (s.checkTimeout()) { endRound({ type: "failed", reason: rules.TERMINAL.TIME_LIMIT }); return; }
    const limit = s.state?.constraints?.timeLimitMs;
    if (limit && !round.timeWarned) {
      const remaining = limit - s.elapsedMs();
      if (remaining < 15000 && remaining > 0) {
        round.timeWarned = true;
        audio.play("time-warning");
        announce(tr("Fifteen seconds left."), true);
      }
    }
  }
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t0 = now();
  if (app.toasts.length && app.toasts[0]!.until < t0) app.toasts = app.toasts.filter((x) => x.until >= t0);
  if (app.error && t0 > app.error.until) app.error = null;
});
onRender(() => {
  drawScreens();
  render.update(frameDt);
});

// Re-exports for screens.ts (the runtime's menu and sign-in).
export { openMenu, requestSignIn, storage, content, rules };
export type { State };
