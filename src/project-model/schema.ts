import type {
  DrumPad,
  DrumTrack,
  EffectInstance,
  InstrumentKind,
  InstrumentTrack,
  IntensityPoint,
  Lfo,
  Macro,
  MacroMapping,
  Marker,
  MasterConfig,
  Pattern,
  ProjectDocument,
  ReturnTrack,
  Scene,
  SceneRole,
  ArrangementTransition,
  ArrangementTransitionType,
  SceneAutomation,
  StepMeta,
  AutomationTarget,
} from "./types";
import { BAR_TICKS, PPQ, STEP_TICKS, STEPS_PER_PATTERN, isMusicalKey } from "./types";
import { sanitizeGateSteps, sanitizeLfo } from "./modulators";
import { uid } from "../shared/ids";
import { defaultInstrumentParams } from "../instruments/registry";
import { createProjectFromTemplate } from "./templates";
import { EFFECT_DEFS, clampEffectParam, defaultParamsOf } from "../effects/registry";

export const SCHEMA_VERSION = 1;
/** Minimum BPM accepted by the transport. Matches the `setBpm` command clamp. */
export const MIN_BPM = 20;
/** Maximum BPM accepted by the transport. Matches the `setBpm` command clamp. */
export const MAX_BPM = 300;
/** BPM used when an invalid (NaN/non-finite) value reaches the normalizer. */
export const FALLBACK_BPM = 120;
/** stepCount used when a pattern's stepCount is invalid (0/negative/NaN). */
export const FALLBACK_STEP_COUNT = STEPS_PER_PATTERN;

function makePad(index: number, name: string, assetId: string, idPrefix: string, opts: Partial<DrumPad> = {}): DrumPad {
  return {
    id: `${idPrefix}pad-${String(index + 1).padStart(2, "0")}`,
    name,
    assetId,
    gain: 1,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    chokeGroup: null,
    ...opts,
  };
}

export function makeKit(idPrefix = ""): DrumPad[] {
  return [
    makePad(0, "Kick Deep", "factory.kick.deep", idPrefix, { chokeGroup: 1 }),
    makePad(1, "Kick Punch", "factory.kick.punch", idPrefix, { chokeGroup: 1 }),
    makePad(2, "Kick Techno", "factory.kick.techno", idPrefix, { chokeGroup: 1 }),
    makePad(3, "Rim", "factory.rim.chip", idPrefix),
    makePad(4, "Snare", "factory.snare.main", idPrefix),
    makePad(5, "Snare Tight", "factory.snare.tight", idPrefix),
    makePad(6, "Clap", "factory.clap.main", idPrefix),
    makePad(7, "Shaker", "factory.shaker.soft", idPrefix),
    makePad(8, "Hat Closed", "factory.hat.closed", idPrefix, { chokeGroup: 2 }),
    makePad(9, "Hat Soft", "factory.hat.closed.soft", idPrefix, { chokeGroup: 2, gain: 0.6 }),
    makePad(10, "Hat Open", "factory.hat.open", idPrefix, { chokeGroup: 2 }),
    makePad(11, "Ride", "factory.ride.ping", idPrefix),
    makePad(12, "Tom Low", "factory.tom.low", idPrefix),
    makePad(13, "Tom High", "factory.tom.high", idPrefix),
    makePad(14, "Tick", "factory.perc.tick", idPrefix, { gain: 0.7 }),
    makePad(15, "Blip", "factory.perc.blip", idPrefix),
  ];
}

export function createDrumTrackModel(name: string): DrumTrack {
  const id = uid("track");
  return {
    id,
    kind: "drum",
    name,
    gain: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    pads: makeKit(`${id}-`),
    effects: [],
    sends: {},
  };
}

export function createGroupTrackModel(name: string): import("../project-model/types").GroupTrack {
  return {
    id: uid("group"),
    kind: "group",
    name,
    gain: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
    sends: {},
  };
}

const INSTRUMENT_NAMES: Record<InstrumentKind, string> = {
  sampler: "Sampler",
  analog: "Analog",
  bass: "Bass",
  "808": "808",
  texture: "Texture",
  wavetable: "Wavetable",
  granular: "Granular",
  keys: "Keys",
  pluck: "Pluck",
};

export function createInstrumentTrackModel(kind: InstrumentKind, index: number): InstrumentTrack {
  return {
    id: uid("track"),
    kind: "instrument",
    instrument: kind,
    name: `${INSTRUMENT_NAMES[kind]}${index > 1 ? ` ${index}` : ""}`,
    gain: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    sampleId: kind === "sampler" ? "factory.tonal.pluck" : kind === "granular" ? "factory.tonal.keys" : null,
    params: defaultInstrumentParams(kind),
    effects: [],
    sends: {},
  };
}

export function createDefaultReturns(): ReturnTrack[] {
  const reverbFx: EffectInstance = {
    id: uid("fx"),
    type: "reverb",
    bypassed: false,
    params: { decay: 2.2, predelay: 20, tone: 6000, mix: 1 },
  };
  const delayFx: EffectInstance = {
    id: uid("fx"),
    type: "delay",
    bypassed: false,
    params: { time: 375, feedback: 0.4, tone: 4000, mix: 1 },
  };
  return [
    { id: uid("return"), kind: "return", name: "Reverb", gain: 0.9, effects: [reverbFx] },
    { id: uid("return"), kind: "return", name: "Delay", gain: 0.85, effects: [delayFx] },
  ];
}

export function defaultMasterConfig(): MasterConfig {
  return { masterGain: 1, ceilingDb: -1, limiterEnabled: true, clipperEnabled: false };
}

/** Clamp a dB value to the master ceiling range (-12..0 dBFS). */
export function clampCeilingDb(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return -1;
  return Math.min(0, Math.max(-12, value));
}

/** Clamp a master gain to 0..2 (≈ -∞..+6 dB). */
export function clampMasterGain(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0, value));
}

export function drumTracksOf(doc: ProjectDocument): DrumTrack[] {
  return doc.tracks.filter((t): t is DrumTrack => t.kind === "drum");
}

export function instrumentTracksOf(doc: ProjectDocument): InstrumentTrack[] {
  return doc.tracks.filter((t): t is InstrumentTrack => t.kind === "instrument");
}

export function allPadIds(doc: ProjectDocument): string[] {
  return drumTracksOf(doc).flatMap((t) => t.pads.map((p) => p.id));
}

function emptyRows(padIds: string[], stepCount: number): Record<string, number[]> {
  const rows: Record<string, number[]> = {};
  for (const padId of padIds) rows[padId] = new Array<number>(stepCount).fill(0);
  return rows;
}

export function createPatternForDoc(doc: ProjectDocument, name: string, stepCount = STEPS_PER_PATTERN): Pattern {
  return {
    id: uid("pattern"),
    name,
    stepCount,
    rows: emptyRows(allPadIds(doc), stepCount),
    notes: {},
  };
}

export function patternLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}

/**
 * The default project is the House template — a starter groove that already
 * sounds musical on first play.
 */
export function createDefaultProject(): ProjectDocument {
  return createProjectFromTemplate("house");
}

