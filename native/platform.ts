// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (the storage.js progression record: journey stars and records,
//   dailies, achievements, the mastery roll, sessions and the streak) and
//   the local best per board are the game's save (starhermit:storage
//   `saves`): { v: 1, progression, bests } on the device and in the
//   player's cloud slot, two devices' copies merged on a conflict
//   (js/migrate.js mergeDocs). js/storage.js reads and writes them through
//   `localStorage` as it did in the browser: on the engine that is a shim
//   over this save (its progression and bests keys) and the device store
//   (the replay archive and anything else). The slot the browser build
//   wrote (the JS SDK's zipped save.json: the checksummed settings and
//   progression) shows as foreign and is merged in and replaced once;
// - the game's own settings (palette, theme, labels on liquids, hints,
//   left-handed tray, hold to confirm, wide camera, lessons done, the last
//   mode) are `settings` (game.<key>, synced with the account); the browser
//   build's settings keys are migrated, then removed;
// - the player's name, the invite link, the high-score board's rows (also
//   for guests) and posting a finished ranked round's total through
//   score-script.js (a practice session whose socket carries { type:
//   'result', scores }, as the JS SDK's submitScores did), and the
//   platform's clock for the daily's date.
//
// The browser build's own-server routes (server.js: replay-validated score
// submission, its boards, telemetry, achievements, activity and presence)
// were for local development hosting and were never called in production
// (its platform.js OWN_API was false): the platform runs score-script.js.
import type { JsonValue } from "starhermit:engine";
import { connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, profile, serverNow, serverTime, sessions } from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import * as M from "../js/migrate.js";
import { tr } from "./i18n.ts";

export type Doc = ReturnType<typeof M.normalize>;
const PREFIX = "chromatic-pour:";

// --- the save ------------------------------------------------------------------------------
let doc: Doc = M.normalize({});
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

export function getDoc(): Doc { return doc; }
/** Writes the save (device at once, the account debounced by the runtime). */
export function persist(): void {
  try { saves.save(doc as unknown as JsonValue, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
/** Replaces the progression (an imported save file, a reset). */
export function replaceProgression(p: unknown): void {
  doc = M.normalize({ progression: p, bests: doc.bests });
  persist();
}
/** Erases the local bests (a progress reset). */
export function clearBests(): void {
  doc = M.normalize({ progression: doc.progression, bests: {} });
  persist();
}

/** Takes a document in (merged with what this device has); whether it changed. */
function adopt(other: Doc | null): boolean {
  if (!other) return false;
  const before = JSON.stringify(doc);
  const next = M.mergeDocs(doc, other);
  if (JSON.stringify(next) === before) return false;
  doc = next;
  return true;
}

saves.onConflict((local, remote) => ({
  merged: M.mergeDocs(M.docFromSave(local?.data), M.docFromSave(remote.data)) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(M.docFromSave(cur.data))) { persist(); merged(); }
  }
});

/** The browser build's cloud save: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const { doc: d, settings: s } = M.fromBrowserSave(old.text);
  const changed = adopt(d);
  if (s) for (const [k, v] of Object.entries(s)) adoptSetting(k, v);
  try { saves.save(doc as unknown as JsonValue, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}

/** For the settings' sync line: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- js/storage.js's localStorage --------------------------------------------------------
// The progression and bests keys are the save's parts; every other key (the
// replay archive, the probe) is the device store's.
const shim = {
  getItem(key: string): string | null {
    if (key === PREFIX + "progression") return JSON.stringify(doc.progression);
    if (key === PREFIX + "bests") return JSON.stringify(doc.bests);
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    if (key === PREFIX + "progression" || key === PREFIX + "bests") {
      let v: unknown;
      try { v = JSON.parse(String(value)); } catch { return; }
      doc = M.normalize(key === PREFIX + "progression" ? { progression: v, bests: doc.bests } : { progression: doc.progression, bests: v });
      persist();
      return;
    }
    storage.set(key, String(value));
  },
  removeItem(key: string): void {
    try { storage.remove(key); } catch { /* gone */ }
  },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

