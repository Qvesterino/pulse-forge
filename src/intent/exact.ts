import type { MusicalKey, ProjectDocument } from "../project-model/types";
import { MUSICAL_KEYS } from "../project-model/types";

/**
 * Exact Intents (KYX_PRODUCTION_INTENT_ENGINE_MASTER.md §4.1, §19):
 * deterministic extraction of explicit commands — tempo, key, mute/solo,
 * pan, gain (dB deltas), transpose, pattern length. No models: cheap,
 * predictable, testable (master doc §4.1 — "prefer exact extraction first").
 *
 * SK extends DETECTION (nastav/stis/basa/bicie…); compiled operations are
 * canonical KYX commands. Returns null when nothing exact is detected so the
 * caller can fall through to production/generation intents.
 */

export type ExactTarget = "drums" | "bass" | "lead" | "chords" | "mix";

export type ExactOp =
  | { kind: "tempo"; bpm: number }
  | { kind: "key"; key: MusicalKey }
  | { kind: "mute"; target: ExactTarget; value: boolean }
  | { kind: "solo"; target: ExactTarget; value: boolean }
  | { kind: "pan"; target: ExactTarget; value: number }
  | { kind: "gainDb"; target: ExactTarget; deltaDb: number }
  | { kind: "transpose"; target: ExactTarget; semitones: number }
  | { kind: "patternLength"; steps: number };

export interface ExactIntentPlan {
  label: string;
  ops: ExactOp[];
}

const TARGET_RES: [RegExp, ExactTarget][] = [
  [/\bdrums?\b|\bbic\u00edc|\bbubny\b/i, "drums"],
  [/\bbass\b|\b808\b|\bbasa\b/i, "bass"],
  [/\blead\b|\bsynth(?:esizer)?\b|\bsynt\u00e9z/i, "lead"],
  [/\bchords?\b|\bkeys?\b|\bakord/i, "chords"],
  [/\b(?:the )?mix\b|\bmaster\b|\bv\u0161etko\b/i, "mix"],
];

function firstTarget(lower: string): ExactTarget | null {
  for (const [re, target] of TARGET_RES) {
    if (re.test(lower)) return target;
  }
  return null;
}

const SCALE_MAP: Record<string, string> = {
  major: "Major",
  maj: "Major",
  minor: "Natural Minor",
  min: "Natural Minor",
  "natural minor": "Natural Minor",
  "harmonic minor": "Harmonic Minor",
  "melodic minor": "Melodic Minor",
  dorian: "Dorian",
  phrygian: "Phrygian",
  mixolydian: "Mixolydian",
  locrian: "Locrian",
  "pentatonic major": "Pentatonic Major",
  "pentatonic minor": "Pentatonic Minor",
};

const NOTE_BASE: Record<string, string> = {
  c: "C",
  d: "D",
  e: "E",
  f: "F",
  g: "G",
  a: "A",
  b: "B",
  h: "B",
};

/** "db" → "C#", "eb" → "D#", … (the key list is sharp-spelled). */
function flatToSharp(letter: string, accidental: string): string {
  if (accidental !== "b") return NOTE_BASE[letter] + accidental;
  const flatMap: Record<string, string> = { d: "C#", e: "D#", g: "F#", a: "G#", b: "A#" };
  return flatMap[letter] ?? NOTE_BASE[letter];
}