export function defaultMacros(): Macro[] {
  return [
    { id: uid("macro"), name: "DRUMS", value: 0.5, mappings: [] },
    { id: uid("macro"), name: "BASS", value: 0.5, mappings: [] },
    { id: uid("macro"), name: "MUSIC", value: 0.5, mappings: [] },
    { id: uid("macro"), name: "WIDTH", value: 0.5, mappings: [] },
  ];
}

/** Clamp intensity to 0..1. NaN/non-finite → 0.7 (the "normal" preset). */
export function clampIntensity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.7;
  return Math.min(1, Math.max(0, value));
}

/** Validate a Marker.type field. Falls back to "cue" for unknown values. */
const MARKER_TYPES: ReadonlyArray<Marker["type"]> = ["drop", "buildup", "riser", "impact", "cue", "custom"];
export function clampMarkerType(value: unknown): Marker["type"] {
  return (MARKER_TYPES as string[]).includes(value as string) ? (value as Marker["type"]) : "cue";
}

/** Filter + clamp marker points (drop empty, dedupe by id, sort by tick). */
export function sanitizeMarkers(input: unknown, projectTicks: number): Marker[] {
  if (!Array.isArray(input)) return [];
  const out: Marker[] = [];
  for (const raw of input) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id : uid("marker");
    const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : "Marker";
    const type = clampMarkerType(raw.type);
    const tick = Math.max(0, Math.min(projectTicks, Math.floor(Number(raw.tick) || 0)));
    const linkedClipId = typeof raw.linkedClipId === "string" ? raw.linkedClipId : undefined;
    const customId = typeof raw.customId === "string" ? raw.customId : undefined;
    out.push({ id, name, type, tick, linkedClipId, customId });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

/** Validate a single intensity curve point (offset ≥ 0, value ∈ 0..1). */
function sanitizeIntensityPoint(raw: unknown): IntensityPoint | null {
  if (!isObject(raw)) return null;
  const offset = Math.max(0, Math.floor(Number(raw.offset) || 0));
  const value = clampIntensity(raw.value);
  return { offset, value };
}

/** Filter scene automation: drop lanes with no scene or no points. */
export function sanitizeSceneAutomation(input: unknown, sceneIds: Set<string>): SceneAutomation[] {
  if (!Array.isArray(input)) return [];
  const out: SceneAutomation[] = [];
  for (const raw of input) {
    if (!isObject(raw)) continue;
    if (typeof raw.sceneId !== "string" || !sceneIds.has(raw.sceneId)) continue;
    if (!isObject(raw.target)) continue;
    if (!Array.isArray(raw.points)) continue;
    const id = typeof raw.id === "string" ? raw.id : uid("sceneAuto");
    const points = raw.points
      .map((p: unknown) => {
        if (!isObject(p)) return null;
        const tick = Math.max(0, Math.floor(Number(p.tick) || 0));
        const value = Number(p.value);
        if (!Number.isFinite(value)) return null;
        return { tick, value };
      })
      .filter((p: unknown): p is { tick: number; value: number } => p !== null)
      .sort((a: { tick: number }, b: { tick: number }) => a.tick - b.tick);
    if (points.length === 0) continue;
    out.push({
      id,
      sceneId: raw.sceneId,
      target: raw.target as unknown as SceneAutomation["target"],
      points,
    });
  }
  return out;
}

/** Clamp a single MacroMapping's parameters (forward-compat: unknown source → "macro"). */
function sanitizeMacroMapping(raw: unknown): MacroMapping | null {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : uid("map");
  const trackId = typeof raw.trackId === "string" ? raw.trackId : null;
  if (!trackId) return null;
  const param = raw.param === "pan" ? "pan" : typeof raw.param === "string" && raw.param !== "" ? raw.param : "gain";
  const amount = Math.max(-1, Math.min(1, Number(raw.amount) || 0));
  const source = raw.source === "intensity" ? "intensity" : raw.source === "midiCC" ? "midiCC" : "macro";
  const mapping: MacroMapping = { id, trackId, param, amount, source };
  // Generic target for intensity→FX/inst (P2 bus). When present it overrides trackId/param.
  if (isObject((raw as Record<string, unknown>).target)) {
    const t = (raw as Record<string, unknown>).target as Record<string, unknown>;
    const kind = t.kind as string;
    if (
      (kind === "trackGain" || kind === "trackPan" || kind === "fxParam" || kind === "instParam") &&
      typeof t.trackId === "string" &&
      t.trackId !== ""
    ) {
      const target: AutomationTarget = { kind: kind as AutomationTarget["kind"], trackId: t.trackId };
      if (kind === "fxParam") {
        if (typeof t.fxId !== "string" || typeof t.paramId !== "string" || t.fxId === "" || t.paramId === "") {
          // invalid fx target — drop target and keep legacy param
        } else {
          target.fxId = t.fxId;
          target.paramId = t.paramId;
          mapping.target = target;
        }
      } else if (kind === "instParam") {
        if (typeof t.paramId !== "string" || t.paramId === "") {
          // invalid
        } else {
          target.paramId = t.paramId;
          mapping.target = target;
        }
      } else {
        mapping.target = target;
      }
    }
  }
  if (source === "midiCC") {
    // Preserve the CC routing fields — rewriting the source (or dropping
    // ccNumber/channel) silently broke every MIDI CC macro mapping on
    // load/import.
    if (typeof raw.ccNumber !== "number" || !Number.isFinite(raw.ccNumber) || raw.ccNumber < 0 || raw.ccNumber > 127) {
      return null; // a midiCC mapping without a valid CC number is unusable
    }
    mapping.ccNumber = Math.floor(raw.ccNumber);
    if (typeof raw.channel === "number" && Number.isFinite(raw.channel) && raw.channel >= 1 && raw.channel <= 16) {
      mapping.channel = Math.floor(raw.channel);
    }
    if (typeof raw.min === "number" && Number.isFinite(raw.min)) mapping.min = raw.min;
    if (typeof raw.max === "number" && Number.isFinite(raw.max)) mapping.max = raw.max;
  }
  return mapping;
}

/** Clamp a BPM value to the supported range. NaN/non-finite → FALLBACK_BPM. */
export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return FALLBACK_BPM;
  if (bpm < MIN_BPM) return MIN_BPM;
  if (bpm > MAX_BPM) return MAX_BPM;
  return bpm;
}

/** Clamp a 0..1 unit value. NaN/non-finite → 0. */
export function clampUnit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Validate a stepCount. Returns a safe positive integer or the fallback. */
export function normalizeStepCount(stepCount: number): number {
  if (!Number.isFinite(stepCount) || stepCount <= 0 || !Number.isInteger(stepCount)) {
    return FALLBACK_STEP_COUNT;
  }
  return stepCount;
}

function defaultSceneFor(doc: ProjectDocument): Scene {
  return { id: uid("scene"), name: "Scene A", patternId: doc.activePatternId, intensity: 0.7 };
}

const SCENE_ROLES: ReadonlyArray<SceneRole> = ["intro", "build", "drop", "break", "outro", "fill", "custom"];
const ARRANGEMENT_TRANSITION_TYPES: ReadonlyArray<ArrangementTransitionType> = [
  "fill",
  "riser",
  "impact",
  "drop",
  "break",
  "custom",
];

export function clampSceneRole(value: unknown): SceneRole | undefined {
  return SCENE_ROLES.includes(value as SceneRole) ? (value as SceneRole) : undefined;
}

