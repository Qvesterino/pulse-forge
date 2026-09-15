import { createDrumTrack } from "../commands/commands";
import type { Command } from "../commands/types";
import { hashString, mulberry32 } from "../shared/rng";
import type { ProjectDocument, SceneRole } from "../project-model/types";
import { PPQ } from "../project-model/types";
import type { Transport } from "../transport/Transport";

/**
 * AI BANDMATE (Instant Jam v1) — an autonomous drum player that appears in
 * the room like a participant and plays the role humans didn't take.
 *
 * How it works: a 250 ms clock watches the SHARED transport. When the room
 * plays and a phrase boundary (default 8 bars) crosses, it writes a fresh
 * 16-step drum groove into ITS OWN track (never touching human rows) through
 * the same command path humans use — the CRDT broadcasts it to every peer,
 * so "the bot played" is just … the document changing. No new sync code.
 *
 * Brain (v1): seeded house-rules generator — 4-on-the-floor kick, offbeat
 * hats, backbeat snare, ghost/perc density scaled by the host's ENERGY.
 * Seed = hash(roomId:phrase) → deterministic: the same jam bar always rolls
 * the same groove (project determinism DNA). Upgradable to the full
 * generatePattern pipeline later; the phrase-clock + etiquette stays.
 *
 * Etiquette: idles when the room stops; owns only its own track; never
 * double-triggers inside a phrase.
 */

const BAR_TICKS = PPQ * 4;
const TICK_MS = 250;
const BOT_TRACK_NAME = "KYX Drums";
const STEPS = 16;

export interface BandmateState {
  enabled: boolean;
  energy: number;
  phraseBars: number;
  hasTrack: boolean;
  lastPhrase: number | null;
  /** Scene role the bot is currently playing under (null = no scene context). */
  sceneRole: SceneRole | null;
}

export interface BandmateControls {
  setEnabled(on: boolean): void;
  setEnergy(energy: number): void;
  setPhraseBars(bars: number): void;
  getState(): BandmateState;
  subscribe(listener: () => void): () => void;
  /** Test/step hook: run one clock tick immediately. */
  tick(): void;
}

interface StoreLike {
  readonly doc: ProjectDocument;
  execute(command: Command): void;
}

type PadKind = "kick" | "snare" | "hat" | "perc";

/** Pad classification by name — the default drum kit covers these. */
function padKind(name: string): PadKind {
  const n = name.toLowerCase();
  if (n.includes("kick")) return "kick";
  if (n.includes("snare") || n.includes("clap")) return "snare";
  if (n.includes("hat")) return "hat";
  return "perc";
}

/** Seed a 16-step velocity row for one pad kind at the given energy. */
function rollRow(kind: PadKind, energy: number, rand: () => number): number[] {
  const row = new Array<number>(STEPS).fill(0);
  const hit = (step: number, v: number) => {
    row[step % STEPS] = Math.max(row[step % STEPS], Math.min(1, v));
  };
  if (kind === "kick") {
    if (energy < 0.15) return row;
    for (let s = 0; s < STEPS; s += 4) hit(s, 0.9 + rand() * 0.08);
    if (energy < 0.4 && rand() < 0.5) row[8] = 0; // sparse: drop a quarter
    if (energy > 0.75 && rand() < 0.5) hit(14, 0.45); // ghost pickup
  } else if (kind === "snare") {
    hit(4, 0.72 + energy * 0.16);
    hit(12, 0.72 + energy * 0.16);
    if (energy > 0.85 && rand() < 0.6) hit(15, 0.3); // ghost fill lead-in
  } else if (kind === "hat") {
    for (let s = 2; s < STEPS; s += 4) hit(s, 0.45 + energy * 0.3);
    if (energy > 0.6) {
      for (let s = 0; s < STEPS; s += 2) {
        if (row[s] === 0 && rand() < energy * 0.45) hit(s, 0.25 + rand() * 0.15);
      }
    }
  } else {
    if (energy > 0.5) {
      const spots = Math.round(energy * 3);
      for (let k = 0; k < spots; k++) {
        const s = Math.floor(rand() * STEPS);
        if (s % 4 !== 0) hit(s, 0.3 + rand() * 0.25);
      }
    }
  }
  return row;
}

/** Rebuild the active pattern with the bot's rows merged in (others preserved). */
function withBotRows(
  doc: ProjectDocument,
  padIds: string[],
  rowsByPad: Record<string, number[]>,
): ProjectDocument {
  const activeId = doc.activePatternId;
  return {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === activeId
        ? {
            ...p,
            rows: (() => {
              const next = { ...p.rows };
              for (const padId of padIds) next[padId] = [...(rowsByPad[padId] ?? new Array(STEPS).fill(0))];
              return next;
            })(),
          }
        : p,
    ),
  };
}

