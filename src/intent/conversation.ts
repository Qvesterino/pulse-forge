/**
 * CONVERSATION INTENTS — the producer speaks plain language (GOAL 38).
 *
 * Three everyday requests that used to need the Mixer or the transport:
 *
 *   "zníž basu" / "turn down the bass"   → track FADER (real gain change)
 *   "zníž tempo" / "na 128" / "pomalší"  → project BPM
 *   "popovejšie" / "more pop"            → bright + punchy composite (vibe)
 *
 * Detection rules: a FADER needs BOTH a direction stem and a target noun
 * ("zníž" alone is ambiguous), a TEMPO needs a tempo word, and the POP vibe
 * is its own phrase family ("pop" alone stays a genre word in generation).
 * All detection runs on DE-ACCENTED lowercase — SK stems are written without
 * diacritics on purpose (see text-parser gotcha): "zníž" is detected by the
 * stem "zniz", never by the accented form.
 *
 * Application helpers return undoable Commands; the panel executes them and
 * reports. Never throws.
 */
import type { Command } from "../commands/types";
import { setBpm, setMasterConfig, setPadParams, setTrackParams } from "../commands/commands";
import { parsePercent } from "./percent";
import { inferPadRole } from "../ai/pad-roles";
import type { DrumTrack, ProjectDocument } from "../project-model/types";
import type { ProductionIntent, ProductionTarget } from "./production";

// ── FADER ("zníž basu", "hlasnejšie bicie", "turn down the drums") ──────────

export type FaderTarget = "drums" | "bass" | "chords" | "lead" | "master";

/** Per-PAD families inside the drum track ("kick ťažší", "haty tichšie"). */
export type FaderPadFamily = "kick" | "snare" | "clap" | "hat" | "perc" | "tom";

export type FaderAmount = "subtle" | "normal" | "big" | "full";

export interface FaderIntent {
  targets: FaderTarget[];
  /** Per-PAD families ("kick ťažší") — empty when the intent is track-level. */
  pads?: FaderPadFamily[];
  direction: "down" | "up";
  /** Fader step size. Default "normal" (×0.82 down / ×1.22 up). */
  amount?: FaderAmount;
  /**
   * Explicit percent ("o 10 %") — relative gain change in the parsed
   * direction (up ×1.10 / down ×0.90). Wins over vibe `amount` when present.
   */
  percent?: number;
}

/** ALL SK stems DE-ACCENTED — the parser strips diacritics before matching. */
const FADER_DOWN =
  /\bzniz|\bstis|\bnizs|\btahaj dole|\bdaj dole|\btichs|\bdole\b|\bturn down\b|\bpull down\b|\bbring down\b|\blower\b|\bdial down\b/;
const FADER_UP =
  /\bzvis\b|\bzvys|\bvyss\b|\btazs\w*|\bpotiahni hore|\btahaj hore|\bdaj hore|\bhlasnej|\bhlasit|\bhore\b|\bturn up\b|\bbring up\b|\braise\b|\bpush up\b/;

const FADER_TARGETS: ReadonlyArray<readonly [RegExp, FaderTarget]> = [
  [/\bbas(?:u|e|y|ov|om)?\b|\bbass\w*|\b808\w*/, "bass"],
  [/\bbic(?:i|ie|ich)?\b|\bbubn\w*|\bdrums?\b|\bbeat\b/, "drums"],
  [/\bklaves|\bakord\w*|\bchords?\b|\bkeys\b|\bpadov?\b/, "chords"],
  [/\blead\w*\b|\bmelodi\w*|\bsynth\w*\b/, "lead"],
  [
    /\bmaster\b|\bvsetk\w*|\bcely (?:mix|beat)\b|\beverything\b|\bwhole (?:mix|beat)\b|\bmaster (?:fader|gain)\b/,
    "master",
  ],
];

const FADER_PADS: ReadonlyArray<readonly [RegExp, FaderPadFamily]> = [
  [/\bkick\w*/, "kick"],
  [/\bsnare\w*/, "snare"],
  [/\bclap\w*/, "clap"],
  [/\bhat\w*|\bhi.?hat\w*|\bcinel\w*/, "hat"],
  [/\btoms?\b/, "tom"],
  [/\bperc\w*|\bperkus\w*/, "perc"],
];