/** Infer a role for older scene documents without persisting a migration. */
export function inferSceneRole(name: unknown): SceneRole | undefined {
  if (typeof name !== "string") return undefined;
  const normalized = name.trim().toLowerCase();
  if (/^(intro|opening)\b/.test(normalized)) return "intro";
  if (/^(build|buildup|lift)\b/.test(normalized)) return "build";
  if (/^(drop|chorus|main)\b/.test(normalized)) return "drop";
  if (/^(break|breakdown)\b/.test(normalized)) return "break";
  if (/^(outro|ending|end)\b/.test(normalized)) return "outro";
  if (/^(fill|transition)\b/.test(normalized)) return "fill";
  return undefined;
}

export function sceneRoleOf(scene: Pick<Scene, "name" | "role">): SceneRole | undefined {
  return clampSceneRole(scene.role) ?? inferSceneRole(scene.name);
}

export function clampArrangementTransitionType(value: unknown): ArrangementTransitionType {
  return ARRANGEMENT_TRANSITION_TYPES.includes(value as ArrangementTransitionType)
    ? (value as ArrangementTransitionType)
    : "custom";
}

export function sanitizeAudioClips(input: unknown, trackIds: Set<string>): import("./types").AudioClip[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: import("./types").AudioClip[] = [];
  const seen = new Set<string>();
  for (const raw of input as Record<string, unknown>[]) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : uid("audioClip");
    if (seen.has(id)) continue;
    const trackId = typeof raw.trackId === "string" ? raw.trackId : "";
    if (!trackIds.has(trackId)) continue;
    const bufferId = typeof raw.bufferId === "string" && raw.bufferId !== "" ? raw.bufferId : null;
    if (!bufferId) continue;
    const startBar = Number(raw.startBar);
    if (!Number.isFinite(startBar) || startBar < 0) continue;
    const lengthBars = Number(raw.lengthBars);
    if (!Number.isFinite(lengthBars) || lengthBars < 0.25) continue;
    const offsetSec = Math.max(0, Number.isFinite(Number(raw.offsetSec)) ? Number(raw.offsetSec) : 0);
    const trimStart = Math.max(0, Number.isFinite(Number(raw.trimStart)) ? Number(raw.trimStart) : 0);
    const trimEnd = Math.max(0, Number.isFinite(Number(raw.trimEnd)) ? Number(raw.trimEnd) : 0);
    const gain = Math.min(2, Math.max(0, Number.isFinite(Number(raw.gain)) ? Number(raw.gain) : 1));
    const fadeIn = Math.max(0, Number.isFinite(Number(raw.fadeIn)) ? Number(raw.fadeIn) : 0);
    const fadeOut = Math.max(0, Number.isFinite(Number(raw.fadeOut)) ? Number(raw.fadeOut) : 0);
    let stretchRate = Number.isFinite(Number(raw.stretchRate)) ? Number(raw.stretchRate) : 1;
    stretchRate = Math.min(4, Math.max(0.25, stretchRate));
    const reverse = raw.reverse === true;
    seen.add(id);
    out.push({
      id,
      trackId,
      bufferId,
      startBar,
      lengthBars,
      offsetSec,
      trimStart,
      trimEnd,
      gain,
      fadeIn,
      fadeOut,
      stretchRate,
      reverse,
    });
  }
  out.sort((a, b) => a.startBar - b.startBar);
  return out.length > 0 ? out : undefined;
}

export function sanitizeArrangementTransitions(
  input: unknown,
  clips: readonly { id: string; startBar: number; lengthBars: number }[],
): ArrangementTransition[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const clipById = new Map(clips.map((clip) => [clip.id, clip]));
  const seen = new Set<string>();
  const out: ArrangementTransition[] = [];
  for (const raw of input) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id : uid("transition");
    const fromClipId = typeof raw.fromClipId === "string" ? raw.fromClipId : "";
    const toClipId = typeof raw.toClipId === "string" ? raw.toClipId : "";
    if (!fromClipId || !toClipId || fromClipId === toClipId || seen.has(id)) continue;
    const from = clipById.get(fromClipId);
    const to = clipById.get(toClipId);
    if (!from || !to) continue;
    // A transition is a boundary annotation, so both clips must be ordered.
    if (from.startBar >= to.startBar || from.startBar + from.lengthBars > to.startBar) continue;
    const cueAssetId = typeof raw.cueAssetId === "string" && raw.cueAssetId.trim() !== "" ? raw.cueAssetId : undefined;
    seen.add(id);
    out.push({
      id,
      fromClipId,
      toClipId,
      type: clampArrangementTransitionType(raw.type),
      lengthBars: Math.min(4, Math.max(1, Math.round(Number(raw.lengthBars) || 1))),
      cueAssetId,
    });
  }
  return out;
}

function normalizeEffects(raw: unknown, trackId: string, trackIds: Set<string>): EffectInstance[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is EffectInstance => {
      const fx = item as Partial<EffectInstance>;
      return (
        typeof fx?.id === "string" &&
        typeof fx?.type === "string" &&
        Boolean(EFFECT_DEFS[fx.type as keyof typeof EFFECT_DEFS])
      );
    })
    .map((item) => {
      const type = item.type;
      const defaults = defaultParamsOf(type);
      const source = item.params && typeof item.params === "object" ? item.params : {};
      const params: Record<string, number> = { ...defaults };
      for (const id of Object.keys(defaults)) {
        const value = (source as Record<string, unknown>)[id];
        if (typeof value === "number" && Number.isFinite(value)) params[id] = clampEffectParam(type, id, value);
      }
      // EQ compatibility: old three-band fields feed the new canonical bands.
      if (type === "eq") {
        const aliases: Array<[string, string]> = [
          ["lowGain", "lowShelfGain"],
          ["lowFreq", "lowShelfFreq"],
          ["midGain", "lowMidGain"],
          ["midFreq", "lowMidFreq"],
          ["midQ", "lowMidQ"],
          ["highGain", "highShelfGain"],
          ["highFreq", "highShelfFreq"],
        ];
        for (const [legacy, canonical] of aliases) {
          if (
            (source as Record<string, unknown>)[canonical] === undefined &&
            typeof (source as Record<string, unknown>)[legacy] === "number"
          ) {
            params[canonical] = clampEffectParam(type, canonical, Number((source as Record<string, unknown>)[legacy]));
          }
        }
      }
      const sidechainTrackId =
        item.sidechainTrackId && item.sidechainTrackId !== trackId && trackIds.has(item.sidechainTrackId)
          ? item.sidechainTrackId
          : undefined;
      // Step-sequenced effects (stepGate) carry an editable pattern array.
      const steps =
        type === "stepGate" || type === "stutter" ? sanitizeGateSteps((item as { steps?: unknown }).steps) : undefined;
      return {
        id: item.id,
        type,
        bypassed: item.bypassed === true,
        params,
        ...(steps ? { steps } : {}),
        ...(sidechainTrackId ? { sidechainTrackId } : {}),
      };
    });
}

/**
 * Bring a project document (possibly loaded from disk, possibly mutated by an
 * outdated client) to a state the current engine can use without errors.
 *
 * Normalization is idempotent and never throws — it always returns a valid
 * `ProjectDocument`. Callers should treat the return value as the new truth
 * and discard the input.
 */
