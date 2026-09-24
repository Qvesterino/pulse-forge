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
import { setBpm, setMasterConfig, setTrackParams } from "../commands/commands";
import type { ProjectDocument } from "../project-model/types";
import type { ProductionIntent, ProductionTarget } from "./production";

// ── FADER ("zníž basu", "hlasnejšie bicie", "turn down the drums") ──────────

export type FaderTarget = "drums" | "bass" | "chords" | "lead" | "master";

export interface FaderIntent {
  targets: FaderTarget[];
  direction: "down" | "up";
}

/** ALL SK stems DE-ACCENTED — the parser strips diacritics before matching. */
const FADER_DOWN =
  /\bzniz|\bstis|\bnizs|\btahaj dole|\bdaj dole|\btichs|\bdole\b|\bturn down\b|\bpull down\b|\bbring down\b|\blower\b|\bdial down\b/;
const FADER_UP =
  /\bzvis\b|\bzvys|\bvyss\b|\bpotiahni hore|\btahaj hore|\bdaj hore|\bhlasnej|\bhore\b|\bturn up\b|\bbring up\b|\braise\b|\bpush up\b/;

const FADER_TARGETS: ReadonlyArray<readonly [RegExp, FaderTarget]> = [
  [/\bbas(?:u|e|y|ov)?\b|\bbass\b|\b808\b/, "bass"],
  [/\bbic(?:i|ie|ich)?\b|\bbubn\w*|\bdrums?\b|\bbeat\b/, "drums"],
  [/\bklaves|\bakord\w*|\bchords?\b|\bkeys\b|\bpadov?\b/, "chords"],
  [/\blead\w*\b|\bmelodi\w*|\bsynth\w*\b/, "lead"],
  [
    /\bmaster\b|\bvsetk\w*|\bcely (?:mix|beat)\b|\beverything\b|\bwhole (?:mix|beat)\b|\bmaster (?:fader|gain)\b/,
    "master",
  ],
];

export function parseFaderIntent(text: string): FaderIntent | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  const down = FADER_DOWN.test(lower);
  const up = !down && FADER_UP.test(lower);
  if (!down && !up) return null;
  const targets = FADER_TARGETS.filter(([pattern]) => pattern.test(lower)).map(([, target]) => target);
  if (targets.length === 0) return null; // "zniz" alone is ambiguous — not a fader
  return { targets, direction: down ? "down" : "up" };
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
const FADER_FACTOR = { down: 0.82, up: 1.22 } as const;

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

/** Apply a fader intent → the undoable gain commands (one per target track). */
export function applyFaderIntent(doc: ProjectDocument, intent: FaderIntent): Command[] {
  const factor = FADER_FACTOR[intent.direction];
  const commands: Command[] = [];
  for (const target of intent.targets) {
    if (target === "master") {
      const masterGain = doc.master?.masterGain ?? 1;
      commands.push(setMasterConfig(doc, { masterGain: Math.max(GAIN_MIN, Math.min(GAIN_MAX, masterGain * factor)) }));
      continue;
    }
    for (const trackId of trackIdsForTarget(doc, target)) {
      const track = doc.tracks.find((track) => track.id === trackId);
      if (!track) continue;
      const gain = Math.max(GAIN_MIN, Math.min(GAIN_MAX, track.gain * factor));
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
