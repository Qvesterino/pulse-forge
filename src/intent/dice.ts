import { classifyPads } from "../assist/patternOps";
import type { EffectType, Pattern, ProjectDocument } from "../project-model/types";
import { defaultParamsOf } from "../effects/registry";
import { hashString } from "../shared/rng";
import { nextSeed, jitterControls, pickStyle } from "../shared/dice";
import type { IntentSpec } from "./types";
import { normalizeIntent } from "./normalize";

export type DiceMode = "full" | "vary";

export interface DiceLocks {
  drums: boolean;
  bass: boolean;
  chords: boolean;
  lead: boolean;
  kick: boolean;
  snare: boolean;
  hats: boolean;
  kit: boolean;
  /** FX expansion: when locked, dice rolls leave track FX untouched. */
  fx: boolean;
}

export const DEFAULT_DICE_LOCKS: DiceLocks = {
  drums: false,
  bass: false,
  chords: false,
  lead: false,
  kick: false,
  snare: false,
  hats: false,
  kit: false,
  fx: false,
};

export interface DiceSession {
  intent: IntentSpec;
  seedChain: string[];
  cursor: number;
  locks: DiceLocks;
  favorites: Set<number>;
  mode: DiceMode;
  /** 0..1 micro-jitter amount for style/controls (default 0.3) */
  jitter: number;
  /** Selected kit preset id — null = random (dice picks per seed) */
  kitId: string | null;
}

export function createDiceSession(intentInput: Partial<IntentSpec> | IntentSpec, initialSeed?: string): DiceSession {
  const intent = normalizeIntent(intentInput as unknown as Record<string, unknown>);
  const seed = (initialSeed ?? intent.seed ?? "").slice(0, 16) || nextSeed(String(Date.now()), "init");
  // Ensure intent seed matches chain start for preview parity
  const normalizedIntent = normalizeIntent({ ...intent, seed });
  return {
    intent: normalizedIntent,
    seedChain: [seed],
    cursor: 0,
    locks: { ...DEFAULT_DICE_LOCKS },
    favorites: new Set<number>(),
    mode: "full",
    jitter: 0.3,
    kitId: null,
  };
}

export function rollSession(session: DiceSession): DiceSession {
  const currentSeed = session.seedChain[session.cursor] ?? session.seedChain[session.seedChain.length - 1];
  const ns = nextSeed(currentSeed, `dice:${session.mode}`);
  // If cursor is at tip, append; if in middle, truncate forward history then append (branch)
  const base = session.seedChain.slice(0, session.cursor + 1);
  const nextChain = [...base, ns];
  // Cap at 100
  const capped = nextChain.length > 100 ? nextChain.slice(nextChain.length - 100) : nextChain;
  const nextCursor = capped.length - 1;
  // Jittered intent for next preview (style + controls) — deterministic per seed
  const jitteredIntent = jitteredIntentForSeed(session.intent, ns, session.jitter);
  return {
    ...session,
    intent: jitteredIntent,
    seedChain: capped,
    cursor: nextCursor,
  };
}

/** Build the intent that should be used to preview/apply at `seed` with current jitter. */
export function jitteredIntentForSeed(baseIntent: IntentSpec, seed: string, jitter: number): IntentSpec {
  if (jitter <= 0) return normalizeIntent({ ...baseIntent, seed });
  const controls = jitterControls(seed, baseIntent.controls, jitter);
  // Style dice when jitter > 0 — 50% chance to randomize style
  let style: string | null = baseIntent.style;
  if (jitter > 0.15) {
    // Use a separate fork so style doesn't affect controls
    const h = hashString(`${seed}|dice.style-chance`);
    const chance = (h % 1000) / 1000;
    if (chance < jitter * 0.5) {
      style = pickStyle(seed, baseIntent.genre, baseIntent.style);
    }
  }
  return normalizeIntent({ ...baseIntent, seed, style: style ?? undefined, controls });
}

export function jumpSession(session: DiceSession, index: number): DiceSession {
  const clamped = Math.max(0, Math.min(session.seedChain.length - 1, index));
  return { ...session, cursor: clamped };
}

export function toggleLock(session: DiceSession, key: keyof DiceLocks): DiceSession {
  return { ...session, locks: { ...session.locks, [key]: !session.locks[key] } };
}

export function toggleFavorite(session: DiceSession, index: number): DiceSession {
  const next = new Set(session.favorites);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return { ...session, favorites: next };
}

export function setDiceMode(session: DiceSession, mode: DiceMode): DiceSession {
  return { ...session, mode };
}

export function setDiceJitter(session: DiceSession, jitter: number): DiceSession {
  return { ...session, jitter: Math.max(0, Math.min(1, jitter)) };
}