// ─── normalizeProject — per-domain sanitizers ───────────────────────────────
//
// normalizeProject used to be a single 550-line function that grew a new
// section with every feature (markers, midi, LFO kinds, scene automation…).
// It is now a composition of per-domain sanitizers. Each sanitizer receives
// the evolving state and touches ONLY its own domain, deriving any id sets
// it needs from the current state.doc.
//
// ORDER IS LOAD-BEARING — do not reorder without checking dependencies:
//   activePatternId   ← patterns (ids)
//   scenes            ← patterns (ids), activePatternId
//   arrangement       ← scenes (ids)
//   automation / lfos ← tracks (ids)
//   markers           ← scenes + patterns + arrangement (tick budget)
//   sceneAutomation   ← scenes (ids)
//   patterns          ← tracks (padIds + trackIds) — must stay LAST
//
// Reference-stability contract: a sanitizer rewrites a domain ONLY when its
// content actually changed, so `normalizeProject(canonicalDoc) === canonicalDoc`
// (identity, not just deep equality) — templates.test.ts pins this.

interface NormalizeState {
  doc: ProjectDocument;
  changed: boolean;
}

function normalizeTimeSignatureDomain(s: NormalizeState): void {
  if (!isValidTimeSignature(s.doc.timeSignature)) {
    s.doc = { ...s.doc, timeSignature: { numerator: 4, denominator: 4 } };
    s.changed = true;
  }
}

function normalizeBpmDomain(s: NormalizeState): void {
  const clampedBpm = clampBpm(s.doc.bpm);
  if (clampedBpm !== s.doc.bpm) {
    s.doc = { ...s.doc, bpm: clampedBpm };
    s.changed = true;
  }
}

function normalizeActivePatternDomain(s: NormalizeState): void {
  const doc = s.doc;
  const patternIds = new Set(doc.patterns.map((p) => p.id));
  if (doc.patterns.length === 0 || !patternIds.has(doc.activePatternId)) {
    if (doc.patterns.length === 0) {
      // Should be impossible (createDefaultProject always seeds a pattern),
      // but synthesize a placeholder so the schema stays valid.
      const seed = createPatternForDoc(doc, "Pattern A");
      s.doc = {
        ...doc,
        patterns: [seed],
        activePatternId: seed.id,
        scenes: [],
        arrangement: { clips: [] },
      };
      s.changed = true;
    } else {
      s.doc = { ...doc, activePatternId: doc.patterns[0].id };
      s.changed = true;
    }
  }
}

function normalizeTracksDomain(s: NormalizeState): void {
  const doc = s.doc;
  const trackIds = new Set(doc.tracks.map((t) => t.id));
  let tracksChanged = false;
  const tracks = doc.tracks.map((track): DrumTrack | InstrumentTrack | import("../project-model/types").GroupTrack => {
    if (track.kind === "drum") {
      let t: DrumTrack = track;
      const pads = t.pads.map((pad) => {
        let nextPad = pad;
        let padChanged = false;
        const cleanNonNegative = (value: unknown): number | undefined =>
          typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
        const sliceStart = cleanNonNegative(pad.sliceStart);
        const sliceEnd = cleanNonNegative(pad.sliceEnd);
        const fadeIn = cleanNonNegative(pad.sliceFadeIn) ?? 0;
        const fadeOut = cleanNonNegative(pad.sliceFadeOut) ?? 0;
        const hasSliceConfig =
          pad.sliceStart !== undefined ||
          pad.sliceEnd !== undefined ||
          pad.sliceFadeIn !== undefined ||
          pad.sliceFadeOut !== undefined ||
          pad.sliceReverse !== undefined;
        const hasSynth = (pad as any).synth !== undefined;
        if (!hasSliceConfig && !hasSynth) return pad;
        if (hasSliceConfig) {
          if (sliceStart !== pad.sliceStart || sliceEnd !== pad.sliceEnd) padChanged = true;
          if (fadeIn !== (pad.sliceFadeIn ?? 0) || fadeOut !== (pad.sliceFadeOut ?? 0)) padChanged = true;
          if (pad.sliceReverse !== undefined && typeof pad.sliceReverse !== "boolean") padChanged = true;
          const invalidBound =
            (pad.sliceStart !== undefined && sliceStart === undefined) ||
            (pad.sliceEnd !== undefined && sliceEnd === undefined);
          if (invalidBound || (sliceStart !== undefined && sliceEnd !== undefined && sliceEnd <= sliceStart)) {
            nextPad = {
              ...nextPad,
              sliceFadeIn: fadeIn,
              sliceFadeOut: fadeOut,
              sliceReverse: typeof pad.sliceReverse === "boolean" ? pad.sliceReverse : false,
            };
            delete nextPad.sliceStart;
            delete nextPad.sliceEnd;
            padChanged = true;
          } else if (padChanged) {
            nextPad = {
              ...nextPad,
              sliceStart,
              sliceEnd,
              sliceFadeIn: fadeIn,
              sliceFadeOut: fadeOut,
              sliceReverse: typeof pad.sliceReverse === "boolean" ? pad.sliceReverse : false,
            };
          }
        }
        // Synth config sanitization
        const rawSynth: unknown = (pad as any).synth;
        if (rawSynth !== undefined) {
          if (rawSynth === null) {
            if (nextPad.synth !== null) {
              nextPad = { ...nextPad, synth: null } as any;
              padChanged = true;
            }
          } else if (typeof rawSynth === "object" && rawSynth !== null) {
            const obj = rawSynth as Record<string, unknown>;
            const allowed: Record<string, { min: number; max: number; def: number }> = {
              hatClosed: { min: 0.05, max: 1.5, def: 0.08 },
              hatOpen: { min: 0.05, max: 1.5, def: 0.32 },
              clap: { min: 0.05, max: 1.5, def: 0.25 },
              perc: { min: 0.05, max: 1.5, def: 0.12 },
              cowbell: { min: 0.05, max: 1.5, def: 0.3 },
              kick: { min: 0.05, max: 1.5, def: 0.42 },
              snare: { min: 0.05, max: 1.5, def: 0.22 },
            };
            const type = typeof obj.type === "string" && obj.type in allowed ? (obj.type as string) : null;
            if (!type) {
              nextPad = { ...nextPad, synth: null } as any;
              padChanged = true;
            } else {
              const decay =
                typeof obj.decay === "number" && Number.isFinite(obj.decay)
                  ? Math.min(1.5, Math.max(0.02, obj.decay))
                  : allowed[type].def;
              const tone =
                typeof obj.tone === "number" && Number.isFinite(obj.tone)
                  ? Math.min(12000, Math.max(200, obj.tone))
                  : 5000;
              const nextSynth: any = { type, decay, tone };
              if (JSON.stringify(nextSynth) !== JSON.stringify((pad as any).synth)) {
                nextPad = { ...nextPad, synth: nextSynth } as any;
                padChanged = true;
              }
            }
          } else {
            nextPad = { ...nextPad, synth: null } as any;
            padChanged = true;
          }
        }
        return padChanged ? nextPad : pad;
      });
      if (pads.some((pad, index) => pad !== t.pads[index])) {
        t = { ...t, pads };
        tracksChanged = true;
      }
      const normalizedEffects = normalizeEffects(t.effects, t.id, trackIds);
      if (t.effects === undefined || JSON.stringify(normalizedEffects) !== JSON.stringify(t.effects)) {
        t = { ...t, effects: normalizedEffects } as DrumTrack;
        tracksChanged = true;
      }
      if (t.sends === undefined) {
        t = { ...t, sends: {} } as DrumTrack;
        tracksChanged = true;
      }
      // Validate groupId reference
      if (t.groupId !== undefined && !trackIds.has(t.groupId)) {
        t = { ...t, groupId: undefined } as DrumTrack;
        tracksChanged = true;
      }
      return t;
    }
    if (track.kind === "group") {
      let t = track;
      const normalizedEffects = normalizeEffects(t.effects, t.id, trackIds);
      if (t.effects === undefined || JSON.stringify(normalizedEffects) !== JSON.stringify(t.effects)) {
        t = { ...t, effects: normalizedEffects };
        tracksChanged = true;
      }
      if (t.sends === undefined) {
        t = { ...t, sends: {} };
        tracksChanged = true;
      }
      return t;
    }
    // instrument: merge params with defaults only when keys are missing
    const defaults = defaultInstrumentParams(track.instrument);
    let t: InstrumentTrack = track;
    let paramsChanged = false;
    const merged: Record<string, number> = { ...defaults };
    const paramsRecord: Record<string, number> = track.params ?? {};
    for (const k of Object.keys(defaults)) {
      const v = paramsRecord[k];
      if (v === undefined) {
        paramsChanged = true;
      } else {
        merged[k] = v;
      }
    }
    // Backfill any keys present in the track params but missing from defaults
    for (const k of Object.keys(paramsRecord)) {
      if (merged[k] === undefined) {
        merged[k] = paramsRecord[k];
        paramsChanged = true;
      }
    }
    if (paramsChanged) {
      t = { ...track, params: merged };
      tracksChanged = true;
    }
    const normalizedEffects = normalizeEffects(t.effects, t.id, trackIds);
    if (t.effects === undefined || JSON.stringify(normalizedEffects) !== JSON.stringify(t.effects)) {
      t = { ...t, effects: normalizedEffects };
      tracksChanged = true;
    }
    if (t.sends === undefined) {
      t = { ...t, sends: {} };
      tracksChanged = true;
    }
    // Validate groupId reference
    if (t.groupId !== undefined && !trackIds.has(t.groupId)) {
      t = { ...t, groupId: undefined };
      tracksChanged = true;
    }
    return t;
  });
  if (tracksChanged) {
    s.doc = { ...doc, tracks: tracks as ProjectDocument["tracks"] };
    s.changed = true;
  }
}

