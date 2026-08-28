export const PPQ = 480;
export const STEPS_PER_PATTERN = 16;
export const STEP_TICKS = PPQ / 4;        // 120 ticks = 1/16 note
export const BAR_TICKS = PPQ * 4;
export const PATTERN_TICKS = BAR_TICKS;

/** Quantize grid resolutions (ticks per grid division). */
export const GRID_8TH = 2 * STEP_TICKS;   // 240 ticks = 1/8 note
export const GRID_16TH = STEP_TICKS;      // 120 ticks = 1/16 note (default)
export const GRID_32ND = STEP_TICKS / 2;  // 60 ticks = 1/32 note

export type ID = string;

export type EffectType =
  | "eq"
  | "compressor"
  | "saturation"
  | "tapeSat"
  | "clipper"
  | "limiter"
  | "stepGate"
  | "svFilter"
  | "flanger"
  | "tremolo"
  | "autowah"
  | "stutter"
  | "msEq"
  | "haasWidener"
  | "multiband"
  | "reverb"
  | "delay"
  | "pump"
  | "distortion"
  | "bitcrusher"
  | "chorus"
  | "phaser"
  | "sidechain"
  | "transient"
  | "drumBuss"
  | "bassBuss"
  | "utility"
  | "gate";

export type InstrumentKind = "sampler" | "analog" | "bass" | "808" | "texture" | "wavetable" | "granular";

export interface EffectInstance {
  id: ID;
  type: EffectType;
  bypassed: boolean;
  params: Record<string, number>;
  /**
   * Step pattern for step-sequenced effects (stepGate): 8/16/32 values in
   * 0..1 (gate open amount). Sanitized by normalizeEffects.
   */
  steps?: number[];
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
  /**
   * Slice region into the asset (seconds) — chop-beats support. The source
   * buffer is played natively from sliceStart to sliceEnd, so slicing costs
   * no extra memory and survives reloads as plain numbers in the doc.
   */
  sliceStart?: number;
  sliceEnd?: number;
  /** Output-time fade in for a sliced pad, in seconds. */
  sliceFadeIn?: number;
  /** Output-time fade out for a sliced pad, in seconds. */
  sliceFadeOut?: number;
  /** Play the slice backwards without changing its pitch offset. */
  sliceReverse?: boolean;
}

export interface FrozenState {
  /** Bank ID where the frozen AudioBuffer is stored (e.g. "frozen-{trackId}") */
  bufferId: string;
  durationSec: number;
  sampleRate: number;
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
  /** Optional group membership — track routes through a GroupTrack instead of master. */
  groupId?: ID;
  /** When set, the track is frozen — rendered to an AudioBuffer, saving CPU. */
  frozen?: FrozenState;
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
  /** MIDI output routing for this track. */
  midiOutput?: { enabled: boolean; channel: number; deviceId?: string };
  /** Optional group membership — track routes through a GroupTrack instead of master. */
  groupId?: ID;
  /** When set, the track is frozen — rendered to an AudioBuffer, saving CPU. */
  frozen?: FrozenState;
}

export interface GroupTrack {
  id: ID;
  kind: "group";
  name: string;
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  effects: EffectInstance[];
  sends: Record<ID, number>;
  /** When set, the track is frozen — rendered to an AudioBuffer, saving CPU. */
  frozen?: FrozenState;
}

export type Track = DrumTrack | InstrumentTrack | GroupTrack;

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

export interface PatternPhraseBar {
  bar: number;
  startStep: number;
  endStep: number;
  section: "main" | "variation" | "drop" | "fill" | "outro";
}

