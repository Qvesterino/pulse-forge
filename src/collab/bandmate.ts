import { createDrumTrack } from "../commands/commands";
import type { Command } from "../commands/types";
import { hashString, mulberry32 } from "../shared/rng";
import type { ProjectDocument } from "../project-model/types";
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

export function createBandmate(deps: {
  store: StoreLike;
  transport: Transport;
  roomId: string;
}): BandmateControls {
  const { store, transport, roomId } = deps;
  let enabled = false;
  let energy = 0.6;
  let phraseBars = 8;
  let trackId: string | null = null;
  let lastPhraseIndex: number | null = null;
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

  const roll = (phraseIndex: number): void => {
    const bot = findBotTrack();
    if (!bot) return;
    const active = store.doc.patterns.find((p) => p.id === store.doc.activePatternId);
    if (!active) return;
    const rand = mulberry32(hashString(`${roomId}:kyx:${phraseIndex}`));
    const rowsByPad: Record<string, number[]> = {};
    for (const pad of bot.pads) rowsByPad[pad.id] = rollRow(pad.kind, energy, rand);
    // Capture the previous rows so undo restores the human/bot state musically.
    const prevRows: Record<string, number[]> = {};
    for (const pad of bot.pads) {
      prevRows[pad.id] = [...(active.rows[pad.id] ?? new Array(STEPS).fill(0))];
    }
    const padIds = bot.pads.map((p) => p.id);
    const command: Command = {
      type: "bandmateRoll",
      label: `KYX phrase ${phraseIndex + 1}`,
      execute: (d) => withBotRows(d, padIds, rowsByPad),
      undo: (d) => withBotRows(d, padIds, prevRows),
    };
    store.execute(command);
  };

  const tick = (): void => {
    if (!enabled || !transport.playing) return;
    const phraseTicks = BAR_TICKS * phraseBars;
    const index = Math.floor(Math.max(0, transport.position) / phraseTicks);
    if (index === lastPhraseIndex) return;
    lastPhraseIndex = index;
    if (!ensureTrack()) return;
    roll(index);
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
    }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tick,
  };
}