// ── Scene-role etiquette (v2.1) ─────────────────────────────────────────────
// The bot reads the room's arrangement like a musician who knows the song:
// breaks are held, builds ramp and fill into the drop, drops hit full.

export type PlayModeLite = "pattern" | "song";

export interface EtiquetteDirective {
  /** Multiplier on the host ENERGY (0..1). */
  densityScale: number;
  allow: { kick: boolean; snare: boolean; hat: boolean; perc: boolean };
  /** Turn the last bar of the phrase into a crescendo fill. */
  fill: boolean;
}

const ALL_PADS: EtiquetteDirective["allow"] = { kick: true, snare: true, hat: true, perc: true };

/**
 * Musical etiquette per scene role. `progress` is 0..1 inside the CURRENT
 * phrase — builds ramp through it, outros thin through it, the fill fires
 * only once the phrase is most of the way home (a fill exists to launch the
 * NEXT section). `null` role = full energy, exactly like v1.
 */
export function etiquetteFor(role: SceneRole | null, progress: number): EtiquetteDirective {
  const p = Math.max(0, Math.min(1, progress));
  switch (role) {
    case "intro":
      return { densityScale: 0.35, allow: { kick: true, snare: false, hat: true, perc: false }, fill: false };
    case "build":
      return {
        densityScale: 0.55 + 0.45 * p,
        allow: ALL_PADS,
        fill: p >= 0.75, // the roll into the drop
      };
    case "break":
      return { densityScale: 0.3, allow: { kick: false, snare: false, hat: true, perc: false }, fill: false };
    case "outro":
      return { densityScale: Math.max(0.25, 1 - 0.7 * p), allow: { kick: true, snare: false, hat: true, perc: false }, fill: false };
    case "fill":
      return { densityScale: 1, allow: ALL_PADS, fill: true };
    case "drop":
    case "custom":
    case null:
    default:
      return { densityScale: 1, allow: ALL_PADS, fill: false };
  }
}

/** Older scenes carry no role — infer the obvious ones from the name. */
function roleFromName(name: string): SceneRole | null {
  const n = name.toLowerCase();
  for (const r of ["intro", "build", "drop", "break", "outro", "fill"] as const) {
    if (n.includes(r)) return r;
  }
  return null;
}

/**
 * The scene role under the playhead — mirrors SceneLauncher's
 * currentSceneIdFor (song mode: the clip covering the playhead bar; pattern
 * mode: the scene bound to the active pattern), then reads its role.
 */
export function currentSceneRole(
  doc: ProjectDocument,
  mode: PlayModeLite,
  playheadBar: number,
): SceneRole | null {
  let sceneId: string | null = null;
  if (mode === "song") {
    const clip = doc.arrangement.clips.find(
      (c) => playheadBar >= c.startBar && playheadBar < c.startBar + c.lengthBars,
    );
    sceneId = clip?.sceneId ?? null;
  } else {
    sceneId = doc.scenes.find((s) => s.patternId === doc.activePatternId)?.id ?? null;
  }
  const scene = sceneId ? doc.scenes.find((s) => s.id === sceneId) : null;
  if (!scene) return null;
  return scene.role ?? roleFromName(scene.name);
}

/** Apply a fill to the last half of the bar: snare 16ths crescendo, kick thins. */
function applyFillCrescendo(rows: Record<string, number[]>, kinds: Record<string, PadKind>, rand: () => number): void {
  for (const padId of Object.keys(rows)) {
    const kind = kinds[padId] ?? "perc";
    const row = rows[padId];
    if (kind === "kick") {
      // Fills drop the mid-bar kick so the snare line is heard.
      for (let s = 8; s < STEPS; s++) row[s] = 0;
      continue;
    }
    if (kind === "perc") continue;
    for (let s = 8; s < STEPS; s++) {
      const ramp = 0.35 + ((s - 8) / 8) * 0.6; // 0.35 → 0.95 across the back half
      if (kind === "snare" && s >= 10) hitRow(row, s, ramp);
      else if (kind === "hat" && rand() < 0.5) hitRow(row, s, ramp * 0.8);
    }
  }
}

function hitRow(row: number[], step: number, v: number): void {
  row[step % STEPS] = Math.max(row[step % STEPS], Math.min(1, v));
}