// --- the game's settings -------------------------------------------------------------------
export interface Settings {
  palette: string; theme: string; labelsOnLiquids: boolean; hintsEnabled: boolean; leftHanded: boolean;
  holdToConfirm: boolean; cameraWide: boolean; tutorialDone: boolean; lastMode: string | null; [key: string]: unknown;
}
export const settings: Settings = { ...M.DEFAULT_GAME_SETTINGS };
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }
function readSetting(key: string): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = M.checkSetting(key, v);
  if (ok !== undefined) settings[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptSetting(key: string, value: unknown): void {
  const v = M.checkSetting(key, value);
  if (v === undefined || store.get(key) !== undefined) return;
  try { store.set(key, v as JsonValue); settings[key] = v; settingsChanged(); } catch { /* keep the device's */ }
}
/** Changes one of the game's settings (device and account). */
export function setSetting(key: keyof Settings & string, value: boolean | string | null): void {
  if (settings[key] === value) return;
  settings[key] = value;
  try { store.set(key, value); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
  settingsChanged();
}
/** Imported settings (a save file): every valid one replaces the current. */
export function importSettings(s: Record<string, unknown>): void {
  for (const k of M.GAME_SETTING_KEYS) {
    const v = M.checkSetting(k, s[k]);
    if (v !== undefined) setSetting(k, v as boolean | string | null);
  }
}
// The browser build's per-player settings keys: the game's options in them
// carry over (unless this game set them since), then they are removed.
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const key of keys) {
    if (!M.BROWSER_SETTING_KEYS.includes(key)) continue;
    const v = store.legacy(key);
    if (M.GAME_SETTING_KEYS.includes(key)) adoptSetting(key, v);
    store.removeLegacy(key);
  }
}

/** Reads the device's save and the game's settings (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  const d = M.docFromSave(cur?.data);
  if (d) doc = d;
  else if (!cur) persist();
  for (const k of M.GAME_SETTING_KEYS) readSetting(k);
  store.onChange((key) => {
    if (!M.GAME_SETTING_KEYS.includes(key)) return;
    readSetting(key);
    settingsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  settingsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player ----------------------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
/** The account's name signed in, else "". */
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
  void highScoreBoard().catch(() => null);
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number { return serverNow() ?? Date.now(); }

// --- the StarHermit leaderboards -----------------------------------------------------------
const BOARD_KEY = "chromaticpour.board-id";
let boardId: string | null = null;
/** The high-score board's id: listed (guests can read boards), then kept on the device. */
async function highScoreBoard(): Promise<string | null> {
  if (boardId) return boardId;
  try {
    const list = await leaderboards.list();
    const b = list.find((x) => x.key === "high-score") ?? list[0];
    if (b) { boardId = b.id; try { storage.set(BOARD_KEY, b.id); } catch { /* full */ } }
  } catch { /* offline */ }
  if (!boardId) { try { boardId = storage.getText(BOARD_KEY); } catch { boardId = null; } }
  return boardId;
}
export interface BoardRow { rank: number | null; name: string; score: number; mine: boolean }
/** The high-score board's top 10 (friends only: the player's friends); ok false when it cannot be read. */
export async function fetchLeaderboard(friendsOnly = false): Promise<{ ok: boolean; entries: BoardRow[] }> {
  const me = player();
  try {
    if (friendsOnly && !me) return { ok: false, entries: [] };
    const id = await highScoreBoard();
    if (!id) return { ok: false, entries: [] };
    const page = await leaderboards.entries(id, { pageSize: 10, ...(friendsOnly ? { friendsOnly: true } : {}) });
    const entries = await Promise.all(page.items.map(async (e) => {
      let name = e.username || tr("Alchemist");
      if (me && e.userId === me.userId) name = me.displayName;
      else { try { name = (await profile(e.userId)).displayName; } catch { /* the username */ } }
      return { rank: e.rank ?? null, name, score: Math.floor(Number(e.score) || 0), mine: !!me && e.userId === me.userId };
    }));
    return { ok: true, entries };
  } catch { return { ok: false, entries: [] }; }
}

/** Signed in only: post a finished round's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const id = await highScoreBoard();
    if (!id) return { posted: true, rank: null };
    const r = await leaderboards.entries(id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