function normalizeScenesDomain(s: NormalizeState): void {
  const doc = s.doc;
  const patternIds = new Set(doc.patterns.map((p) => p.id));
  const scenes = doc.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    s.doc = { ...doc, scenes: [defaultSceneFor(doc)] };
    s.changed = true;
    return;
  }
  const filtered = scenes.filter((sc) => patternIds.has(sc.patternId));
  if (filtered.length !== scenes.length) {
    s.doc = { ...doc, scenes: filtered.length > 0 ? filtered : [defaultSceneFor(doc)] };
    s.changed = true;
  }
}

function normalizeArrangementDomain(s: NormalizeState): void {
  const doc = s.doc;
  const sceneIds = new Set(doc.scenes.map((sc) => sc.id));
  const trackIds = new Set(doc.tracks.map((t) => t.id));
  let arrangement = doc.arrangement;
  if (arrangement === undefined || arrangement === null) {
    s.doc = { ...doc, arrangement: { clips: [] } };
    s.changed = true;
    return;
  }
  const rawClips = Array.isArray(arrangement.clips) ? arrangement.clips : [];
  const sorted = [...rawClips]
    .filter((c) => sceneIds.has(c.sceneId) && Number.isFinite(c.startBar) && c.startBar >= 0 && c.lengthBars >= 1)
    .sort((a, b) => a.startBar - b.startBar);
  const transitions = sanitizeArrangementTransitions(arrangement.transitions, sorted);
  const audioClips = sanitizeAudioClips((arrangement as unknown as Record<string, unknown>).audioClips, trackIds);
  const clipsChanged = sorted.length !== rawClips.length || sorted.some((clip, index) => clip !== rawClips[index]);
  const transitionsChanged = JSON.stringify(transitions) !== JSON.stringify(arrangement.transitions);
  const audioChanged =
    JSON.stringify(audioClips) !== JSON.stringify((arrangement as unknown as Record<string, unknown>).audioClips);
  if (clipsChanged || transitionsChanged || audioChanged) {
    s.doc = {
      ...doc,
      arrangement: {
        clips: sorted,
        ...(audioClips ? { audioClips } : {}),
        ...(transitions !== undefined ? { transitions } : {}),
      },
    };
    s.changed = true;
  }
}

function normalizeAutomationDomain(s: NormalizeState): void {
  const doc = s.doc;
  const trackIds = new Set(doc.tracks.map((t) => t.id));
  const automation = doc.automation;
  if (!Array.isArray(automation)) {
    s.doc = { ...doc, automation: [] };
    s.changed = true;
    return;
  }
  const filtered = automation.filter((lane) => trackIds.has(lane.target.trackId));
  if (filtered.length !== automation.length) {
    s.doc = { ...doc, automation: filtered };
    s.changed = true;
  }
}

function normalizeLfosDomain(s: NormalizeState): void {
  const doc = s.doc;
  const trackIds = new Set(doc.tracks.map((t) => t.id));
  const lfos = doc.lfos;
  if (!Array.isArray(lfos)) {
    s.doc = { ...doc, lfos: [] };
    s.changed = true;
    return;
  }
  // Full sanitizer pass: dangling refs, unknown kinds/waves, clamped ranges,
  // step arrays normalized to 8/16/32 — see modulators.ts.
  const sanitized: Lfo[] = [];
  for (const lfo of lfos) {
    const cleaned = sanitizeLfo(lfo, trackIds);
    if (cleaned) sanitized.push(cleaned);
  }
  const shapeChanged = sanitized.length !== lfos.length || sanitized.some((lfo, i) => lfo !== lfos[i]);
  if (shapeChanged) {
    s.doc = { ...doc, lfos: sanitized };
    s.changed = true;
  }
}

function normalizeMacrosDomain(s: NormalizeState): void {
  const doc = s.doc;
  if (!Array.isArray(doc.macros) || doc.macros.length === 0) {
    s.doc = { ...doc, macros: defaultMacros() };
    s.changed = true;
    return;
  }
  // Update existing macros: forward-fill default source "macro" on mappings.
  let macrosChanged = false;
  const cleanedMacros: Macro[] = [];
  for (const macro of doc.macros) {
    let macroChanged = false;
    const cleanedMappings: MacroMapping[] = [];
    for (const mapping of macro.mappings) {
      const sanitized = sanitizeMacroMapping(mapping);
      if (!sanitized) continue;
      if (
        sanitized.id !== mapping.id ||
        sanitized.trackId !== mapping.trackId ||
        sanitized.param !== mapping.param ||
        sanitized.amount !== mapping.amount ||
        sanitized.source !== (mapping.source ?? "macro")
      ) {
        macroChanged = true;
      }
      cleanedMappings.push(sanitized);
    }
    // A legitimate 0 must survive — `|| 0.5` would rewrite it, silently
    // resetting user macros on every load/import/collab snapshot.
    const macroNumber = Number(macro.value);
    const validValue = Math.max(0, Math.min(1, Number.isFinite(macroNumber) ? macroNumber : 0.5));
    if (validValue !== macro.value) macroChanged = true;
    if (cleanedMappings.length !== macro.mappings.length) macroChanged = true;
    if (macroChanged) macrosChanged = true;
    cleanedMacros.push({ ...macro, value: validValue, mappings: cleanedMappings });
  }
  if (macrosChanged) {
    s.doc = { ...doc, macros: cleanedMacros };
    s.changed = true;
  }
}

