export const PPQ = 480;
export const STEPS_PER_PATTERN = 16;
export const STEP_TICKS = PPQ / 4;
export const BAR_TICKS = PPQ * 4;
export const PATTERN_TICKS = BAR_TICKS;

export type ID = string;

export type EffectType =
  | "eq"
  | "compressor"
  | "saturation"
  | "clipper"
  | "reverb"
  | "delay"
  | "pump"
  | "distortion"
  | "bitcrusher"
  | "chorus"
  | "phaser"
  | "sidechain";

export type InstrumentKind = "sampler" | "analog" | "bass" | "808" | "texture";

export interface EffectInstance {
  id: ID;
  type: EffectType;
  bypassed: boolean;
  params: Record<string, number>;
  /**
   * Optional source track id for sidechain-style effects (e.g. Sidechain Compressor).
   * When set, the audio engine wires the source track's input node as sidechain feed
   * to the effect runtime via `setSidechainInput`. Null = no sidechain feed.
   */
  sidechainTrackId?: ID | null;
}

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export interface DrumPad {
  id: ID;
  name: string;
  assetId: string | null;
  gain: number;
  pan: number;
  pitch: number;
  mute: boolean;
  solo: boolean;
  chokeGroup: number | null;
}

export interface DrumTrack {
  id: ID;
  kind: "drum";
  name: string;
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  pads: DrumPad[];
  effects: EffectInstance[];
  sends: Record<ID, number>;
}

export interface InstrumentTrack {
  id: ID;
  kind: "instrument";
  instrument: InstrumentKind;
  name: string;
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  sampleId: string | null;
  params: Record<string, number>;
  /** Id of the last applied preset (factory or user). Dangling/absent = "Custom". */
  presetId?: string | null;
  effects: EffectInstance[];
  sends: Record<ID, number>;
}

export type Track = DrumTrack | InstrumentTrack;

export interface ReturnTrack {
  id: ID;
  kind: "return";
  name: string;
  gain: number;
  effects: EffectInstance[];
}

export interface MasterConfig {
  /** Master input trim (0..2 → -∞..+6 dB). Pull this down before the limiter if the mix peaks. */
  masterGain: number;
  /** Limiter ceiling in dBFS (e.g. -1.0 = -1 dBFS). */
  ceilingDb: number;
  limiterEnabled: boolean;
  clipperEnabled: boolean;
}