/** Amount modifiers: "trochu" / "o dosť" / "úplne" scale the fader step. */
const AMOUNT_FULL = /\bupl\w*|\bplne\b|\bmaximal\w*|\bcomplete(?:ly)?\b|\bfully\b|\bextrem\w*/;
const AMOUNT_BIG = /\bo dos\w*|\bdost\b|\bhodn\w*|\bvelm\w*|\ba lot\b|\bmuch\b/;
const AMOUNT_SUBTLE = /\btrochu\b|\bkusok\b|\bjemn\w*|\bslight(?:ly)?\b|\ba bit\b|\ba little\b/;

export function parseFaderIntent(text: string): FaderIntent | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  const down = FADER_DOWN.test(lower);
  const up = !down && FADER_UP.test(lower);
  if (!down && !up) return null;
  const targets = FADER_TARGETS.filter(([pattern]) => pattern.test(lower)).map(([, target]) => target);
  const pads = FADER_PADS.filter(([pattern]) => pattern.test(lower)).map(([, family]) => family);
  if (targets.length === 0 && pads.length === 0) return null; // "zniz" alone is ambiguous
  const amount: FaderAmount = AMOUNT_FULL.test(lower)
    ? "full"
    : AMOUNT_BIG.test(lower)
      ? "big"
      : AMOUNT_SUBTLE.test(lower)
        ? "subtle"
        : "normal";
  // Explicit numbers beat vibe words ("o 10 %" wins over "trochu").
  const percent = parsePercent(text);
  return { targets, pads, direction: down ? "down" : "up", amount, ...(percent != null ? { percent } : {}) };
}

// ── TEMPO ("zníž tempo", "pomalší", "zrýchli to", "na 128") ──────────────────

export interface TempoIntent {
  direction: "down" | "up" | "set";
  /** "set" mode: the exact BPM ("tempo na 128", "140 bpm"). */
  bpm?: number;
}

const HAS_TEMPO_WORD =
  /\btempo\b|\bbpm\b|\bpomal|\brychl|\bslow(?:er| down| it down)?\b|\bfaster\b|\bspeed (?:it )?up\b|\bzrychli|\btempa\b/;
const TEMPO_DOWN = /dole|down|nizs|zniz|pomal|slow|spomal/;
const TEMPO_UP = /hore|up|vys|zvys|rychl|faster|speed|zrychli/;
const TEMPO_SET = /(?:tempo|bpm) (?:na |to |at )?(\d{2,3})|(\d{2,3}) bpm/;

export function parseTempoIntent(text: string): TempoIntent | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  if (!HAS_TEMPO_WORD.test(lower)) return null;
  const setMatch = TEMPO_SET.exec(lower);
  if (setMatch) {
    const bpm = Number(setMatch[1] ?? setMatch[2]);
    if (bpm >= 40 && bpm <= 220) return { direction: "set", bpm };
  }
  if (TEMPO_DOWN.test(lower)) return { direction: "down" };
  if (TEMPO_UP.test(lower)) return { direction: "up" };
  return null;
}

// ── VIBE ("popovejšie", "more pop") — a composite production intent ──────────

/**
 * "Popovejšie" is not a genre swap — it is a SOUND: brighter top, more punch,
 * a little wider. We express it as a composite production intent over ALL
 * mix tracks so the existing production planner (real DSP on real tracks)
 * does the work — nothing new to maintain.
 */
export function parsePopIntent(text: string): ProductionIntent | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  if (!/\bpopov\w*|\bmore pop(?:py|pier)?\b|\bpoppy\b|\bpop(?:py|pier)-?ish\b/.test(lower)) return null;
  const targets: ProductionTarget[] = ["drums", "bass", "chords", "lead"];
  return {
    targets,
    goals: [
      { concept: "brighter", amount: 0.7 },
      { concept: "punchier", amount: 0.6 },
      { concept: "wider", amount: 0.5 },
    ],
    sourceText: text,
  };
}

// ── Application helpers (undoable commands; panel executes) ─────────────────