function normalizeSceneDetailsDomain(s: NormalizeState): void {
  // Backfill intensity (default 0.7) on older scenes; clamp curve/loop/role.
  let scenesChanged = false;
  const cleanedScenes: Scene[] = s.doc.scenes.map((scene) => {
    let sceneChanged = false;
    const intensity = clampIntensity(scene.intensity);
    if (intensity !== scene.intensity) {
      sceneChanged = true;
    }
    let curve: IntensityPoint[] | undefined;
    if (Array.isArray(scene.intensityCurve)) {
      const points = scene.intensityCurve
        .map((p) => sanitizeIntensityPoint(p))
        .filter((p): p is IntensityPoint => p !== null)
        .sort((a, b) => a.offset - b.offset);
      // Drop curves that contain no valid points.
      curve = points.length > 0 ? points : undefined;
      if (JSON.stringify(curve) !== JSON.stringify(scene.intensityCurve)) {
        sceneChanged = true;
      }
    } else if (scene.intensityCurve !== undefined) {
      sceneChanged = true;
    }
    const loop = typeof scene.loop === "boolean" ? scene.loop : undefined;
    if (loop !== scene.loop) sceneChanged = true;
    const role = clampSceneRole(scene.role);
    if (role !== scene.role) sceneChanged = true;
    if (sceneChanged) scenesChanged = true;
    if (!sceneChanged) return scene;
    return { ...scene, intensity, intensityCurve: curve, loop, role };
  });
  if (scenesChanged) {
    s.doc = { ...s.doc, scenes: cleanedScenes };
    s.changed = true;
  }
}

function normalizeKeyAndTagsDomain(s: NormalizeState): void {
  let doc = s.doc;
  // project.key — clamp to valid MUSICAL_KEYS.
  if (doc.key !== undefined && !isMusicalKey(doc.key)) {
    doc = { ...doc, key: undefined };
    s.changed = true;
  }
  // project.tags — clamp to string[] (non-empty strings).
  if (doc.tags !== undefined) {
    if (!Array.isArray(doc.tags)) {
      doc = { ...doc, tags: [] };
      s.changed = true;
    } else {
      const cleanedTags = doc.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "");
      if (cleanedTags.length !== doc.tags.length) {
        doc = { ...doc, tags: cleanedTags };
        s.changed = true;
      }
    }
  }
  s.doc = doc;
}

function normalizeMarkersDomain(s: NormalizeState): void {
  const doc = s.doc;
  // markers — backfill array, clamp each.
  const totalProjectTicks = Math.max(
    0,
    ...doc.scenes.map((sc) => (doc.patterns.find((p) => p.id === sc.patternId)?.stepCount ?? 0) * STEP_TICKS),
    ...(doc.arrangement?.clips?.map((c) => (c.startBar + c.lengthBars) * BAR_TICKS) ?? []),
  );
  const cleanedMarkers = sanitizeMarkers(doc.markers, totalProjectTicks);
  const markersChanged = !Array.isArray(doc.markers) || JSON.stringify(cleanedMarkers) !== JSON.stringify(doc.markers);
  if (markersChanged) {
    s.doc = { ...doc, markers: cleanedMarkers };
    s.changed = true;
  }
}

function normalizeSceneAutomationDomain(s: NormalizeState): void {
  const doc = s.doc;
  // scene automation — clamp to valid scenes + non-empty lanes.
  const liveSceneIds = new Set(doc.scenes.map((sc) => sc.id));
  const cleanedSceneAuto = sanitizeSceneAutomation(doc.sceneAutomation, liveSceneIds);
  // Only replace if the content actually changed (sanitize rebuilds objects,
  // so a reference equality check would always fail). JSON.stringify is fine
  // here — the structures are small and we run this on save/commit only.
  const sceneAutoChanged =
    !Array.isArray(doc.sceneAutomation) || JSON.stringify(cleanedSceneAuto) !== JSON.stringify(doc.sceneAutomation);
  if (sceneAutoChanged) {
    s.doc = { ...doc, sceneAutomation: cleanedSceneAuto };
    s.changed = true;
  }
}

function normalizeMasterAndReturnsDomain(s: NormalizeState): void {
  let doc = s.doc;
  // master — clamp gain + ceiling; backfill missing fields from defaults
  if (isObject(doc.master)) {
    const m = doc.master as Record<string, unknown>;
    const dg = clampMasterGain(m.masterGain);
    const dc = clampCeilingDb(m.ceilingDb);
    const dl = typeof m.limiterEnabled === "boolean" ? m.limiterEnabled : true;
    const dcl = typeof m.clipperEnabled === "boolean" ? m.clipperEnabled : false;
    if (dg !== m.masterGain || dc !== m.ceilingDb || dl !== m.limiterEnabled || dcl !== m.clipperEnabled) {
      doc = { ...doc, master: { masterGain: dg, ceilingDb: dc, limiterEnabled: dl, clipperEnabled: dcl } };
      s.changed = true;
    }
  }
  // returns
  if (!Array.isArray(doc.returns)) {
    doc = { ...doc, returns: createDefaultReturns() };
    s.changed = true;
  }
  // master
  if (doc.master === undefined || doc.master === null || typeof doc.master !== "object") {
    doc = { ...doc, master: defaultMasterConfig() };
    s.changed = true;
  }
  s.doc = doc;
}

function normalizeTimestampsDomain(s: NormalizeState): void {
  let doc = s.doc;
  // createdAt / updatedAt
  if (typeof doc.createdAt !== "string" || !Number.isFinite(Date.parse(doc.createdAt))) {
    doc = { ...doc, createdAt: new Date().toISOString() };
    s.changed = true;
  }
  if (typeof doc.updatedAt !== "string" || !Number.isFinite(Date.parse(doc.updatedAt))) {
    doc = { ...doc, updatedAt: new Date().toISOString() };
    s.changed = true;
  }
  s.doc = doc;
}

function normalizeGrooveDomain(s: NormalizeState): void {
  const doc = s.doc;
  // groove — clamp optional swing/humanize settings
  if (doc.groove !== undefined) {
    if (!isObject(doc.groove)) {
      s.doc = { ...doc, groove: undefined };
      s.changed = true;
    } else {
      const g = doc.groove;
      const swing = clampUnit(g.swing);
      const humanizeTiming = clampUnit(g.humanizeTiming);
      const humanizeVelocity = clampUnit(g.humanizeVelocity);
      if (swing !== g.swing || humanizeTiming !== g.humanizeTiming || humanizeVelocity !== g.humanizeVelocity) {
        s.doc = { ...doc, groove: { swing, humanizeTiming, humanizeVelocity } };
        s.changed = true;
      }
    }
  }
}