export function setDiceIntent(session: DiceSession, intent: IntentSpec): DiceSession {
  return { ...session, intent: normalizeIntent(intent) };
}

export function setDiceKit(session: DiceSession, kitId: string | null): DiceSession {
  return { ...session, kitId };
}

/**
 * Apply locks by copying locked stems from `prev` into `next`.
 * Pure — does not mutate inputs. `doc` is needed to classify pads/tracks.
 */
export function applyDiceLocks(prev: Pattern | null, next: Pattern, locks: DiceLocks, doc: ProjectDocument): Pattern {
  if (!prev) return next;
  // Fast path: drums fully locked → copy all rows + stepMeta
  if (locks.drums) {
    return {
      ...next,
      rows: { ...prev.rows },
      stepMeta: prev.stepMeta ? JSON.parse(JSON.stringify(prev.stepMeta)) : undefined,
    };
  }

  const drumTrack = doc.tracks.find((t) => t.kind === "drum");
  const pads = drumTrack?.pads ?? [];
  const families = pads.length > 0 ? classifyPads(pads) : null;

  const rows: Record<string, number[]> = { ...next.rows };
  let stepMeta: Pattern["stepMeta"] = next.stepMeta ? JSON.parse(JSON.stringify(next.stepMeta)) : undefined;

  const copyPadFamily = (familyPads: { id: string }[]) => {
    for (const pad of familyPads) {
      if (prev.rows[pad.id]) rows[pad.id] = [...prev.rows[pad.id]];
      if (prev.stepMeta?.[pad.id] && stepMeta) {
        stepMeta[pad.id] = JSON.parse(JSON.stringify(prev.stepMeta[pad.id]));
      } else if (prev.stepMeta?.[pad.id] && !stepMeta) {
        stepMeta = { [pad.id]: JSON.parse(JSON.stringify(prev.stepMeta[pad.id])) };
      }
    }
  };

  if (families) {
    if (locks.kick) copyPadFamily(families.kicks);
    if (locks.snare) copyPadFamily(families.snares);
    if (locks.hats) copyPadFamily(families.hats);
  }

  // Melodic locks — copy notes for instrument tracks by role heuristic
  const instrumentTracks = doc.tracks.filter((t) => t.kind === "instrument");
  const trackIdForRole = (role: "bass" | "chords" | "lead"): string | null => {
    // Prefer name match
    const byName = instrumentTracks.find((t) => t.name.toLowerCase().includes(role));
    if (byName) return byName.id;
    // Fallback to positional: bass=0, chords=1, lead=2
    const idx = role === "bass" ? 0 : role === "chords" ? 1 : 2;
    return instrumentTracks[idx]?.id ?? null;
  };

  let notes: Pattern["notes"] = next.notes ? JSON.parse(JSON.stringify(next.notes)) : {};

  const copyRoleNotes = (role: "bass" | "chords" | "lead") => {
    const tid = trackIdForRole(role);
    if (!tid) return;
    if (prev.notes[tid]) notes[tid] = JSON.parse(JSON.stringify(prev.notes[tid]));
    else if (next.notes[tid] && !prev.notes[tid]) {
      // If prev had no notes for this track but next does, keep next (nothing to lock)
    }
  };

  if (locks.bass) copyRoleNotes("bass");
  if (locks.chords) copyRoleNotes("chords");
  if (locks.lead) copyRoleNotes("lead");

  const out: Pattern = { ...next, rows };
  if (stepMeta) out.stepMeta = stepMeta;
  if (Object.keys(notes).length > 0) out.notes = notes;
  return out;
}

/** Get the active intent+seed for preview (jitter already applied in rollSession). */
export function diceCurrentSeed(session: DiceSession): string {
  return session.seedChain[session.cursor] ?? session.seedChain[0] ?? "";
}

/* ────────────── FX character cards (FX expansion) ────────────── */

/** Effect instance id prefix reserved for dice-applied FX slots. */
export const DICE_FX_PREFIX = "dice-fx-";

/**
 * One rollable FX character card: an effect instance (type + params, plus
 * optional beatMangler envelopes) the dice applies to the drum track.
 * Deterministic per seed — part of the reproducible roll identity.
 */
export interface DiceFxCard {
  key: string;
  label: string;
  type: EffectType;
  /** Omitted = the effect's registry-curated defaults apply at instance build. */
  params?: Record<string, number>;
  volumeSteps?: number[];
  pitchSteps?: number[];
}

/**
 * The rollable palette. All cards ride the FX-expansion effects (pitchShift
 * / tapeStop / ringMod / freqShifter / vinyl / beatMangler) and reuse their
 * preset-style params. `pitchShift`/`vinyl` cards lean on per-instance
 * seeding inside the worklets, so stacked rolls sound distinct.
 */