export interface NoteEvent {
  id: ID;
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

/**
 * Per-step performance metadata (probability / ratchet / microtiming).
 * All fields are optional — an absent entry means "straight": probability 1,
 * ratchet 1, microtiming 0.
 */
export interface StepMeta {
  /** 0..1 — chance the hit plays on each pass (deterministic seeded roll). */
  probability?: number;
  /** 1..8 — how many times the step retriggers within its slot. */
  ratchet?: number;
  /** -1..1 — timing shift, early ← 0 → late (a fraction of a step). */
  microtiming?: number;
}

export interface Pattern {
  id: ID;
  name: string;
  stepCount: number;
  rows: Record<ID, number[]>;
  notes: Record<ID, NoteEvent[]>;
  /** padId → stepIndex → performance metadata. Optional (schema v1 addendum). */
  stepMeta?: Record<ID, Record<number, StepMeta>>;
}

/** Project-level groove: 0..1 swing delays off-grid 16ths toward a triplet feel. */
export interface GrooveSettings {
  swing: number;
  humanizeTiming: number;
  humanizeVelocity: number;
}

export type PlayMode = "pattern" | "song";

export interface Scene {
  id: ID;
  name: string;
  patternId: ID;
  /** Static 0..1 intensity. Drives any modulation target bound via `source: "intensity"`. */
  intensity: number;
  /** Optional time-varying intensity curve (ticks relative to scene start). Drawn over the static `intensity`. */
  intensityCurve?: IntensityPoint[];
  /** When true, a clip referencing this scene loops its tail indefinitely. */
  loop?: boolean;
}

export interface IntensityPoint {
  /** Ticks offset from the scene's start. */
  offset: number;
  /** 0..1 — instantaneous intensity at this offset. */
  value: number;
}

export interface Marker {
  id: ID;
  /** Human-readable label (shown in the timeline and exported as the cue filename). */
  name: string;
  type: "drop" | "buildup" | "riser" | "impact" | "cue" | "custom";
  /** Absolute project tick. */
  tick: number;
  /** Optional clip the marker is tied to (moves when the clip is moved). */
  linkedClipId?: ID;
  /** Optional custom payload id echoed in the exported scorepack. */
  customId?: string;
}

export interface SceneAutomation {
  id: ID;
  sceneId: ID;
  target: AutomationTarget;
  /** Automation points — ticks are relative to the scene's start. */
  points: AutomationPoint[];
}

export interface ArrangementClip {
  id: ID;
  sceneId: ID;
  startBar: number;
  lengthBars: number;
  /** Per-clip loop flag. Falls back to the referenced scene's `loop` if absent. */
  loop?: boolean;
}

export interface Arrangement {
  clips: ArrangementClip[];
}

export type AutomationParamKind = "trackGain" | "trackPan" | "fxParam" | "instParam";

export interface AutomationTarget {
  kind: AutomationParamKind;
  trackId: ID;
  fxId?: ID;
  paramId?: string;
}

export interface AutomationPoint {
  tick: number;
  value: number;
}

export interface AutomationLane {
  id: ID;
  target: AutomationTarget;
  points: AutomationPoint[];
}

export type LfoWave = "sine" | "triangle" | "square" | "sawUp" | "sawDown";

export interface Lfo {
  id: ID;
  trackId: ID;
  param: "gain" | "pan";
  wave: LfoWave;
  rateMode: "hz" | "sync";
  rateHz: number;
  division: number;
  amount: number;
}

export interface MacroMapping {
  id: ID;
  trackId: ID;
  param: "gain" | "pan";
  amount: number;
  /** Modulation source. Default "macro" for backwards compatibility. */
  source?: "macro" | "intensity";
}

export interface Macro {
  id: ID;
  name: string;
  value: number;
  mappings: MacroMapping[];
}

/** All 24 major + minor keys (display strings). */
const SCALE_LABELS = ["Major", "Natural Minor", "Harmonic Minor", "Melodic Minor", "Dorian", "Phrygian", "Mixolydian", "Pentatonic Major", "Pentatonic Minor"] as const;
const ROOT_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** All 108 combinations: 12 root notes × 9 scale types. */
export type MusicalKey =
  | "C Major" | "C Natural Minor" | "C Harmonic Minor" | "C Melodic Minor" | "C Dorian" | "C Phrygian" | "C Mixolydian" | "C Pentatonic Major" | "C Pentatonic Minor"
  | "C# Major" | "C# Natural Minor" | "C# Harmonic Minor" | "C# Melodic Minor" | "C# Dorian" | "C# Phrygian" | "C# Mixolydian" | "C# Pentatonic Major" | "C# Pentatonic Minor"
  | "D Major" | "D Natural Minor" | "D Harmonic Minor" | "D Melodic Minor" | "D Dorian" | "D Phrygian" | "D Mixolydian" | "D Pentatonic Major" | "D Pentatonic Minor"
  | "D# Major" | "D# Natural Minor" | "D# Harmonic Minor" | "D# Melodic Minor" | "D# Dorian" | "D# Phrygian" | "D# Mixolydian" | "D# Pentatonic Major" | "D# Pentatonic Minor"
  | "E Major" | "E Natural Minor" | "E Harmonic Minor" | "E Melodic Minor" | "E Dorian" | "E Phrygian" | "E Mixolydian" | "E Pentatonic Major" | "E Pentatonic Minor"
  | "F Major" | "F Natural Minor" | "F Harmonic Minor" | "F Melodic Minor" | "F Dorian" | "F Phrygian" | "F Mixolydian" | "F Pentatonic Major" | "F Pentatonic Minor"
  | "F# Major" | "F# Natural Minor" | "F# Harmonic Minor" | "F# Melodic Minor" | "F# Dorian" | "F# Phrygian" | "F# Mixolydian" | "F# Pentatonic Major" | "F# Pentatonic Minor"
  | "G Major" | "G Natural Minor" | "G Harmonic Minor" | "G Melodic Minor" | "G Dorian" | "G Phrygian" | "G Mixolydian" | "G Pentatonic Major" | "G Pentatonic Minor"
  | "G# Major" | "G# Natural Minor" | "G# Harmonic Minor" | "G# Melodic Minor" | "G# Dorian" | "G# Phrygian" | "G# Mixolydian" | "G# Pentatonic Major" | "G# Pentatonic Minor"
  | "A Major" | "A Natural Minor" | "A Harmonic Minor" | "A Melodic Minor" | "A Dorian" | "A Phrygian" | "A Mixolydian" | "A Pentatonic Major" | "A Pentatonic Minor"
  | "A# Major" | "A# Natural Minor" | "A# Harmonic Minor" | "A# Melodic Minor" | "A# Dorian" | "A# Phrygian" | "A# Mixolydian" | "A# Pentatonic Major" | "A# Pentatonic Minor"
  | "B Major" | "B Natural Minor" | "B Harmonic Minor" | "B Melodic Minor" | "B Dorian" | "B Phrygian" | "B Mixolydian" | "B Pentatonic Major" | "B Pentatonic Minor";

export const MUSICAL_KEYS: MusicalKey[] = (() => {
  const keys: MusicalKey[] = [];
  for (const root of ROOT_NAMES) {
    for (const scale of SCALE_LABELS) {
      keys.push(`${root} ${scale}` as MusicalKey);
    }
  }
  return keys;
})();

export function isMusicalKey(value: unknown): value is MusicalKey {
  return typeof value === "string" && (MUSICAL_KEYS as string[]).includes(value);
}

export interface ProjectDocument {
  schemaVersion: number;
  id: ID;
  name: string;
  bpm: number;
  timeSignature: TimeSignature;
  /** Optional musical key (display + scorepack). */
  key?: MusicalKey;
  /** Optional project-level tags (display + scorepack). */
  tags?: string[];
  tracks: Track[];
  patterns: Pattern[];
  activePatternId: ID;
  scenes: Scene[];
  arrangement: Arrangement;
  /** Persistent timeline markers (drop / buildup / etc.). */
  markers: Marker[];
  /** Per-scene automation curves (ticks relative to scene start). */
  sceneAutomation: SceneAutomation[];
  automation: AutomationLane[];
  lfos: Lfo[];
  macros: Macro[];
  returns: ReturnTrack[];
  master: MasterConfig;
  /** Global groove (swing + humanize). Optional; absent = straight and dry. */
  groove?: Partial<GrooveSettings>;
  createdAt: string;
  updatedAt: string;
}

export function grooveOf(doc: ProjectDocument): GrooveSettings {
  return {
    swing: doc.groove?.swing ?? 0,
    humanizeTiming: doc.groove?.humanizeTiming ?? 0,
    humanizeVelocity: doc.groove?.humanizeVelocity ?? 0,
  };
}

export function getActivePattern(doc: ProjectDocument): Pattern {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!pattern) throw new Error(`Active pattern ${doc.activePatternId} not found`);
  return pattern;
}

export function getDrumTrack(doc: ProjectDocument): DrumTrack {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum");
  if (!track) throw new Error("No drum track in project");
  return track;
}

export function midiToFreq(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

export function pitchName(pitch: number): string {
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}