function normalizeMidiDomain(s: NormalizeState): void {
  const doc = s.doc;
  // midi — sanitize optional MIDI config
  if (doc.midi !== undefined) {
    if (!isObject(doc.midi)) {
      s.doc = { ...doc, midi: undefined };
      s.changed = true;
    } else {
      const m = doc.midi as Record<string, unknown>;
      const enabled = m.enabled === true;
      const deviceId = typeof m.deviceId === "string" ? m.deviceId : "";
      const drumChannel = typeof m.drumChannel === "number" ? Math.max(0, Math.min(16, m.drumChannel)) : 0;
      const instrumentChannel =
        typeof m.instrumentChannel === "number" ? Math.max(0, Math.min(16, m.instrumentChannel)) : 0;
      const pitchBendRange = typeof m.pitchBendRange === "number" ? Math.max(1, Math.min(24, m.pitchBendRange)) : 2;
      const ccMappings = Array.isArray(m.ccMappings) ? m.ccMappings : [];
      const drumNoteMap = Array.isArray(m.drumNoteMap) ? m.drumNoteMap : [];
      // Only create new object if something actually changed
      if (
        enabled !== (m.enabled === true) ||
        deviceId !== (typeof m.deviceId === "string" ? m.deviceId : "") ||
        drumChannel !== (typeof m.drumChannel === "number" ? m.drumChannel : 0) ||
        instrumentChannel !== (typeof m.instrumentChannel === "number" ? m.instrumentChannel : 0) ||
        pitchBendRange !== (typeof m.pitchBendRange === "number" ? m.pitchBendRange : 2)
      ) {
        s.doc = {
          ...doc,
          midi: { enabled, deviceId, drumChannel, instrumentChannel, ccMappings, drumNoteMap, pitchBendRange },
        };
        s.changed = true;
      }
    }
  }
}

function normalizePatternsDomain(s: NormalizeState): void {
  const doc = s.doc;
  const padIds = new Set(allPadIds(doc));
  const trackIds = new Set(doc.tracks.map((t) => t.id));
  let patternsChanged = false;
  const patterns = doc.patterns.map((pattern) => {
    let p = pattern;
    const safeStepCount = normalizeStepCount(p.stepCount);
    if (safeStepCount !== p.stepCount) {
      p = { ...p, stepCount: safeStepCount };
      patternsChanged = true;
    }
    if (p.notes === undefined) {
      p = { ...p, notes: {} };
      patternsChanged = true;
    }
    // stepMeta: drop dangling pads/steps, clamp values, prune default entries
    if (p.stepMeta !== undefined) {
      const cleaned: Record<string, Record<number, StepMeta>> = {};
      let metaChanged = false;
      for (const [padId, steps] of Object.entries(p.stepMeta)) {
        if (!padIds.has(padId)) {
          metaChanged = true;
          continue;
        }
        const cleanSteps: Record<number, StepMeta> = {};
        for (const [key, rawEntry] of Object.entries(steps) as [string, StepMeta][]) {
          const stepIndex = Number(key);
          if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= safeStepCount || !isObject(rawEntry)) {
            metaChanged = true;
            continue;
          }
          const raw: StepMeta = rawEntry;
          const meta: StepMeta = {};
          const probability = raw.probability;
          if (probability !== undefined) {
            const clamped = clampUnit(probability);
            if (clamped < 1) meta.probability = clamped;
            if (clamped !== probability) metaChanged = true;
          }
          const ratchet = raw.ratchet;
          if (ratchet !== undefined) {
            const clamped = Math.min(8, Math.max(1, Math.round(Number.isFinite(ratchet) ? ratchet : 1)));
            if (clamped > 1) meta.ratchet = clamped;
            if (clamped !== ratchet) metaChanged = true;
          }
          const microtiming = raw.microtiming;
          if (microtiming !== undefined) {
            const clamped = Math.min(1, Math.max(-1, Number.isFinite(microtiming) ? microtiming : 0));
            if (clamped !== 0) meta.microtiming = clamped;
            if (clamped !== microtiming) metaChanged = true;
          }
          const amount = (raw as Record<string, unknown>).amount;
          if (amount !== undefined) {
            const clamped = clampUnit(amount);
            if (clamped < 1) meta.amount = clamped;
            if (clamped !== amount) metaChanged = true;
            if (clamped >= 1 && amount !== 1) metaChanged = true;
          }
          const rawLocks = raw.locks;
          if (rawLocks !== undefined && isObject(rawLocks)) {
            const cleanedLocks: NonNullable<StepMeta["locks"]> = {};
            let locksChanged = false;
            const ALLOWED_LOCKS = new Set(["pitch", "gain", "pan", "cutoff", "sampleStart", "length"]);
            const def = {
              pitch: { min: -24, max: 24 },
              gain: { min: 0, max: 2 },
              pan: { min: -1, max: 1 },
              cutoff: { min: 80, max: 16000 },
              sampleStart: { min: 0, max: 1 },
              length: { min: 0.1, max: 2 },
            } as const;
            for (const [k, v] of Object.entries(rawLocks)) {
              if (!ALLOWED_LOCKS.has(k)) {
                locksChanged = true;
                continue;
              }
              if (typeof v !== "number" || !Number.isFinite(v)) {
                locksChanged = true;
                continue;
              }
              const clamped = Math.min(def[k as keyof typeof def].max, Math.max(def[k as keyof typeof def].min, v));
              let rounded: number;
              if (k === "pitch") rounded = Math.round(clamped * 10) / 10;
              else if (k === "cutoff") rounded = Math.round(clamped);
              else rounded = Math.round(clamped * 100) / 100;
              cleanedLocks[k as keyof typeof cleanedLocks] = rounded;
              if (rounded !== v) locksChanged = true;
            }
            if (Object.keys(cleanedLocks).length > 0) {
              meta.locks = cleanedLocks;
              if (locksChanged) metaChanged = true;
            } else if (rawLocks && Object.keys(rawLocks).length > 0) {
              metaChanged = true;
            }
          } else if (rawLocks !== undefined) {
            metaChanged = true;
          }
          if (Object.keys(meta).length > 0) cleanSteps[stepIndex] = meta;
          else metaChanged = true;
        }
        if (Object.keys(cleanSteps).length > 0) cleaned[padId] = cleanSteps;
        else metaChanged = true;
      }
      const nextMeta = Object.keys(cleaned).length > 0 ? cleaned : undefined;
      if (metaChanged || nextMeta !== p.stepMeta) {
        p = { ...p, stepMeta: nextMeta };
        patternsChanged = true;
      }
    }
    // Filter notes to existing tracks and adjust to safe stepCount
    const notesByTrack: Record<string, typeof p.notes extends Record<string, infer V> ? V : never> = {};
    let notesChanged = false;
    for (const [trackId, noteList] of Object.entries(p.notes ?? {})) {
      if (!trackIds.has(trackId)) {
        notesChanged = true;
        continue;
      }
      const patternTicks = safeStepCount * (PPQ / 4);
      const filtered = noteList.filter((n) => n.start + n.duration <= patternTicks);
      if (filtered.length !== noteList.length) notesChanged = true;
      notesByTrack[trackId] = filtered as never;
    }
    if (notesChanged) {
      p = { ...p, notes: notesByTrack as typeof p.notes };
      patternsChanged = true;
    }
    // Rows: drop unknown pad rows, fill missing pad rows, fix wrong length
    let rows = p.rows;
    const validPadIds: string[] = [];
    for (const [padId, row] of Object.entries(rows)) {
      if (!padIds.has(padId)) {
        if (rows === p.rows) rows = { ...rows };
        delete rows[padId];
        patternsChanged = true;
        continue;
      }
      if (!Array.isArray(row) || row.length !== safeStepCount) {
        if (rows === p.rows) rows = { ...rows };
        rows[padId] = new Array<number>(safeStepCount).fill(0).map((_, i) => (Array.isArray(row) ? (row[i] ?? 0) : 0));
        patternsChanged = true;
      }
      validPadIds.push(padId);
    }
    for (const padId of padIds) {
      if (!validPadIds.includes(padId)) {
        if (rows === p.rows) rows = { ...rows };
        rows[padId] = new Array<number>(safeStepCount).fill(0);
        patternsChanged = true;
      }
    }
    if (rows !== p.rows) {
      p = { ...p, rows };
      patternsChanged = true;
    }
    return p;
  });
  if (patternsChanged) {
    s.doc = { ...doc, patterns };
    s.changed = true;
  }
}