export const DICE_FX_CARDS: DiceFxCard[] = [
  /* ── pitch ── */
  {
    key: "chop-neg3",
    label: "Chop −3",
    type: "pitchShift",
    params: { semitones: -3, fine: 0, grainMs: 45, width: 0.6, mix: 1 },
  },
  {
    key: "chop-plus4",
    label: "Chop +4",
    type: "pitchShift",
    params: { semitones: 4, fine: 0, grainMs: 38, width: 0.4, mix: 1 },
  },
  {
    key: "chop-octdown",
    label: "Sub Oct",
    type: "pitchShift",
    params: { semitones: -12, grainMs: 70, width: 0, mix: 1 },
  },
  /* ── tape / vinyl ── */
  {
    key: "tape-arm",
    label: "Tape Arm",
    type: "tapeStop",
    // Pre-armed, not engaged — the drummer pulls ENGAGE for fills.
    params: { engaged: 0, time: 0.6, curve: 0, spin: 0, mix: 1 },
  },
  {
    key: "tape-slow",
    label: "Slow Stop",
    type: "tapeStop",
    params: { engaged: 1, time: 4, curve: 0, spin: 0, mix: 1 },
  },
  {
    key: "vinyl-dust",
    label: "Lo-Fi Dust",
    type: "vinyl",
    params: { amount: 0.55, crackle: 0.45, wow: 0.5, year: 0.7, mix: 1 },
  },
  { key: "vinyl-78", label: "78 RPM", type: "vinyl", params: { amount: 0.9, crackle: 0.8, wow: 0.8, year: 1, mix: 1 } },
  /* ── mangler ── */
  {
    key: "mangler-half",
    label: "Halftime",
    type: "beatMangler",
    params: { playMode: 1, repeatFill: 0, mix: 1 },
    volumeSteps: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    pitchSteps: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    key: "mangler-chop",
    label: "Chop Wobble",
    type: "beatMangler",
    params: { playMode: 0, repeatFill: 0, mix: 1 },
    volumeSteps: [1, 0.4, 1, 0.6, 1, 0.4, 1, 0.6, 1, 0.4, 1, 0.6, 1, 0.4, 1, 0.6],
    pitchSteps: [0, 0, 12, 0, 0, -12, 0, 0, 0, 0, 12, 0, -12, 0, 0, 0],
  },
  {
    key: "mangler-fill",
    label: "Fill Bridge",
    type: "beatMangler",
    params: { playMode: 0, repeatFill: 4, mix: 1 },
    volumeSteps: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    pitchSteps: [12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12],
  },
  /* ── movement ── */
  { key: "ring-robot", label: "Robot Ring", type: "ringMod", params: { frequency: 95, feedback: 0.4, mix: 0.85 } },
  { key: "ring-steel", label: "Steel Perc", type: "ringMod", params: { frequency: 830, feedback: 0, mix: 1 } },
  { key: "freq-drift", label: "Sub Drift", type: "freqShifter", params: { shift: -38, mix: 0.9 } },
  { key: "freq-metal", label: "Metal Air", type: "freqShifter", params: { shift: 620, mix: 0.7 } },
  {
    key: "tremolo-fast",
    label: "Trem Fast",
    type: "tremolo",
    params: { rate: 12, depth: 0.8, shape: 0, mode: 0, mix: 1 },
  },
  {
    key: "tremolo-slow",
    label: "Trem Slow",
    type: "tremolo",
    params: { rate: 3, depth: 0.7, shape: 0, mode: 1, mix: 1 },
  },
  { key: "autowah-funk", label: "Auto Wah", type: "autowah", params: { mix: 0.8 } },
  { key: "flanger-jet", label: "Jet Flange", type: "flanger", params: { mix: 0.6 } },
  { key: "phaser-sweep", label: "Phaser", type: "phaser", params: { mix: 0.7 } },
  { key: "haas-wide", label: "Quick Wide", type: "haasWidener", params: { delayMs: 14, width: 0.85, feedback: 0 } },
  { key: "comb-metal", label: "Comb Metal", type: "comb", params: { mix: 0.6 } },
  /* ── dynamics / character ── */
  { key: "transient-attack", label: "Snap Attack", type: "transient", params: { attack: 0.85, sustain: -0.4, mix: 1 } },
  { key: "saturation-warm", label: "Warm Drive", type: "saturation", params: { mix: 0.8 } },
  { key: "tape-warm", label: "Tape Warm", type: "tapeSat", params: { drive: 0.5, tone: 5500, mix: 1 } },
  { key: "clipper-hard", label: "Hard Clip", type: "clipper", params: { drive: 0.5, ceiling: -3, softness: 0.1 } },
  { key: "distort-grit", label: "Grit", type: "distortion", params: { drive: 0.55, tone: 6000, mix: 1 } },
  { key: "bitcrush-8bit", label: "8-Bit", type: "bitcrusher", params: { mix: 1 } },
  { key: "chorus-lush", label: "Lush Chorus", type: "chorus", params: { mix: 0.6 } },
  /* ── space ── */
  { key: "delay-8th", label: "Delay 1/8", type: "delay", params: { sync: 4, feedback: 0.4, tone: 4500, mix: 0.4 } },
  {
    key: "delay-dotted",
    label: "Dotted 1/8",
    type: "delay",
    params: { sync: 3, feedback: 0.45, tone: 4000, mix: 0.4 },
  },
  { key: "reverb-tight", label: "Tight Room", type: "reverb", params: { mix: 0.3 } },
  { key: "shimmer-halo", label: "Shimmer", type: "shimmer", params: { mix: 0.5 } },
  { key: "duckdelay-pump", label: "Duck Delay", type: "duckDelay", params: { mix: 0.4 } },
];

