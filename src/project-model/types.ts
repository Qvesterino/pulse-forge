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
}

export interface ArrangementClip {
  id: ID;
  sceneId: ID;
  startBar: number;
  lengthBars: number;
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
}

export interface Macro {
  id: ID;
  name: string;
  value: number;
  mappings: MacroMapping[];
}

export interface ProjectDocument {
  schemaVersion: number;
  id: ID;
  name: string;
  bpm: number;
  timeSignature: TimeSignature;
  tracks: Track[];
  patterns: Pattern[];
  activePatternId: ID;
  scenes: Scene[];
  arrangement: Arrangement;
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