const NORMALIZE_DOMAINS: ((s: NormalizeState) => void)[] = [
  normalizeTimeSignatureDomain,
  normalizeBpmDomain,
  normalizeActivePatternDomain,
  normalizeTracksDomain,
  normalizeScenesDomain,
  normalizeArrangementDomain,
  normalizeAutomationDomain,
  normalizeLfosDomain,
  normalizeMacrosDomain,
  normalizeSceneDetailsDomain,
  normalizeKeyAndTagsDomain,
  normalizeMarkersDomain,
  normalizeSceneAutomationDomain,
  normalizeMasterAndReturnsDomain,
  normalizeTimestampsDomain,
  normalizeGrooveDomain,
  normalizeMidiDomain,
  normalizePatternsDomain,
];

/**
 * Bring a project document (possibly loaded from disk, possibly mutated by an
 * outdated client or a collab peer) to a state the current engine can use
 * without errors. See the per-domain sanitizer block above for the domain
 * breakdown and the load-bearing ordering contract.
 *
 * Normalization is idempotent and never throws — it always returns a valid
 * `ProjectDocument`. Callers should treat the return value as the new truth
 * and discard the input.
 */
export function normalizeProject(doc: ProjectDocument): ProjectDocument {
  const state: NormalizeState = { doc, changed: false };
  for (const domain of NORMALIZE_DOMAINS) domain(state);
  return state.changed ? state.doc : doc;
}

export const ensurePatternRows = normalizeProject;

export function migrateProject(doc: ProjectDocument): ProjectDocument {
  if (doc.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Project schema ${doc.schemaVersion} is newer than supported ${SCHEMA_VERSION}`);
  }
  let migrated = doc;
  if (migrated.schemaVersion === SCHEMA_VERSION) return normalizeProject(migrated);
  migrated = { ...migrated, schemaVersion: SCHEMA_VERSION };
  return normalizeProject(migrated);
}

function isValidTimeSignature(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const ts = value as Record<string, unknown>;
  const num = ts.numerator;
  const den = ts.denominator;
  if (typeof num !== "number" || typeof den !== "number") return false;
  if (!Number.isInteger(num) || !Number.isInteger(den)) return false;
  return num > 0 && den > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateProjectShape(doc: unknown): doc is ProjectDocument {
  if (!isObject(doc)) return false;
  if (
    typeof doc.schemaVersion !== "number" ||
    typeof doc.id !== "string" ||
    typeof doc.name !== "string" ||
    typeof doc.bpm !== "number" ||
    !Array.isArray(doc.tracks) ||
    !Array.isArray(doc.patterns) ||
    typeof doc.activePatternId !== "string"
  ) {
    return false;
  }
  if (doc.timeSignature !== undefined && !isValidTimeSignature(doc.timeSignature)) return false;
  if (doc.scenes !== undefined && !Array.isArray(doc.scenes)) return false;
  if (doc.automation !== undefined && !Array.isArray(doc.automation)) return false;
  if (doc.lfos !== undefined && !Array.isArray(doc.lfos)) return false;
  if (doc.macros !== undefined && !Array.isArray(doc.macros)) return false;
  if (doc.returns !== undefined && !Array.isArray(doc.returns)) return false;
  if (doc.master !== undefined && !isObject(doc.master)) return false;
  if (doc.groove !== undefined && !isObject(doc.groove)) return false;
  if (doc.midi !== undefined && !isObject(doc.midi)) return false;
  if (doc.arrangement !== undefined) {
    if (!isObject(doc.arrangement) || !Array.isArray(doc.arrangement.clips)) return false;
  }
  if (doc.createdAt !== undefined && typeof doc.createdAt !== "string") return false;
  if (doc.updatedAt !== undefined && typeof doc.updatedAt !== "string") return false;
  return true;
}

export function beatsPerBar(doc: ProjectDocument): number {
  return doc.timeSignature.numerator;
}

export function ticksPerBar(doc: ProjectDocument): number {
  return PPQ * (4 / doc.timeSignature.denominator) * doc.timeSignature.numerator;
}

/** Ticks per beat (one quarter note in 4/4, one eighth note in 6/8). */
export function ticksPerBeat(doc: ProjectDocument): number {
  return PPQ * (4 / doc.timeSignature.denominator);
}

/**
 * 1-indexed bar number for an absolute musical tick.
 *
 * Negative ticks clamp to bar 0 (a virtual "pre-roll" zone — useful for
 * arrangements that start after the transport has been running for a while).
 */
export function barAtTick(tick: number, doc: ProjectDocument): number {
  const tpb = ticksPerBar(doc);
  if (tpb <= 0) return 1;
  return Math.floor(tick / tpb) + 1;
}

/**
 * 1-indexed beat-within-bar number for an absolute musical tick. Beat 1
 * is the first beat of the bar.
 */
export function beatAtTick(tick: number, doc: ProjectDocument): number {
  const tpb = ticksPerBar(doc);
  if (tpb <= 0) return 1;
  const tpbBeat = ticksPerBeat(doc);
  if (tpbBeat <= 0) return 1;
  return Math.floor(mod(tick, tpb) / tpbBeat) + 1;
}

/** Absolute tick at the start of a given 1-indexed bar. */
export function tickAtBar(bar: number, doc: ProjectDocument): number {
  return Math.max(0, bar - 1) * ticksPerBar(doc);
}

/** Absolute tick at a given 1-indexed bar/beat position. */
export function tickAtBarBeat(bar: number, beat: number, doc: ProjectDocument): number {
  return Math.max(0, bar - 1) * ticksPerBar(doc) + Math.max(0, beat - 1) * ticksPerBeat(doc);
}

function mod(value: number, m: number): number {
  if (m <= 0) return value;
  return ((value % m) + m) % m;
}