/** Stable per-card instance id — replace-on-apply without extra doc state. */
export function diceFxInstanceId(card: DiceFxCard): string {
  return `${DICE_FX_PREFIX}${card.key}`;
}

/**
 * Deterministically pick the FX card for a seed (null = no FX this roll —
 * happens for ~22% of seeds so rolls without colour stay in the mix).
 * `locks.fx` forces null: a locked FX means "dice can't touch my effects".
 */
export function pickDiceFx(seed: string, locks: DiceLocks): DiceFxCard | null {
  if (locks.fx) return null;
  const h = hashString(`${seed}|dice.fx`);
  const roll = (h % 10000) / 10000;
  if (roll < 0.22) return null; // no-FX roll keeps clean kits in the mix
  const index = Math.floor((((h >>> 8) % 100000) / 100000) * DICE_FX_CARDS.length);
  return DICE_FX_CARDS[Math.min(DICE_FX_CARDS.length - 1, index)];
}

const isDiceFxInstance = (fx: { id: string }): boolean => fx.id.startsWith(DICE_FX_PREFIX);

/**
 * Pure doc transform: install the card's effect instance on the drum track,
 * replacing any previous dice-FX slots (stable ids make replace-on-apply
 * survive reloads without extra document state). User-added effects stay.
 */
export function applyDiceFxToDoc(doc: ProjectDocument, card: DiceFxCard, drumTrackId?: string): ProjectDocument {
  const targetTrackId = drumTrackId ?? doc.tracks.find((track) => track.kind === "drum")?.id;
  if (!targetTrackId) return doc;
  return {
    ...doc,
    tracks: doc.tracks.map((track) => {
      if (track.kind !== "drum" || track.id !== targetTrackId) return track;
      const kept = track.effects.filter((fx) => !isDiceFxInstance(fx));
      const instance = {
        id: diceFxInstanceId(card),
        type: card.type,
        bypassed: false,
        params: { ...defaultParamsOf(card.type), ...card.params },
        ...(card.volumeSteps ? { volumeSteps: [...card.volumeSteps] } : {}),
        ...(card.pitchSteps ? { pitchSteps: [...card.pitchSteps] } : {}),
      };
      return { ...track, effects: [...kept, instance] };
    }),
  };
}

/** Pure doc transform: strip every dice-FX slot (back to the user's own FX). */
export function clearDiceFx(doc: ProjectDocument, drumTrackId?: string): ProjectDocument {
  const targetTrackId = drumTrackId ?? doc.tracks.find((track) => track.kind === "drum")?.id;
  if (!targetTrackId) return doc;
  return {
    ...doc,
    tracks: doc.tracks.map((track) => {
      if (track.kind !== "drum" || track.id !== targetTrackId) return track;
      if (!track.effects.some((fx) => isDiceFxInstance(fx))) return track;
      return { ...track, effects: track.effects.filter((fx) => !isDiceFxInstance(fx)) };
    }),
  };
}

/** Apply the seeded FX decision while keeping a locked chain byte-for-byte intact. */
export function applyDiceFxForRoll(
  doc: ProjectDocument,
  seed: string,
  locks: DiceLocks,
  drumTrackId?: string,
): ProjectDocument {
  if (locks.fx) return doc;
  const card = pickDiceFx(seed, locks);
  return card ? applyDiceFxToDoc(doc, card, drumTrackId) : clearDiceFx(doc, drumTrackId);
}
