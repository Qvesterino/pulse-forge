import { classifyPads } from "../assist/patternOps";
import type { Pattern, ProjectDocument } from "../project-model/types";
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
}

export const DEFAULT_DICE_LOCKS: DiceLocks = {
  drums: false,
  bass: false,
  chords: false,
  lead: false,
  kick: false,
  snare: false,
  hats: false,
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
export function dicePreviewIntent(session: DiceSession): IntentSpec {
  const seed = session.seedChain[session.cursor] ?? session.seedChain[0];
  return jitteredIntentForSeed(session.intent, seed, session.jitter);
}

export function diceCurrentSeed(session: DiceSession): string {
  return session.seedChain[session.cursor] ?? session.seedChain[0] ?? "";
}