export function parseExactIntent(text: string): ExactIntentPlan | null {
  const lower = text.toLowerCase();
  const ops: ExactOp[] = [];

  // Tempo: "set tempo to 142", "142 bpm", "tempo 138"
  const tempo =
    /(?:tempo|bpm)\s*(?:to|=|:)?\s*(\d{1,3})\b/.exec(lower) ?? /\b(\d{1,3})\s*bpm\b/.exec(lower);
  if (tempo) {
    const bpm = Math.min(300, Math.max(20, Number(tempo[1])));
    ops.push({ kind: "tempo", bpm });
  }

  // Key: "change the key to D minor", "key = f# minor", "d mol"
  const key = /(?:key|tonina)\s*(?:to|=|:)?\s*([a-h])\s*(#|b|\u266f|\u266d)?\s*(natural\s+|harmonic\s+|melodic\s+|pentatonic\s+)?(major|minor|maj|min|mol|dorian|phrygian|mixolydian|locrian)/.exec(
    lower,
  );
  if (key) {
    const letter = key[1];
    const accidental = key[2] === "\u266f" ? "#" : key[2] === "\u266d" ? "b" : (key[2] ?? "");
    const scaleWord = `${key[3] ?? ""}${key[4]}`.trim();
    const scale = SCALE_MAP[scaleWord];
    const note = flatToSharp(letter, accidental);
    const musicalKey = `${note} ${scale}` as MusicalKey;
    if ((MUSICAL_KEYS as string[]).includes(musicalKey)) ops.push({ kind: "key", key: musicalKey });
  }

  // Mute / unmute / solo — target required, otherwise skip (too ambiguous).
  const muteMatch = /\b(mute|st\u00eds)\s+(?:the\s+)?([a-z]+)\b/.exec(lower);
  const unmuteMatch = /\b(unmute|zapni)\s+(?:the\s+)?([a-z]+)\b/.exec(lower);
  const soloMatch = /\b(solo)\s+(?:the\s+)?([a-z]+)\b/.exec(lower);
  if (unmuteMatch) {
    const target = firstTarget(unmuteMatch[2]);
    if (target) ops.push({ kind: "mute", target, value: false });
  } else if (muteMatch) {
    const target = firstTarget(muteMatch[2]);
    if (target) ops.push({ kind: "mute", target, value: true });
  }
  if (soloMatch) {
    const target = firstTarget(soloMatch[1] + " " + soloMatch[2]);
    if (target) ops.push({ kind: "solo", target, value: true });
  }

  // Pan: "pan the hats 20% right", "pan bass left 30"
  const pan =
    /pan\s+(?:the\s+)?([a-z]+)\s*(?:to\s*)?(\d{1,3})\s*%?\s*(left|right|lavo|pravo)?/.exec(lower) ??
    /pan\s+(?:the\s+)?([a-z]+)\s*(left|right)\s*(\d{1,3})?/.exec(lower);
  if (pan) {
    const target = firstTarget(pan[1]);
    let pct = Number(pan[2]);
    let dir = pan[3];
    if (target && Number.isFinite(pct)) {
      if (dir === "left") pct = -pct;
      if (/left|lavo/.test(lower) && !dir && /to\s*-?\d/.test(lower)) pct = -pct;
      const value = Math.max(-1, Math.min(1, pct / 100));
      ops.push({ kind: "pan", target, value });
    }
  }

  // Gain dB delta: "lower drums by 2 dB", "boost the mix by 1.5 dB"
  const gainDb =
    /(lower|reduce|drop|cut|raise|boost|increase)\s+(?:the\s+)?(drums?|bass|808|lead|synth|chords?|keys?|mix|master)\b(?:\s+by\s+)?\s*(\d+(?:\.\d+)?)?\s*db/.exec(
      lower,
    );
  if (gainDb) {
    const target = firstTarget(gainDb[2]);
    const sign = /lower|reduce|drop|cut/.test(gainDb[1]) ? -1 : 1;
    if (target) ops.push({ kind: "gainDb", target, deltaDb: sign * Number(gainDb[3] ?? 2) });
  }

  // Transpose: "transpose the lead up one octave", "transpose bass down 3 semitones"
  const transpose =
    /transpose\s+(?:the\s+)?([a-z]+)\s+(up|down|hore|dole)\s+(one|two|three|an)?\s*(octaves?|semitones?|st)\b/.exec(
      lower,
    );
  if (transpose) {
    const target = firstTarget(transpose[1]) ?? "lead";
    const dir = /up|hore/.test(transpose[2]) ? 1 : -1;
    const unit = transpose[4];
    const count = transpose[3] === "one" || transpose[3] === "an" ? 1 : transpose[3] === "two" ? 2 : transpose[3] === "three" ? 3 : Number(transpose[3] ?? 1);
    const semitones = dir * (/octave/.test(unit) ? 12 * (count || 1) : (count || 1));
    ops.push({ kind: "transpose", target, semitones });
  }

  // Pattern length: "pattern length to 32", "length to 64"
  const length = /(?:pattern\s+)?length\s*(?:to|=|:)?\s*(\d{1,3})\b/.exec(lower);
  if (length) {
    const steps = Number(length[1]);
    if ([16, 32, 64, 128, 256].includes(steps)) ops.push({ kind: "patternLength", steps });
  }

  if (ops.length === 0) return null;
  const label = ops
    .map((op) => {
      if (op.kind === "tempo") return `tempo ${op.bpm}`;
      if (op.kind === "key") return `key ${op.key}`;
      if (op.kind === "mute") return `${op.value ? "mute" : "unmute"} ${op.target}`;
      if (op.kind === "solo") return `solo ${op.target}`;
      if (op.kind === "pan") return `pan ${op.target} ${op.value.toFixed(2)}`;
      if (op.kind === "gainDb") return `${op.deltaDb > 0 ? "+" : ""}${op.deltaDb} dB ${op.target}`;
      if (op.kind === "transpose") return `transpose ${op.target} ${op.semitones > 0 ? "+" : ""}${op.semitones} st`;
      return `length ${op.steps}`;
    })
    .join(", ");
  return { label, ops };
}