export interface PatternAssist {
  engineId: string;
  engineVersion: string;
  operation: "vary" | "build" | "replace" | "fill";
  seed: string;
  sourceContentHash: string;
  outputContentHash: string;
  amount?: number;
  bars?: number;
  target?: string;
  style?: string;
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

/** Reproducibility recipe attached to content produced by the local Intent Engine. */
export interface PatternGeneration {
  engineId: string;
  engineVersion: string;
  seed: string;
  genre: string;
  style: string | null;
  grooveId: string;
  stepCount: number;
  ghostWeight: number;
  microWeight: number;
  velocityVariation: number;
  temperature: number;
  sourcePatternId: ID | null;
  /** UUID-free hash of the source pattern used for variation, if any. */
  inputContentHash?: string | null;
  /** UUID-free hash of the generated musical content. */
  outputContentHash?: string;
  /** Canonical hash of the normalized IntentSpec used to produce this pattern. */
  intentHash?: string;
  /** JSON-safe normalized IntentSpec snapshot for provenance and reloads. */
  intent?: Record<string, unknown>;
  /** Deterministic quality diagnostics captured alongside the recipe. */
  quality?: {
    styleDistance: number;
    styleAccepted: boolean;
    syncopation: number;
    anchorCoverage: number;
    melodicMotifRepetition: number;
    melodicRestRatio: number;
    melodicDurationLongRatio: number;
  };
}

export interface Pattern {
  id: ID;
  name: string;
  stepCount: number;
  rows: Record<ID, number[]>;
  notes: Record<ID, NoteEvent[]>;
  /** padId → stepIndex → performance metadata. Optional (schema v1 addendum). */
  stepMeta?: Record<ID, Record<number, StepMeta>>;
  /** Explicit multi-bar phrase sections used by Assist BUILD/FILL. */
  phrasePlan?: PatternPhraseBar[];
  /** Provenance for surgical Assist transformations. */
  assist?: PatternAssist;
  /** Deterministic generation recipe and content hashes, when AI-generated. */
  generation?: PatternGeneration;
}

/** Project-level groove: 0..1 swing delays off-grid 16ths toward a triplet feel. */
export interface GrooveSettings {
  swing: number;
  humanizeTiming: number;
  humanizeVelocity: number;
}

export type PlayMode = "pattern" | "song";

export type SceneRole = "intro" | "build" | "drop" | "break" | "outro" | "fill" | "custom";

export type ArrangementTransitionType = "fill" | "riser" | "impact" | "drop" | "break" | "custom";

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
  /** Optional arrangement role. Older scenes infer this from their name. */
  role?: SceneRole;
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

export interface ArrangementTransition {
  id: ID;
  fromClipId: ID;
  toClipId: ID;
  type: ArrangementTransitionType;
  /** Quantized transition length in bars, clamped to 1..4. */
  lengthBars: number;
  /** Optional factory/user cue asset id; metadata only in v1. */
  cueAssetId?: string;
}

export interface Arrangement {
  clips: ArrangementClip[];
  transitions?: ArrangementTransition[];
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

/** Modulator family. Missing kind on persisted docs reads as "osc". */
export type LfoKind = "osc" | "random" | "step" | "envFollower";

/**
 * Unified track modulator (flattened optional-field shape mirroring the loose
 * MacroMapping style — keeps legacy serialized projects valid without any
 * migration and lets `setLfoParams` patches stay partial):
 *
 * - `kind: "osc"` (default)     — audio-rate oscillator, native targets only
 *                                 (`param`: gain|pan)
 * - `kind: "random"`            — seeded S&H / glide stream, full
 *                                 `AutomationTarget` support via `target`
 * - `kind: "step"`              — bar-aligned editable step sequence, full
 *                                 `AutomationTarget` support via `target`
 * - `kind: "envFollower"`       — audio-envelope detector driving native
 *                                 targets (v1 scope: Volume/Pan)
 *
 * `amount` is a uniform depth scalar 0..1 across every kind.
 */
export interface Lfo {
  id: ID;
  trackId: ID;
  kind?: LfoKind;
  /**
   * Native-parameter selector used by "osc" and "envFollower" (the only kinds
   * whose output feeds real AudioParams). Kept non-optional for backwards
   * compatibility with previously serialized documents.
   */
  param: "gain" | "pan";
  /**
   * Generic target for schedulable kinds ("random" / "step"). When present it
   * fully overrides `param`; when absent the native param selector applies.
   */
  target?: AutomationTarget;
  /** Depth 0..1 — shared semantics across all kinds. */
  amount: number;
  // ---- osc ----
  wave?: LfoWave;
  rateMode?: "hz" | "sync";
  rateHz?: number;
  division?: number;
  // ---- random ----
  snh?: "hold" | "glide";
  seed?: string;
  // ---- step ----
  steps?: number[];
  glideSec?: number;
  // ---- envFollower ----
  sourceTrackId?: ID;
  attackMs?: number;
  releaseMs?: number;
  sensitivity?: number;
  /** +1 = swell with the envelope, −1 (default) = duck against it. */
  polarity?: number;
}

export interface MacroMapping {
  id: ID;
  trackId: ID;
  param: "gain" | "pan" | string;
  amount: number;
  /** Modulation source. Default "macro" for backwards compatibility. */
  source?: "macro" | "intensity" | "midiCC";
  /** Direct CC number mapping (when source === "midiCC"). */
  ccNumber?: number;
  /** MIDI channel filter for CC mapping (undefined = all channels). */
  channel?: number;
  /** Target range for CC → param scaling. */
  min?: number;
  max?: number;
}

export interface Macro {
  id: ID;
  name: string;
  value: number;
  mappings: MacroMapping[];
}

// ---------------------------------------------------------------------------
// MIDI
// ---------------------------------------------------------------------------

export interface MidiCcMapping {
  id: ID;
  ccNumber: number;
  channel?: number;
  target: AutomationTarget;
  min: number;
  max: number;
}

export interface DrumNoteMapping {
  midiNote: number;
  padId: ID;
}

export interface MidiConfig {
  enabled: boolean;
  deviceId: string;
  drumChannel: number;
  instrumentChannel: number;
  ccMappings: MidiCcMapping[];
  drumNoteMap: DrumNoteMapping[];
  pitchBendRange: number;
  /** Program Change mapping: MIDI program number → preset id. */
  programMap?: { program: number; presetId: string }[];
  /** Bank select: MSB (CC0) and LSB (CC32) → bank number. */
  bankSelect?: boolean;
  /** Aftertouch routing target. */
  aftertouchTarget?: AutomationTarget;
  /** Aftertouch modulation depth (0..1). */
  aftertouchRange?: number;
  /** MIDI clock mode. */
  clockMode?: "off" | "master" | "slave";
}

/** Standard GM percussion note numbers (subset). */
export const GM_DRUM_MAP: ReadonlyArray<{ note: number; name: string }> = [
  { note: 35, name: "Acoustic Bass Drum" },
  { note: 36, name: "Bass Drum 1" },
  { note: 37, name: "Side Stick" },
  { note: 38, name: "Acoustic Snare" },
  { note: 39, name: "Hand Clap" },
  { note: 40, name: "Electric Snare" },
  { note: 42, name: "Closed Hi-Hat" },
  { note: 44, name: "Pedal Hi-Hat" },
  { note: 46, name: "Open Hi-Hat" },
  { note: 49, name: "Crash Cymbal 1" },
  { note: 51, name: "Ride Cymbal 1" },
  { note: 54, name: "Tambourine" },
  { note: 56, name: "Cowbell" },
  { note: 63, name: "Open Hi Conga" },
  { note: 64, name: "Low Conga" },
  { note: 70, name: "Maracas" },
  { note: 76, name: "Hi Timbale" },
  { note: 77, name: "Low Timbale" },
];

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
  /** MIDI input configuration. Optional for backwards compatibility. */
  midi?: MidiConfig;
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

/**
 * INVARIANT: `doc.activePatternId` must always resolve to an entry in
 * `doc.patterns`. Violations throw here and crash the scheduler loop +
 * sequencer render. The invariant is maintained by:
 *   - `normalizeActivePatternDomain` (schema.ts)
 *   - `deletePattern` scene + clip cleanup (commands.ts)
 *   - `setActivePattern` validation (commands.ts)
 *   - `YDocStore.readDoc` normalization on remote reads (YDocStore.ts)
 *
 * Any new code that can produce a dangling `activePatternId` (new commands,
 * imports, collab adapters) MUST be covered by one of those guards or by
 * routing the doc through `normalizeProject` before it reaches the engine.
 * See `tests/project-invariants.test.ts` — that file is the pin for this
 * invariant. If you add a feature that touches patterns/scenes, add a case
 * there as well.
 */
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