export function createBandmate(deps: {
  store: StoreLike;
  transport: Transport;
  roomId: string;
  /** Playback mode — song mode resolves scenes from arrangement clips. */
  getMode: () => PlayModeLite;
}): BandmateControls {
  const { store, transport, roomId } = deps;
  let enabled = false;
  let energy = 0.6;
  let phraseBars = 8;
  let trackId: string | null = null;
  let lastPhraseIndex: number | null = null;
  let sceneRole_: SceneRole | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };

  const findBotTrack = (): { id: string; pads: Array<{ id: string; kind: PadKind }> } | null => {
    const track = store.doc.tracks.find(
      (t): t is Extract<typeof t, { kind: "drum" }> => t.kind === "drum" && t.name === BOT_TRACK_NAME,
    );
    if (!track) return null;
    return {
      id: track.id,
      pads: track.pads.map((p) => ({ id: p.id, kind: padKind(p.name) })),
    };
  };

  const ensureTrack = (): boolean => {
    if (trackId && store.doc.tracks.some((t) => t.id === trackId)) return true;
    const existing = findBotTrack();
    if (existing) {
      trackId = existing.id;
      return true;
    }
    const before = new Set(store.doc.tracks.map((t) => t.id));
    store.execute(createDrumTrack(store.doc));
    const added = store.doc.tracks.find((t) => !before.has(t.id));
    if (!added) return false;
    const newId = added.id;
    trackId = newId;
    // Rename through the generic path so every peer sees the bot's identity.
    store.execute({
      type: "renameTrack",
      label: `Rename to ${BOT_TRACK_NAME}`,
      execute: (d) => ({
        ...d,
        tracks: d.tracks.map((t) => (t.id === newId ? { ...t, name: BOT_TRACK_NAME } : t)),
      }),
      undo: (d) => d,
    });
    return true;
  };

  const roll = (phraseIndex: number, phraseProgress: number, role: SceneRole | null): void => {
    const bot = findBotTrack();
    if (!bot) return;
    const active = store.doc.patterns.find((p) => p.id === store.doc.activePatternId);
    if (!active) return;
    const directive = etiquetteFor(role, phraseProgress);
    const effectiveEnergy = Math.max(0, Math.min(1, energy * directive.densityScale));
    const rand = mulberry32(hashString(`${roomId}:kyx:${phraseIndex}`));
    const rowsByPad: Record<string, number[]> = {};
    const kinds: Record<string, PadKind> = {};
    for (const pad of bot.pads) {
      const kind = pad.kind;
      kinds[pad.id] = kind;
      // Etiquette gate: disallowed pads fall silent for this phrase.
      const allowed =
        (kind === "kick" && directive.allow.kick) ||
        (kind === "snare" && directive.allow.snare) ||
        (kind === "hat" && directive.allow.hat) ||
        (kind === "perc" && directive.allow.perc);
      rowsByPad[pad.id] = allowed ? rollRow(kind, effectiveEnergy, rand) : new Array<number>(STEPS).fill(0);
    }
    if (directive.fill) applyFillCrescendo(rowsByPad, kinds, rand);
    // Capture the previous rows so undo restores the human/bot state musically.
    const prevRows: Record<string, number[]> = {};
    for (const pad of bot.pads) {
      prevRows[pad.id] = [...(active.rows[pad.id] ?? new Array(STEPS).fill(0))];
    }
    const padIds = bot.pads.map((p) => p.id);
    const command: Command = {
      type: "bandmateRoll",
      label: `KYX phrase ${phraseIndex + 1}${role ? ` [${role}]` : ""}`,
      execute: (d) => withBotRows(d, padIds, rowsByPad),
      undo: (d) => withBotRows(d, padIds, prevRows),
    };
    store.execute(command);
  };

  const tick = (): void => {
    if (!enabled || !transport.playing) return;
    const phraseTicks = BAR_TICKS * phraseBars;
    const position = Math.max(0, transport.position);
    const index = Math.floor(position / phraseTicks);
    if (index === lastPhraseIndex) return;
    lastPhraseIndex = index;
    if (!ensureTrack()) return;
    const phraseProgress = position / phraseTicks - index;
    sceneRole_ = currentSceneRole(store.doc, deps.getMode(), position / BAR_TICKS);
    roll(index, phraseProgress, sceneRole_);
    emit();
  };

  const interval = window.setInterval(tick, TICK_MS);
  void interval; // cleared implicitly when the page dies with the session

  return {
    setEnabled(on: boolean) {
      enabled = on;
      if (!on) lastPhraseIndex = null;
      emit();
    },
    setEnergy(e: number) {
      energy = Math.max(0, Math.min(1, e));
      emit();
    },
    setPhraseBars(bars: number) {
      phraseBars = Math.max(1, Math.min(16, Math.round(bars)));
      lastPhraseIndex = null; // re-roll on the next boundary
      emit();
    },
    getState: () => ({
      enabled,
      energy,
      phraseBars,
      hasTrack: !!trackId,
      lastPhrase: lastPhraseIndex,
      sceneRole: sceneRole_,
    }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tick,
  };
}