const GAIN_MIN = 0;
const GAIN_MAX = 1.5;
/** Per-amount fader factors: down multiplies (≤1), up multiplies (≥1). */
const FADER_FACTORS: Record<FaderAmount, { down: number; up: number }> = {
  subtle: { down: 0.92, up: 1.08 },
  normal: { down: 0.82, up: 1.22 },
  big: { down: 0.7, up: 1.35 },
  full: { down: 0.5, up: 1.6 },
};

const clampGain = (value: number): number => Math.round(Math.max(GAIN_MIN, Math.min(GAIN_MAX, value)) * 100) / 100;

const PAD_FAMILY_MATCH: Record<FaderPadFamily, (role: string) => boolean> = {
  kick: (role) => role === "kick",
  snare: (role) => role === "snare",
  clap: (role) => role === "clap",
  hat: (role) => role === "closedHat" || role === "openHat",
  perc: (role) => role === "perc",
  tom: (role) => role === "tom",
};

function trackIdsForTarget(doc: ProjectDocument, target: FaderTarget): string[] {
  if (target === "drums") {
    return doc.tracks.filter((track) => track.kind === "drum").map((track) => track.id);
  }
  const instruments = doc.tracks.filter(
    (track): track is Extract<typeof track, { kind: "instrument" }> => track.kind === "instrument",
  );
  const roleIndex: Record<string, number> = { bass: 0, chords: 1, lead: 2 };
  const named = instruments.filter((track) => track.name.toLowerCase().includes(target));
  if (named.length > 0) return named.map((track) => track.id);
  const fallback = instruments[roleIndex[target] % Math.max(1, instruments.length)];
  return fallback ? [fallback.id] : [];
}

/**
 * Apply a fader intent → the undoable gain commands. PER-PAD families
 * ("kick ťažší", "haty tichšie") drive setPadParams on the matching drum
 * pads; track targets drive setTrackParams / setMasterConfig. Pads first,
 * then tracks.
 */
export function applyFaderIntent(doc: ProjectDocument, intent: FaderIntent): Command[] {
  // Percent = relative gain change in the parsed direction (10 % → ×1.10 up
  // / ×0.90 down); vibe amounts are the fallback when no number is named.
  const factor =
    intent.percent != null
      ? intent.direction === "down"
        ? Math.max(0, 1 - intent.percent / 100)
        : 1 + intent.percent / 100
      : (() => {
          const factors = FADER_FACTORS[intent.amount ?? "normal"];
          return intent.direction === "down" ? factors.down : factors.up;
        })();
  const commands: Command[] = [];

  if ((intent.pads?.length ?? 0) > 0) {
    const drumTrack = doc.tracks.find((track): track is DrumTrack => track.kind === "drum");
    if (drumTrack) {
      for (const [padIndex, pad] of drumTrack.pads.entries()) {
        const role = inferPadRole(pad.name, padIndex);
        if (!(intent.pads ?? []).some((family) => PAD_FAMILY_MATCH[family](role))) continue;
        const gain = clampGain(pad.gain * factor);
        if (gain === pad.gain) continue;
        commands.push(setPadParams(doc, pad.id, { gain }));
      }
    }
  }

  for (const target of intent.targets) {
    if (target === "master") {
      const masterGain = doc.master?.masterGain ?? 1;
      commands.push(setMasterConfig(doc, { masterGain: Math.max(GAIN_MIN, Math.min(GAIN_MAX, masterGain * factor)) }));
      continue;
    }
    for (const trackId of trackIdsForTarget(doc, target)) {
      const track = doc.tracks.find((track) => track.id === trackId);
      if (!track) continue;
      const gain = clampGain(track.gain * factor);
      commands.push(setTrackParams(doc, trackId, { gain }));
    }
  }
  return commands;
}

const TEMPO_STEP_BPM = 6;

/** Apply a tempo intent → ONE undoable setBpm command (clamped by setBpm). */
export function applyTempoIntent(doc: ProjectDocument, intent: TempoIntent): Command {
  if (intent.direction === "set" && intent.bpm) return setBpm(doc, intent.bpm);
  const delta = intent.direction === "up" ? TEMPO_STEP_BPM : -TEMPO_STEP_BPM;
  return setBpm(doc, doc.bpm + delta);
}
