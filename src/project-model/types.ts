export const PPQ = 480;
export const STEPS_PER_PATTERN = 16;
export const STEP_TICKS = PPQ / 4;
export const BAR_TICKS = PPQ * 4;
export const PATTERN_TICKS = BAR_TICKS;

export type ID = string;

export type EffectType = "eq" | "compressor" | "saturation" | "clipper" | "reverb" | "delay" | "pump";

export type InstrumentKind = "sampler" | "analog" | "bass" | "808";

export interface EffectInstance {
  id: ID;
  type: EffectType;
  bypassed: boolean;
  params: Record<string, number>;
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
  effects: EffectInstance[];
}

export type Track = DrumTrack | InstrumentTrack;

export interface NoteEvent {
  id: ID;
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

export interface Pattern {
  id: ID;
  name: string;
  stepCount: number;
  rows: Record<ID, number[]>;
  notes: Record<ID, NoteEvent[]>;
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
  createdAt: string;
  updatedAt: string;
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
