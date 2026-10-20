import type {
  DrumPad,
  DrumTrack,
  DeviceState,
  EffectInstance,
  EffectType,
  GenerativeTrack,
  GenerativeMacroAutomation,
  GenerativeMacroName,
  GenerativeTrackConfig,
  InstrumentKind,
  InstrumentTrack,
  IntensityPoint,
  Lfo,
  Macro,
  MidiClip,
  NoteEvent,
  NoteExpression,
  MacroMapping,
  Marker,
  MasterConfig,
  ArrangementClip,
  ArrangementAutomationClip,
  AutomationPoint,
  Pattern,
  ProjectDocument,
  ProjectLineage,
  ProjectTransferOriginV1,
  ReturnTrack,
  Scene,
  SceneRole,
  ArrangementTransition,
  ArrangementTransitionType,
  SceneAutomation,
  StepMeta,
  AutomationTarget,
  TimeSignature,
} from "./types";
import { BAR_TICKS, PATTERN_TICKS, PPQ, STEP_TICKS, STEPS_PER_PATTERN, isMusicalKey } from "./types";
import { tempoAtTick } from "./scene-time";
import { CHORD_QUALITIES } from "./chords";
import { sanitizeProjectProducerBrief } from "./producer-brief";
import { sanitizeGateSteps, sanitizeLfo, sanitizeManglerSteps } from "./modulators";
import { uid } from "../shared/ids";
import { jsonEqual } from "../shared/jsonEqual";
import { clampInstrumentParam, defaultInstrumentParams, INSTRUMENT_META } from "../instruments/definitions";
import { supportsHeldVoiceSlideNote } from "../instruments/noteExpressionCapabilities";
import { createProjectFromTemplate } from "./templates";
import { clampEffectParam, defaultParamsOf, EFFECT_META, normalizePluginParams } from "../effects/definitions";
import { clampFxOutputTrimDb } from "../effects/presetLoudness";
import { isMasterProfileId } from "../mastering/profiles";
import {
  canonicalizeDeprecatedTarget,
  automationTargetKey,
  clampTargetValue,
  isAutomationTargetValid,
  targetOwner,
  targetParamDef,
} from "./targets";

export const SCHEMA_VERSION = 38;
/** Minimum BPM accepted by the transport. Matches the `setBpm` command clamp. */
export const MIN_BPM = 20;
/** Maximum BPM accepted by the transport. Matches the `setBpm` command clamp. */
export const MAX_BPM = 300;
/** BPM used when an invalid (NaN/non-finite) value reaches the normalizer. */
export const FALLBACK_BPM = 120;
/** stepCount used when a pattern's stepCount is invalid (0/negative/NaN). */
export const FALLBACK_STEP_COUNT = STEPS_PER_PATTERN;
/**
 * Hard upper bound on an arrangement clip's length, in bars.
 *
 * This is a rendering invariant rather than a musical one: the arrangement
 * view allocates one bar-grid node per bar (`Array.from({ length: totalBars })`),
 * so an unbounded clip length can demand millions of DOM nodes. A typed
 * length, a scripted command or an imported document could all reach that
 * state, and the tab would stop responding.
 *
 * 8192 bars in 4/4 is roughly 5.7 hours of music — far beyond any real
 * arrangement — while keeping the grid well inside a browser-friendly node
 * budget. Resize commands clamp to it; the UI mirrors it as a field maximum.
 */
export const MAX_ARRANGEMENT_CLIP_BARS = 8192;
export const MAX_ARRANGEMENT_CLIP_TICKS = MAX_ARRANGEMENT_CLIP_BARS * BAR_TICKS;

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

export function createGenerativeTrackModel(name: string): GenerativeTrack {
  return {
    id: uid("track"),
    kind: "generative",
    name,
    gain: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
    sends: {},
    generative: {
      providerId: "mrt2",
      modelId: "mrt2_small",
      style: { kind: "text", text: "dark atmospheric accompaniment" },
      drumsMode: "off",
      macros: { energy: 0.5, density: 0.35, variation: 0.25, texture: 0.5 },
      latencyMode: "live",
    },
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
  organ: "Organ",
  strings: "Strings",
  bell: "Bell",
  reese: "Reese",
  clav: "Clavinet",
  acid: "Acid 303",
  brass: "Synth Brass",
  fm: "FM",
  pluck: "Pluck",
  flute: "Flute",
  logdrum: "Log Drum",
  spectral: "Spectral",
  vocalchop: "Vocal Chop",
  drumsynth: "Drum Synth",
  tsar: "TSAR",
  kopa: "Kopa",
  choral: "Chorál",
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
    sampleId:
      kind === "sampler"
        ? "factory.tonal.pluck"
        : kind === "granular"
          ? "factory.tonal.keys"
          : kind === "vocalchop"
            ? "factory.tonal.stab"
            : null,
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
    params: { ...defaultParamsOf("reverb"), decay: 2.2, predelay: 20, tone: 6000, mix: 1 },
  };
  const delayFx: EffectInstance = {
    id: uid("fx"),
    type: "delay",
    bypassed: false,
    params: { ...defaultParamsOf("delay"), time: 375, feedback: 0.4, tone: 4000, mix: 1 },
  };
  const nyCompFx: EffectInstance = {
    id: uid("fx"),
    type: "compressor",
    bypassed: false,
    params: {
      ...defaultParamsOf("compressor"),
      threshold: -24,
      ratio: 10,
      attack: 0.001,
      release: 0.12,
      knee: 6,
      mix: 1,
    },
  };
  return [
    { id: uid("return"), kind: "return", name: "Reverb", gain: 0.9, effects: [reverbFx] },
    { id: uid("return"), kind: "return", name: "Delay", gain: 0.85, effects: [delayFx] },
    { id: uid("return"), kind: "return", name: "NY Comp", gain: 0.85, effects: [nyCompFx] },
  ];
}

export function defaultMasterConfig(): MasterConfig {
  return {
    masterGain: 1,
    ceilingDb: -1,
    limiterEnabled: true,
    clipperEnabled: false,
    limiterLookaheadMs: 5,
    limiterReleaseMs: 120,
    limiterCharacter: "transparent",
    limiterTransientLink: 1,
    limiterReleaseLink: 1,
    tapeEnabled: false,
    tapeDrive: 0.35,
    msEnabled: false,
    msMidGain: 0,
    msSideGain: 0,
    lufsTarget: -14,
    deliveryProfileId: "streaming",
    deliveryTruePeakDb: -1,
    effects: [],
    bassMonoEnabled: false,
    bassMonoFreq: 120,
    glueEnabled: true,
    tiltDb: 0,
    loudnessTrimDb: 0,
  };
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
  const seenIds = new Set<string>();
  for (const raw of input) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id : uid("marker");
    // The doc-comment promised this dedupe and the body never did it, so a
    // document carrying two markers under one id kept both: every id-lookup
    // (`markers.find(m => m.id === …)`) resolves to the first, and the second
    // is a live marker with no owner. Keep the first occurrence — the one the
    // lookups already resolve to.
    if (seenIds.has(id)) continue;
    seenIds.add(id);
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
export function sanitizeSceneAutomation(
  input: unknown,
  sceneIds: Set<string>,
  doc?: ProjectDocument,
): SceneAutomation[] {
  if (!Array.isArray(input)) return [];
  const out: SceneAutomation[] = [];
  for (const raw of input) {
    if (!isObject(raw)) continue;
    if (typeof raw.sceneId !== "string" || !sceneIds.has(raw.sceneId)) continue;
    if (!isObject(raw.target)) continue;
    const target = raw.target as unknown as AutomationTarget;
    if (doc && !isAutomationTargetValid(doc, target)) continue;
    if (!Array.isArray(raw.points)) continue;
    const id = typeof raw.id === "string" ? raw.id : uid("sceneAuto");
    const points = raw.points
      .map((p: unknown) => {
        if (!isObject(p)) return null;
        const tick = Math.max(0, Math.floor(Number(p.tick) || 0));
        const value = Number(p.value);
        if (!Number.isFinite(value)) return null;
        return { tick, value: doc ? clampTargetValue(doc, target, value) : value };
      })
      .filter((p: unknown): p is { tick: number; value: number } => p !== null)
      .sort((a: { tick: number }, b: { tick: number }) => a.tick - b.tick);
    if (points.length === 0) continue;
    out.push({
      id,
      sceneId: raw.sceneId,
      target: target as SceneAutomation["target"],
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
/** Hard ceiling (Audit 08 D6): a hostile doc with stepCount: 1e9 OOM'd the
 * tab inside normalize's row rebuild (16 × stepCount-length arrays per
 * pattern). 128 steps = 8 bars — far above any UI flow (drag/zoom stops at
 * 64), far below OOM territory. */
export const MAX_STEP_COUNT = 128;

export function normalizeStepCount(stepCount: number): number {
  if (!Number.isFinite(stepCount) || stepCount <= 0 || !Number.isInteger(stepCount)) {
    return FALLBACK_STEP_COUNT;
  }
  return Math.min(MAX_STEP_COUNT, stepCount);
}

export function sanitizeColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

function defaultSceneFor(doc: ProjectDocument): Scene {
  return { id: uid("scene"), name: "Scene A", patternId: doc.activePatternId, intensity: 0.7 };
}

const SCENE_ROLES: ReadonlyArray<SceneRole> = [
  "intro",
  "build",
  "drop",
  "break",
  "outro",
  "fill",
  "verse",
  "chorus",
  "bridge",
  "custom",
];
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
  if (/^(drop|main)\b/.test(normalized)) return "drop";
  if (/^(chorus|hook)\b/.test(normalized)) return "chorus";
  if (/^(verse)\b/.test(normalized)) return "verse";
  if (/^(bridge)\b/.test(normalized)) return "bridge";
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

export function sanitizeAudioClips(
  input: unknown,
  trackIds: Set<string>,
  /** Project BPM for the fallback fade bound (normalizeBpmDomain runs before this domain). */
  bpm?: number,
  /**
   * Scene-aware duration resolver: bounds fades at the tempo the clip
   * actually plays at (its covering scene's BPM pin), not flat doc.bpm —
   * the comp-crossfade writer sizes fades at the scene tempo and a flat
   * project-tempo bound would clamp valid crossfades on every normalize.
   */
  durationSecOf?: (startBar: number, lengthBars: number) => number,
  /**
   * The document's bar length in ticks (ADR 0056) — used only by the fallback
   * fade bound below. Without it a 6/8 clip's bound is computed in 4/4 bars
   * and lands a third too long, which is exactly the "fade outlives the clip"
   * case the bound exists to prevent. Document-aware callers pass
   * `ticksPerBar(doc)`; a caller with no document gets the 4/4 grid.
   */
  barUnitTicks?: number,
): import("./types").AudioClip[] | undefined {
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
    // Recorded comp fragments can be shorter than the normal UI clip-size
    // floor. A positive duration is valid; zero/negative clips cannot schedule,
    // and an unbounded one cannot be rendered (one grid node per bar).
    if (!Number.isFinite(lengthBars) || lengthBars <= 0 || lengthBars > MAX_ARRANGEMENT_CLIP_BARS) continue;
    const offsetSec = Math.max(0, Number.isFinite(Number(raw.offsetSec)) ? Number(raw.offsetSec) : 0);
    const trimStart = Math.max(0, Number.isFinite(Number(raw.trimStart)) ? Number(raw.trimStart) : 0);
    const trimEnd = Math.max(0, Number.isFinite(Number(raw.trimEnd)) ? Number(raw.trimEnd) : 0);
    const gain = Math.min(2, Math.max(0, Number.isFinite(Number(raw.gain)) ? Number(raw.gain) : 1));
    // Fades must never outlive their clip (clampClipFades invariant): on load,
    // bound them to the clip's duration so a hand-edited/imported doc cannot
    // carry a 4s fade on a 0.2s clip until some length-rewriting command runs.
    const fadeBoundSec =
      durationSecOf !== undefined
        ? durationSecOf(startBar, lengthBars)
        : (lengthBars * (barUnitTicks ?? BAR_TICKS) * 60) / (Math.max(1, Number.isFinite(bpm) ? bpm! : 120) * PPQ);
    const fadeIn = Math.min(fadeBoundSec, Math.max(0, Number.isFinite(Number(raw.fadeIn)) ? Number(raw.fadeIn) : 0));
    const fadeOut = Math.min(fadeBoundSec, Math.max(0, Number.isFinite(Number(raw.fadeOut)) ? Number(raw.fadeOut) : 0));
    let stretchRate = Number.isFinite(Number(raw.stretchRate)) ? Number(raw.stretchRate) : 1;
    stretchRate = Math.min(4, Math.max(0.25, stretchRate));
    const pitchSemitones = Number.isFinite(Number(raw.pitchSemitones))
      ? Math.round(Math.min(24, Math.max(-24, Number(raw.pitchSemitones))))
      : 0;
    const reverse = raw.reverse === true;
    const loop = raw.loop === true;
    const loopPhaseOffsetSec =
      loop && !reverse && Number.isFinite(Number(raw.loopPhaseOffsetSec)) && Number(raw.loopPhaseOffsetSec) >= 0
        ? Number(raw.loopPhaseOffsetSec)
        : undefined;
    const sourceChannel =
      Number.isSafeInteger(raw.sourceChannel) && Number(raw.sourceChannel) >= 0 && Number(raw.sourceChannel) < 32
        ? Number(raw.sourceChannel)
        : undefined;
    const liveSetId =
      typeof raw.liveSetId === "string" && raw.liveSetId !== "" && raw.liveSetId.length <= 128
        ? raw.liveSetId
        : undefined;
    const livePadSlot =
      Number.isInteger(raw.livePadSlot) && Number(raw.livePadSlot) >= 0 && Number(raw.livePadSlot) < 16
        ? Number(raw.livePadSlot)
        : undefined;
    const takeGroupId = typeof raw.takeGroupId === "string" && raw.takeGroupId !== "" ? raw.takeGroupId : undefined;
    const takeId = typeof raw.takeId === "string" && raw.takeId !== "" ? raw.takeId : undefined;
    const compSourceTakeId =
      typeof raw.compSourceTakeId === "string" && raw.compSourceTakeId !== "" ? raw.compSourceTakeId : undefined;
    const stretchMode: "resample" | "stretch" | undefined = raw.stretchMode === "stretch" ? "stretch" : undefined;
    const warpMarkers: Array<{ timeSec: number; tick: number }> | undefined = (() => {
      if (!Array.isArray(raw.warpMarkers)) return undefined;
      const out: Array<{ timeSec: number; tick: number }> = [];
      for (const m of raw.warpMarkers as Array<Record<string, unknown>>) {
        if (
          typeof m.timeSec === "number" &&
          typeof m.tick === "number" &&
          Number.isFinite(m.timeSec) &&
          Number.isFinite(m.tick)
        ) {
          out.push({ timeSec: m.timeSec, tick: m.tick });
        }
      }
      out.sort((a, b) => a.tick - b.tick);
      return out.length > 0 ? out.slice(0, 256) : undefined;
    })();
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
      ...(pitchSemitones !== 0 ? { pitchSemitones } : {}),
      reverse,
      ...(sourceChannel !== undefined ? { sourceChannel } : {}),
      ...(liveSetId !== undefined && livePadSlot !== undefined ? { liveSetId, livePadSlot } : {}),
      ...(takeGroupId && takeId ? { takeGroupId, takeId } : {}),
      ...(takeGroupId && takeId && compSourceTakeId ? { compSourceTakeId } : {}),
      ...(loop ? { loop } : {}),
      ...(loopPhaseOffsetSec !== undefined ? { loopPhaseOffsetSec } : {}),
      ...(stretchMode ? { stretchMode } : {}),
      ...(warpMarkers ? { warpMarkers } : {}),
      ...(raw.muted === true ? { muted: true } : {}),
      ...(raw.locked === true ? { locked: true } : {}),
      ...(raw.fadeCurve === "equal" ? { fadeCurve: "equal" as const } : {}),
    });
  }
  out.sort((a, b) => a.startBar - b.startBar);
  return out.length > 0 ? out : undefined;
}

/** Keep only take groups with at least one routable clip on their owning track. */
export function sanitizeAudioTakeGroups(
  input: unknown,
  audioClips: readonly import("./types").AudioClip[] | undefined,
  trackIds: Set<string>,
): import("./types").AudioTakeGroup[] | undefined {
  if (!Array.isArray(input) || !audioClips?.length) return undefined;
  const out: import("./types").AudioTakeGroup[] = [];
  const seen = new Set<string>();
  for (const raw of input as Record<string, unknown>[]) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : "";
    const trackId = typeof raw.trackId === "string" ? raw.trackId : "";
    if (!id || seen.has(id) || !trackIds.has(trackId)) continue;
    const takes = audioClips.filter((clip) => clip.takeGroupId === id && clip.takeId && clip.trackId === trackId);
    const requestedCompTakeId =
      typeof raw.compTakeId === "string" && raw.compTakeId !== "" ? raw.compTakeId : undefined;
    const allTakeIds = new Set(takes.map((clip) => clip.takeId).filter((takeId): takeId is string => Boolean(takeId)));
    const sourceTakeIds = new Set([...allTakeIds].filter((takeId) => takeId !== requestedCompTakeId));
    const hasComp = Boolean(
      requestedCompTakeId &&
      takes.some(
        (clip) =>
          clip.takeId === requestedCompTakeId &&
          clip.compSourceTakeId !== undefined &&
          sourceTakeIds.has(clip.compSourceTakeId),
      ),
    );
    const compTakeId = hasComp ? requestedCompTakeId : undefined;
    const firstTakeId = takes.find((clip) => clip.takeId && clip.takeId !== compTakeId)?.takeId ?? takes[0]?.takeId;
    if (!firstTakeId) continue;
    const validTakeIds = new Set([...sourceTakeIds, ...(compTakeId ? [compTakeId] : [])]);
    const activeTakeId =
      typeof raw.activeTakeId === "string" && validTakeIds.has(raw.activeTakeId) ? raw.activeTakeId : firstTakeId;
    seen.add(id);
    out.push({ id, trackId, activeTakeId, ...(compTakeId ? { compTakeId } : {}) });
  }
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

// GOAL 08/B1: normalizeEffects revalidates every FX instance on every
// normalize call (per keystroke on large projects). The expensive steps are
// PURE functions of their input object, and documents are immutable — so the
// results memoize by input reference. Untouched effects (stable refs) skip
// revalidation entirely; only the edited instance re-pays. The cached params
// object is shared read-only (verified: no in-place params mutation exists).
const pluginParamsCache = new WeakMap<object, { type: string; params: Record<string, number> }>();
function cachedNormalizePluginParams(type: EffectType, source: Record<string, unknown>): Record<string, number> | null {
  const cached = pluginParamsCache.get(source);
  if (cached && cached.type === type) return cached.params;
  const params = normalizePluginParams(type, source);
  if (params) pluginParamsCache.set(source, { type, params });
  return params;
}

const deviceStateCache = new WeakMap<object, DeviceState>();
function cachedSanitizeDeviceState(raw: unknown): DeviceState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const cached = deviceStateCache.get(raw);
  if (cached) return cached;
  const result = sanitizeDeviceState(raw);
  if (result) deviceStateCache.set(raw, result);
  return result;
}

function normalizeEffects(raw: unknown, trackId: string, trackIds: Set<string>): EffectInstance[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is EffectInstance => {
      const fx = item as Partial<EffectInstance>;
      return (
        typeof fx?.id === "string" &&
        typeof fx?.type === "string" &&
        Boolean(EFFECT_META[fx.type as keyof typeof EFFECT_META])
      );
    })
    .map((item) => {
      const type = item.type;
      const defaults = defaultParamsOf(type);
      const source = item.params && typeof item.params === "object" ? item.params : {};
      // Flagship plugins (ultina/fxeq/ozvena) carry deep namespaced params
      // authored by their panels — validate them against the plugin's own
      // schema instead of retaining only the registry's rack defaults
      // (which silently reset every saved plugin mix on load).
      const pluginParams = cachedNormalizePluginParams(type, source as Record<string, unknown>);
      let params: Record<string, number>;
      if (pluginParams) {
        params = pluginParams;
      } else {
        params = { ...defaults };
        for (const id of Object.keys(defaults)) {
          const value = (source as Record<string, unknown>)[id];
          if (typeof value === "number" && Number.isFinite(value)) params[id] = clampEffectParam(type, id, value);
        }
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
      // Plugin editor state (A/B snapshots…) — validated per kind; unknown
      // kinds fail closed so a plugin must ship its own validator.
      const deviceState = cachedSanitizeDeviceState((item as { deviceState?: unknown }).deviceState);
      const rawOutputTrimDb = (item as { outputTrimDb?: unknown }).outputTrimDb;
      const outputTrimDb =
        typeof rawOutputTrimDb === "number" && Number.isFinite(rawOutputTrimDb)
          ? clampFxOutputTrimDb(rawOutputTrimDb)
          : 0;
      // Step-sequenced effects (stepGate) carry an editable pattern array.
      const steps =
        type === "stepGate" || type === "stutter" ? sanitizeGateSteps((item as { steps?: unknown }).steps) : undefined;
      // Beat Mangler bar envelopes (FX expansion): volume 0..1, pitch −24…24.
      const isMangler = type === "beatMangler";
      const rawVolume = (item as { volumeSteps?: unknown }).volumeSteps;
      const rawPitch = (item as { pitchSteps?: unknown }).pitchSteps;
      const volumeSteps = isMangler ? sanitizeManglerSteps(rawVolume, 0, 1, 1) : undefined;
      const pitchSteps = isMangler ? sanitizeManglerSteps(rawPitch, -24, 24, 0) : undefined;
      return {
        id: item.id,
        type,
        bypassed: item.bypassed === true,
        params,
        ...(outputTrimDb !== 0 ? { outputTrimDb } : {}),
        ...(steps ? { steps } : {}),
        ...(volumeSteps && volumeSteps.length > 0 ? { volumeSteps } : {}),
        ...(pitchSteps && pitchSteps.length > 0 ? { pitchSteps } : {}),
        ...(sidechainTrackId ? { sidechainTrackId } : {}),
        ...(deviceState ? { deviceState } : {}),
      };
    });
}

const DEVICE_STATE_KIND_MAX = 32;
// Flagship snapshots are full parameter maps: FXEQ can expose ~200 deep
// fields at six bands and Ozvena carries the complete three-engine state.
// Keep a hard bound for hostile documents, but do not truncate legitimate
// plugin snapshots halfway through their schema.
const DEVICE_STATE_SLOT_KEYS_MAX = 512;
const DEVICE_STATE_KEY_MAX = 48;

/** Clamp a device state blob to a legal, size-bounded payload; unknown kinds drop. */
export function sanitizeDeviceState(raw: unknown): DeviceState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const ds = raw as Partial<DeviceState> & Record<string, unknown>;
  if (typeof ds.kind !== "string" || ds.kind.length === 0 || ds.kind.length > DEVICE_STATE_KIND_MAX) return undefined;
  if (typeof ds.data !== "object" || ds.data === null || Array.isArray(ds.data)) return undefined;
  if (ds.kind === "ultina-ab-v1" || ds.kind === "effect-ab-v1") return sanitizeAbState(ds.kind, ds.data);
  if (ds.kind === "morph-scenes-v1") return sanitizeMorphScenesState(ds.data);
  if (ds.kind === "twist-curves-v1") return sanitizeTwistCurvesState(ds.data);
  if (ds.kind === "koren-scene-v1") return sanitizeKorenSceneState(ds.data);
  return undefined;
}

function sanitizeAbState(
  kind: "ultina-ab-v1" | "effect-ab-v1",
  data: Record<string, unknown>,
): DeviceState | undefined {
  const rawSlots = (data.slots ?? null) as Record<string, unknown> | null;
  if (typeof rawSlots !== "object" || rawSlots === null || Array.isArray(rawSlots)) return undefined;
  const slots: Record<string, Record<string, number>> = {};
  let hasValidSlot = false;
  for (const slot of ["A", "B"] as const) {
    const raw = rawSlots[slot];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    hasValidSlot = true;
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, DEVICE_STATE_SLOT_KEYS_MAX)) {
      if (key.length <= DEVICE_STATE_KEY_MAX && typeof value === "number" && Number.isFinite(value)) {
        clean[key] = value;
      }
    }
    // An empty object is valid for a freshly stored slot when an
    // older/imported effect has not materialized its parameter map yet.
    slots[slot] = clean;
  }
  // An empty slot map is valid before the first STORE: the editor still needs
  // to persist which side is active so the next STORE lands in that side.
  if (!hasValidSlot && data.active !== "A" && data.active !== "B") return undefined;
  // capturedLufs and other meter data are session-scoped — never persisted here.
  // Keep an empty active slot: users can switch to B, edit, then STORE it.
  // Recall still requires a concrete snapshot in loadEffectAbSlot/loadUltina.
  const active = data.active === "B" ? "B" : "A";
  return { kind, data: { slots, active } };
}

/**
 * MORPH DYNAMICS morph scenes (A: Clean / B: Dense / C: Wide / D: Destroyed).
 * Each slot is a full engine parameter map (macros + sections; globals and
 * the mod-matrix wiring are deliberately excluded by the panel before this
 * sanitizer ever sees the blob). Values are numeric-validated and
 * size-bounded; the DSP schema clamps again on load into the worklet.
 */
function sanitizeMorphScenesState(data: Record<string, unknown>): DeviceState | undefined {
  const rawSlots = (data.slots ?? null) as Record<string, unknown> | null;
  if (typeof rawSlots !== "object" || rawSlots === null || Array.isArray(rawSlots)) return undefined;
  const slots: Record<string, Record<string, number>> = {};
  let hasValidSlot = false;
  for (const slot of ["A", "B", "C", "D"] as const) {
    const raw = rawSlots[slot];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    hasValidSlot = true;
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, DEVICE_STATE_SLOT_KEYS_MAX)) {
      if (key.length <= DEVICE_STATE_KEY_MAX && typeof value === "number" && Number.isFinite(value)) {
        clean[key] = value;
      }
    }
    slots[slot] = clean;
  }
  if (!hasValidSlot) return undefined;
  return { kind: "morph-scenes-v1", data: { slots } };
}

/**
 * TWIST curve snapshots (A/B) — two full rack-parameter maps the MORPH knob
 * blends between. Values are numeric-validated and size-bounded; the node
 * falls back to the live base value for any id a partial snapshot misses.
 */
function sanitizeTwistCurvesState(data: Record<string, unknown>): DeviceState | undefined {
  const rawSlots = (data.slots ?? null) as Record<string, unknown> | null;
  if (typeof rawSlots !== "object" || rawSlots === null || Array.isArray(rawSlots)) return undefined;
  const slots: Record<string, Record<string, number>> = {};
  let hasValidSlot = false;
  for (const slot of ["A", "B"] as const) {
    const raw = rawSlots[slot];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    hasValidSlot = true;
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, DEVICE_STATE_SLOT_KEYS_MAX)) {
      if (key.length <= DEVICE_STATE_KEY_MAX && typeof value === "number" && Number.isFinite(value)) {
        clean[key] = value;
      }
    }
    slots[slot] = clean;
  }
  if (!hasValidSlot) return undefined;
  return { kind: "twist-curves-v1", data: { slots } };
}

const KOREN_SCENE_PARAM_IDS = new Set(EFFECT_META.bassHarmonic.params.map((param) => param.id));

/**
 * GROW scene pack (koren-scene-v1): the applied A/B param maps. Unlike the
 * TWIST slots (the node falls back for unknown ids), these are display state —
 * unknown ids are dropped and known ids clamp against the GROW catalog so a
 * hand-edited blob can never surface an out-of-range value in the panel.
 */
function sanitizeKorenSceneState(data: Record<string, unknown>): DeviceState | undefined {
  const rawSlots = (data.slots ?? null) as Record<string, unknown> | null;
  if (typeof rawSlots !== "object" || rawSlots === null || Array.isArray(rawSlots)) return undefined;
  const slots: Record<string, Record<string, number>> = {};
  let hasValidSlot = false;
  for (const slot of ["A", "B"] as const) {
    const raw = rawSlots[slot];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    hasValidSlot = true;
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, DEVICE_STATE_SLOT_KEYS_MAX)) {
      if (
        key.length <= DEVICE_STATE_KEY_MAX &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        KOREN_SCENE_PARAM_IDS.has(key)
      ) {
        clean[key] = clampEffectParam("bassHarmonic", key, value);
      }
    }
    slots[slot] = clean;
  }
  if (!hasValidSlot) return undefined;
  return { kind: "koren-scene-v1", data: { slots } };
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

const PAD_MOD_TARGETS = new Set(["pitch", "gain", "filter"]);
const PAD_MOD_WAVES = new Set(["sine", "triangle", "square", "sawtooth"]);
const PAD_MOD_DEPTH_MAX: Record<string, number> = { pitch: 24, gain: 1, filter: 12000 };
/**
 * Highest pad-LFO rate the normalizer accepts, in Hz. Exported so the Inspector
 * slider cannot drift below the document's own clamp — the slider used to stop
 * at 20 Hz while the model allowed 40, so half the legal range was unreachable.
 */
export const PAD_MOD_RATE_HZ_MAX = 40;

/** Clamp a per-pad mod to a legal voice-local LFO; null = disabled. */
/**
 * Canonical SampleLayer sanitizer (velocity / round-robin zones). Shared by
 * `InstrumentTrack.velocityLayers` and `DrumPad.layers` — one contract, one
 * clamp. Returns undefined when nothing valid remains (field dropped).
 */
export function sanitizeSampleLayers(raw: unknown): import("./types").SampleLayer[] | undefined {
  const rawLayers = Array.isArray(raw) ? raw : [];
  const cleanLayers: import("./types").SampleLayer[] = [];
  for (const rawLayer of rawLayers) {
    const l = (rawLayer ?? {}) as Partial<import("./types").SampleLayer> & Record<string, unknown>;
    const min = typeof l.min === "number" && Number.isFinite(l.min) ? Math.min(1, Math.max(0, l.min)) : NaN;
    const max = typeof l.max === "number" && Number.isFinite(l.max) ? Math.min(1, Math.max(0, l.max)) : NaN;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) continue;
    const minPitch =
      typeof l.minPitch === "number" && Number.isFinite(l.minPitch)
        ? Math.round(Math.max(0, Math.min(127, l.minPitch)))
        : undefined;
    const maxPitch =
      typeof l.maxPitch === "number" && Number.isFinite(l.maxPitch)
        ? Math.round(Math.max(0, Math.min(127, l.maxPitch)))
        : undefined;
    cleanLayers.push({
      id: typeof l.id === "string" && l.id ? l.id : uid("layer"),
      sampleId: typeof l.sampleId === "string" ? l.sampleId : null,
      min,
      max,
      ...(minPitch !== undefined && maxPitch !== undefined ? { minPitch, maxPitch } : {}),
    });
  }
  return cleanLayers.length > 0 ? cleanLayers : undefined;
}

function sanitizePadMod(raw: unknown): import("../project-model/types").PadMod | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const target = typeof m.target === "string" && PAD_MOD_TARGETS.has(m.target) ? m.target : null;
  if (!target) return null;
  const rateHz = typeof m.rateHz === "number" && Number.isFinite(m.rateHz) ? m.rateHz : 0;
  const depthRaw = typeof m.depth === "number" && Number.isFinite(m.depth) ? m.depth : 0;
  const depth = Math.min(PAD_MOD_DEPTH_MAX[target], Math.max(0, Math.abs(depthRaw)));
  if (rateHz <= 0 || depth <= 0) return null;
  const wave = typeof m.wave === "string" && PAD_MOD_WAVES.has(m.wave) ? m.wave : "sine";
  const base =
    target === "filter" && typeof m.base === "number" && Number.isFinite(m.base)
      ? Math.min(16000, Math.max(80, m.base))
      : undefined;
  const out: import("../project-model/types").PadMod = {
    target: target as import("../project-model/types").PadMod["target"],
    wave: wave as import("../project-model/types").PadMod["wave"],
    rateHz: Math.min(PAD_MOD_RATE_HZ_MAX, rateHz),
    depth,
  };
  if (base !== undefined) out.base = base;
  return out;
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

function sanitizeGenerativeConfig(raw: unknown, trackId: string, trackIds: Set<string>): GenerativeTrackConfig {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const safeString = (candidate: unknown, fallback: string, maxLength: number): string =>
    typeof candidate === "string" && candidate.length > 0 && candidate.length <= maxLength ? candidate : fallback;
  const unit = (candidate: unknown, fallback: number): number =>
    typeof candidate === "number" && Number.isFinite(candidate) ? Math.min(1, Math.max(0, candidate)) : fallback;
  const styleValue = value.style && typeof value.style === "object" ? (value.style as Record<string, unknown>) : {};
  const style =
    styleValue.kind === "audio" && typeof styleValue.bufferId === "string" && styleValue.bufferId.length > 0
      ? { kind: "audio" as const, bufferId: styleValue.bufferId.slice(0, 200) }
      : {
          kind: "text" as const,
          text: safeString(styleValue.text, "dark atmospheric accompaniment", 400),
        };
  const sourceId = (candidate: unknown): string | undefined =>
    typeof candidate === "string" && candidate !== trackId && trackIds.has(candidate) ? candidate : undefined;
  const macrosValue = value.macros && typeof value.macros === "object" ? (value.macros as Record<string, unknown>) : {};
  const drumsMode = value.drumsMode === "on" || value.drumsMode === "provider-default" ? value.drumsMode : "off";
  const latencyMode = value.latencyMode === "capture" ? "capture" : "live";
  const seed = typeof value.seed === "string" && value.seed.length <= 200 ? value.seed : undefined;
  const providerVersion =
    typeof value.providerVersion === "string" && value.providerVersion.length <= 120
      ? value.providerVersion
      : undefined;
  const noteSourceTrackId = sourceId(value.noteSourceTrackId);
  const chordSourceTrackId = sourceId(value.chordSourceTrackId);
  const automation = Array.isArray(value.automation)
    ? value.automation
        .map((raw): GenerativeMacroAutomation | null => {
          if (!raw || typeof raw !== "object") return null;
          const candidate = raw as Record<string, unknown>;
          const macro = candidate.macro;
          if (macro !== "energy" && macro !== "density" && macro !== "variation" && macro !== "texture") return null;
          if (!Array.isArray(candidate.points)) return null;
          const points = candidate.points
            .map((point) => {
              if (!point || typeof point !== "object") return null;
              const entry = point as Record<string, unknown>;
              const tick = Number(entry.tick);
              const pointValue = Number(entry.value);
              if (!Number.isFinite(tick) || !Number.isFinite(pointValue)) return null;
              return {
                tick: Math.max(0, Math.min(1_000_000_000, Math.round(tick))),
                value: Math.min(1, Math.max(0, pointValue)),
              };
            })
            .filter((point): point is { tick: number; value: number } => point !== null)
            .sort((a, b) => a.tick - b.tick);
          if (points.length === 0) return null;
          const id =
            typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id.slice(0, 200) : uid("genAuto");
          return { id, macro: macro as GenerativeMacroName, points };
        })
        .filter((lane): lane is GenerativeMacroAutomation => lane !== null)
    : [];
  return {
    providerId: safeString(value.providerId, "mrt2", 80),
    modelId: safeString(value.modelId, "mrt2_small", 120),
    style,
    ...(noteSourceTrackId ? { noteSourceTrackId } : {}),
    ...(chordSourceTrackId ? { chordSourceTrackId } : {}),
    drumsMode,
    macros: {
      energy: unit(macrosValue.energy, 0.5),
      density: unit(macrosValue.density, 0.35),
      variation: unit(macrosValue.variation, 0.25),
      texture: unit(macrosValue.texture, 0.5),
    },
    ...(automation.length > 0 ? { automation } : {}),
    ...(seed !== undefined ? { seed } : {}),
    latencyMode,
    ...(providerVersion !== undefined ? { providerVersion } : {}),
  };
}

function normalizeTracksDomain(s: NormalizeState): void {
  const doc = s.doc;
  const trackIds = new Set(doc.tracks.map((t) => t.id));
  let tracksChanged = false;
  // Sends entries are numbers keyed by return-track id. Content from a
  // hostile doc (collab peer, corrupted import) is filtered to safe keys
  // with finite numeric values — setter-trap keys (__proto__ etc.) and
  // non-numeric garbage are dropped. Values are clamped on write.
  const sanitizeSends = (sends: Record<string, number>): Record<string, number> => {
    const clean: Record<string, number> = {};
    let changed = false;
    for (const [k, v] of Object.entries(sends)) {
      if (["__proto__", "constructor", "prototype"].includes(k) || !/^[A-Za-z0-9_-]{1,64}$/.test(k)) {
        changed = true;
        continue;
      }
      if (typeof v !== "number" || !Number.isFinite(v)) {
        changed = true;
        continue;
      }
      // Clamp on READ too: "clamped on write" held only for the command
      // boundary — a hostile/legacy doc with sends: { ret: 42 } reached the
      // engine unclamped (+52 dB into the FX bus). Range mirrors the
      // setTrackSend command clamp (sends above unity up to +3.5 dB legal).
      const clamped = Math.min(1.5, Math.max(0, v));
      if (clamped !== v) changed = true;
      clean[k] = clamped;
    }
    return changed ? clean : sends;
  };
  const tracks = doc.tracks.map(
    (track): DrumTrack | InstrumentTrack | GenerativeTrack | import("../project-model/types").GroupTrack => {
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
          const sliceLoop =
            typeof (pad as unknown as Record<string, unknown>).sliceLoop === "boolean"
              ? ((pad as unknown as { sliceLoop?: unknown }).sliceLoop as boolean)
              : undefined;
          const rawLoopStart = (pad as unknown as Record<string, unknown>).sliceLoopStart;
          const rawLoopEnd = (pad as unknown as Record<string, unknown>).sliceLoopEnd;
          const sliceLoopStart =
            typeof rawLoopStart === "number" && Number.isFinite(rawLoopStart) && rawLoopStart >= 0
              ? rawLoopStart
              : undefined;
          const sliceLoopEnd =
            typeof rawLoopEnd === "number" && Number.isFinite(rawLoopEnd) && rawLoopEnd >= 0 ? rawLoopEnd : undefined;

          const padColor = sanitizeColor((pad as unknown as Record<string, unknown>).color);
          const padColorChanged = padColor !== (pad as unknown as Record<string, unknown>).color;
          // Round-robin / velocity layers (drum-pad variant sets). Sanitized
          // through the shared sample-layer contract; empty → field dropped.
          const rawPadLayers: unknown = (pad as unknown as Record<string, unknown>).layers;
          const sanePadLayers = rawPadLayers !== undefined ? sanitizeSampleLayers(rawPadLayers) : undefined;
          const padLayersChanged = rawPadLayers !== undefined && !jsonEqual(sanePadLayers, rawPadLayers);
          // Per-pad mod (voice-local LFO) sanitization — null = disabled/off
          const rawMod: unknown = (pad as unknown as Record<string, unknown>).mod;
          const saneMod = rawMod !== undefined ? sanitizePadMod(rawMod) : undefined;
          const modChanged = rawMod !== undefined && !jsonEqual(saneMod, rawMod ?? null);
          const loopChanged =
            sliceLoop !== (pad as unknown as { sliceLoop?: unknown }).sliceLoop ||
            sliceLoopStart !== (pad as unknown as { sliceLoopStart?: unknown }).sliceLoopStart ||
            sliceLoopEnd !== (pad as unknown as { sliceLoopEnd?: unknown }).sliceLoopEnd;
          if (loopChanged) {
            nextPad = {
              ...nextPad,
              sliceLoop: sliceLoop ?? undefined,
              sliceLoopStart: sliceLoopStart ?? undefined,
              sliceLoopEnd: sliceLoopEnd ?? undefined,
            } as typeof pad;
            padChanged = true;
          }

          if (padColorChanged) {
            nextPad = { ...nextPad, color: padColor } as typeof pad;
            padChanged = true;
          }
          if (!hasSliceConfig && !hasSynth) {
            const earlyLoopChanged =
              sliceLoop !== (pad as unknown as { sliceLoop?: unknown }).sliceLoop ||
              sliceLoopStart !== (pad as unknown as { sliceLoopStart?: unknown }).sliceLoopStart ||
              sliceLoopEnd !== (pad as unknown as { sliceLoopEnd?: unknown }).sliceLoopEnd;
            if (!padColorChanged && !earlyLoopChanged && !modChanged && !padLayersChanged) return pad;
            return {
              ...pad,
              color: padColor,
              sliceLoop: sliceLoop ?? undefined,
              sliceLoopStart: sliceLoopStart ?? undefined,
              sliceLoopEnd: sliceLoopEnd ?? undefined,
              ...(modChanged ? { mod: saneMod } : {}),
              ...(padLayersChanged ? { layers: sanePadLayers } : {}),
            };
          }
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
                    : type === "hatClosed"
                      ? 7500
                      : type === "hatOpen"
                        ? 7000
                        : type === "snare"
                          ? 1750
                          : 5000;
                const snap =
                  typeof obj.snap === "number" && Number.isFinite(obj.snap) ? Math.min(1, Math.max(0, obj.snap)) : 0.35;
                const body =
                  typeof obj.body === "number" && Number.isFinite(obj.body) ? Math.min(1, Math.max(0, obj.body)) : 0.5;
                const nextSynth: any = { type, decay, tone, snap, body };
                if (!jsonEqual(nextSynth, (pad as any).synth)) {
                  nextPad = { ...nextPad, synth: nextSynth } as any;
                  padChanged = true;
                }
              }
            } else {
              nextPad = { ...nextPad, synth: null } as any;
              padChanged = true;
            }
          }
          // Per-pad mod sanitization (already computed above for the early-return path)
          if (modChanged) {
            nextPad = { ...nextPad, mod: saneMod } as any;
            padChanged = true;
          }
          if (padLayersChanged) {
            nextPad = { ...nextPad, layers: sanePadLayers } as any;
            padChanged = true;
          }
          return padChanged ? nextPad : pad;
        });
        if (pads.some((pad, index) => pad !== t.pads[index])) {
          t = { ...t, pads };
          tracksChanged = true;
        }
        const normalizedEffects = normalizeEffects(t.effects, t.id, trackIds);
        if (t.effects === undefined || !jsonEqual(normalizedEffects, t.effects)) {
          t = { ...t, effects: normalizedEffects } as DrumTrack;
          tracksChanged = true;
        }
        const cleanSends = sanitizeSends(t.sends ?? {});
        if (t.sends === undefined || cleanSends !== t.sends) {
          t = { ...t, sends: cleanSends } as DrumTrack;
          tracksChanged = true;
        }
        // Validate groupId reference
        if (t.groupId !== undefined && !trackIds.has(t.groupId)) {
          t = { ...t, groupId: undefined } as DrumTrack;
          tracksChanged = true;
        }
        const cleanColor = sanitizeColor((t as unknown as Record<string, unknown>).color);
        if (cleanColor !== (t as unknown as Record<string, unknown>).color) {
          if (cleanColor === undefined) {
            const { color: _c, ...rest } = t as unknown as Record<string, unknown>;
            t = rest as unknown as DrumTrack;
          } else t = { ...t, color: cleanColor } as unknown as DrumTrack;
          tracksChanged = true;
        }
        return t;
      }
      if (track.kind === "generative") {
        let t: GenerativeTrack = track;
        const generative = sanitizeGenerativeConfig(t.generative, t.id, trackIds);
        if (!jsonEqual(generative, t.generative)) {
          t = { ...t, generative };
          tracksChanged = true;
        }
        const normalizedEffects = normalizeEffects(t.effects ?? [], t.id, trackIds);
        if (t.effects === undefined || !jsonEqual(normalizedEffects, t.effects)) {
          t = { ...t, effects: normalizedEffects };
          tracksChanged = true;
        }
        const cleanSends = sanitizeSends(t.sends ?? {});
        if (t.sends === undefined || cleanSends !== t.sends) {
          t = { ...t, sends: cleanSends };
          tracksChanged = true;
        }
        if (t.groupId !== undefined && !trackIds.has(t.groupId)) {
          t = { ...t, groupId: undefined };
          tracksChanged = true;
        }
        const cleanColor = sanitizeColor((t as unknown as Record<string, unknown>).color);
        if (cleanColor !== (t as unknown as Record<string, unknown>).color) {
          if (cleanColor === undefined) {
            const { color: _c, ...rest } = t as unknown as Record<string, unknown>;
            t = rest as unknown as GenerativeTrack;
          } else t = { ...t, color: cleanColor };
          tracksChanged = true;
        }
        return t;
      }
      if (track.kind === "group") {
        let t = track;
        // Frozen state on a group is a historical inconsistency: the renderer
        // cannot include group children, so the persisted buffer is silence
        // and the flag saves no CPU. Strip it (the children simply play live
        // again — the migration path for projects frozen before the guard).
        if ("frozen" in (t as unknown as Record<string, unknown>)) {
          const { frozen: _frozen, ...rest } = t as unknown as Record<string, unknown>;
          t = rest as unknown as import("./types").GroupTrack;
          tracksChanged = true;
        }
        const normalizedEffects = normalizeEffects(t.effects, t.id, trackIds);
        if (t.effects === undefined || !jsonEqual(normalizedEffects, t.effects)) {
          t = { ...t, effects: normalizedEffects };
          tracksChanged = true;
        }
        const groupCleanSends = sanitizeSends(t.sends ?? {});
        if (t.sends === undefined || groupCleanSends !== t.sends) {
          t = { ...t, sends: groupCleanSends };
          tracksChanged = true;
        }
        const groupCleanColor = sanitizeColor((t as unknown as Record<string, unknown>).color);
        if (groupCleanColor !== (t as unknown as Record<string, unknown>).color) {
          if (groupCleanColor === undefined) {
            const { color: _c, ...rest } = t as unknown as Record<string, unknown>;
            t = rest as unknown as import("./types").GroupTrack;
          } else t = { ...t, color: groupCleanColor };
          tracksChanged = true;
        }
        // collapsed — boolean, absent = expanded
        if (
          typeof (t as unknown as Record<string, unknown>).collapsed !== "boolean" &&
          (t as unknown as Record<string, unknown>).collapsed !== undefined
        ) {
          const { collapsed: _c, ...rest } = t as unknown as Record<string, unknown>;
          t = rest as unknown as import("./types").GroupTrack;
          tracksChanged = true;
        }
        return t;
      }
      // instrument: merge params with defaults only when keys are missing.
      // An unknown/missing instrument kind must HEAL, not throw — normalize
      // promises never to throw, and a hostile doc (collab peer, corrupted
      // import) previously crashed the whole sync path here.
      const knownInstrument =
        typeof track.instrument === "string" && Object.prototype.hasOwnProperty.call(INSTRUMENT_META, track.instrument);
      const instrument = knownInstrument
        ? track.instrument
        : (Object.keys(INSTRUMENT_META)[0] as InstrumentTrack["instrument"]);
      const defaults = defaultInstrumentParams(instrument);
      let t: InstrumentTrack = track;
      let paramsChanged = false;
      if (instrument !== track.instrument) {
        t = { ...track, instrument };
        tracksChanged = true;
      }
      const merged: Record<string, number> = { ...defaults };
      const paramsRecord: Record<string, number> = track.params ?? {};
      const SAFE_PARAM_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
      const isSafeKey = (k: string): boolean =>
        SAFE_PARAM_KEY.test(k) && !["__proto__", "constructor", "prototype"].includes(k);
      for (const k of Object.keys(defaults)) {
        const v = paramsRecord[k];
        if (typeof v === "number" && Number.isFinite(v)) {
          // Known keys clamp at load — the same contract normalizeEffects
          // enforces for effect params. A hostile/corrupt doc (collab peer,
          // import) with cutoff 1e308 or a non-number reached the voice
          // runtime raw: instrument factories clamp some params inline but
          // not all, and a non-finite value makes setTargetAtTime throw
          // mid-sync, killing the whole graph update.
          const clamped = clampInstrumentParam(instrument, k, v);
          if (clamped !== v) paramsChanged = true;
          merged[k] = clamped;
        } else {
          // Missing or non-numeric → the default already in `merged` stands.
          paramsChanged = true;
        }
      }
      // Backfill any keys present in the track params but missing from defaults.
      // Unknown keys may only ride along as finite numbers — arbitrary keys or
      // non-numeric values from a hostile doc are dropped, and so are setter
      // traps like __proto__ (they'd land on params via plain assignment).
      for (const k of Object.keys(paramsRecord)) {
        if (
          merged[k] === undefined &&
          isSafeKey(k) &&
          typeof paramsRecord[k] === "number" &&
          Number.isFinite(paramsRecord[k])
        ) {
          merged[k] = paramsRecord[k];
          paramsChanged = true;
        }
      }
      if (paramsChanged) {
        // Spread `t` (not `track`) so an instrument heal above survives.
        t = { ...t, params: merged };
        tracksChanged = true;
      }
      const normalizedEffects = normalizeEffects(t.effects, t.id, trackIds);
      if (t.effects === undefined || !jsonEqual(normalizedEffects, t.effects)) {
        t = { ...t, effects: normalizedEffects };
        tracksChanged = true;
      }
      const instCleanSends = sanitizeSends(t.sends ?? {});
      if (t.sends === undefined || instCleanSends !== t.sends) {
        t = { ...t, sends: instCleanSends };
        tracksChanged = true;
      }
      // Validate groupId reference
      if (t.groupId !== undefined && !trackIds.has(t.groupId)) {
        t = { ...t, groupId: undefined };
        tracksChanged = true;
      }
      // Velocity/round-robin layers: keep well-formed zones only; drop the
      // field entirely when nothing valid remains (classic single-sample mode)
      if (t.velocityLayers !== undefined) {
        const canonical = sanitizeSampleLayers(t.velocityLayers);
        if (!jsonEqual(canonical, t.velocityLayers)) {
          t = canonical ? { ...t, velocityLayers: canonical } : t;
          if (!canonical) {
            const { velocityLayers: _vl, ...rest } = t as unknown as Record<string, unknown>;
            t = rest as unknown as InstrumentTrack;
          }
          tracksChanged = true;
        }
      }
      const cleanColorInst = sanitizeColor((t as unknown as Record<string, unknown>).color);
      if (cleanColorInst !== (t as unknown as Record<string, unknown>).color) {
        if (cleanColorInst === undefined) {
          const { color: _c, ...rest } = t as unknown as Record<string, unknown>;
          t = rest as unknown as InstrumentTrack;
        } else t = { ...t, color: cleanColorInst };
        tracksChanged = true;
      }
      return t;
    },
  );
  if (tracksChanged) {
    s.doc = { ...doc, tracks: tracks as ProjectDocument["tracks"] };
    s.changed = true;
  }
  // Mixer params (Audit 04): every track kind carries gain/pan/mute/solo,
  // but the per-kind sanitizers above never touched them. A hostile doc with
  // gain: 999 blasted ~+60 dB through the engine, and a NON-FINITE gain made
  // setTargetAtTime THROW mid-syncProject — aborting the whole graph sync
  // and leaving audio permanently desynced from the UI. When every track is
  // already clean the ORIGINAL array reference must survive — canonicality
  // (normalize == identity) and structural sharing for the React slices
  // depend on it; an unconditional .map broke both.
  const current = s.doc;
  let mixerChanged = false;
  const mixerSafe = current.tracks.map((t) => {
    const gain = typeof t.gain === "number" && Number.isFinite(t.gain) ? Math.min(1.5, Math.max(0, t.gain)) : 0.9;
    const pan = typeof t.pan === "number" && Number.isFinite(t.pan) ? Math.min(1, Math.max(-1, t.pan)) : 0;
    const mute = t.mute === true;
    const solo = t.solo === true;
    if (gain === t.gain && pan === t.pan && mute === t.mute && solo === t.solo) return t;
    mixerChanged = true;
    return { ...t, gain, pan, mute, solo };
  });
  if (mixerChanged) {
    s.doc = { ...current, tracks: mixerSafe };
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
  const scenesById = new Map(doc.scenes.map((scene) => [scene.id, scene] as const));
  const patternsById = new Map(doc.patterns.map((pattern) => [pattern.id, pattern] as const));
  const trackIds = new Set(doc.tracks.map((t) => t.id));
  let arrangement = doc.arrangement;
  if (arrangement === undefined || arrangement === null) {
    s.doc = { ...doc, arrangement: { clips: [] } };
    s.changed = true;
    return;
  }
  const rawClips = Array.isArray(arrangement.clips) ? arrangement.clips : [];
  const sorted = [...rawClips]
    // MAX_ARRANGEMENT_CLIP_BARS on load as well as on resize: a project file
    // (imported, hand-edited or corrupted) could otherwise reintroduce the
    // unbounded length that froze the arrangement view.
    .filter(
      (c) =>
        sceneIds.has(c.sceneId) &&
        Number.isFinite(c.startBar) &&
        c.startBar >= 0 &&
        Number.isFinite(c.lengthBars) &&
        c.lengthBars > 0 &&
        c.lengthBars <= MAX_ARRANGEMENT_CLIP_BARS,
    )
    .map((clip) => {
      const scene = scenesById.get(clip.sceneId);
      const pattern = scene ? patternsById.get(scene.patternId) : undefined;
      const patternTicks = pattern ? pattern.stepCount * STEP_TICKS : 0;
      const source = clip as ArrangementClip & { phaseOffsetTicks?: unknown; sceneOffsetTicks?: unknown };
      const rawPhase = source.phaseOffsetTicks;
      const rawSceneOffset = source.sceneOffsetTicks;
      const phase = typeof rawPhase === "number" && Number.isFinite(rawPhase) && rawPhase >= 0 ? rawPhase : 0;
      const normalizedPhase = patternTicks > 0 ? phase % patternTicks : phase;
      const sceneOffset =
        typeof rawSceneOffset === "number" && Number.isFinite(rawSceneOffset) && rawSceneOffset >= 0
          ? Math.min(rawSceneOffset, MAX_ARRANGEMENT_CLIP_BARS * BAR_TICKS)
          : 0;
      const phaseChanged = normalizedPhase > 1e-9 ? rawPhase !== normalizedPhase : rawPhase !== undefined;
      const sceneOffsetChanged = sceneOffset > 1e-9 ? rawSceneOffset !== sceneOffset : rawSceneOffset !== undefined;
      // Clip lock (v15): stored only when true.
      const rawLocked = (clip as { locked?: unknown }).locked;
      const lockedChanged = rawLocked !== undefined && rawLocked !== true;
      if (!phaseChanged && !sceneOffsetChanged && !lockedChanged) return clip;
      const normalized: ArrangementClip = { ...clip };
      if (normalizedPhase > 1e-9) normalized.phaseOffsetTicks = normalizedPhase;
      else delete normalized.phaseOffsetTicks;
      if (sceneOffset > 1e-9) normalized.sceneOffsetTicks = sceneOffset;
      else delete normalized.sceneOffsetTicks;
      if (lockedChanged) delete normalized.locked;
      return normalized;
    })
    .sort((a, b) => a.startBar - b.startBar);
  const rawMidiClips = (arrangement as unknown as Record<string, unknown>).midiClips;
  const instrumentTrackIds = new Set(
    doc.tracks.filter((track) => track.kind === "instrument").map((track) => track.id),
  );
  const midiClips = Array.isArray(rawMidiClips)
    ? (rawMidiClips as Partial<MidiClip>[])
        .filter((clip) => {
          if (
            typeof clip?.id !== "string" ||
            clip.id === "" ||
            typeof clip.trackId !== "string" ||
            !instrumentTrackIds.has(clip.trackId) ||
            typeof clip.patternId !== "string" ||
            !patternsById.has(clip.patternId) ||
            !Number.isFinite(clip.startTick) ||
            !Number.isFinite(clip.lengthTicks)
          )
            return false;
          const startTick = Math.round(clip.startTick!);
          const lengthTicks = Math.round(clip.lengthTicks!);
          return (
            startTick >= 0 &&
            lengthTicks > 0 &&
            startTick <= MAX_ARRANGEMENT_CLIP_TICKS &&
            lengthTicks <= MAX_ARRANGEMENT_CLIP_TICKS &&
            startTick + lengthTicks <= MAX_ARRANGEMENT_CLIP_TICKS
          );
        })
        .map((clip) => {
          const pattern = patternsById.get(clip.patternId!);
          const patternTicks = pattern ? pattern.stepCount * STEP_TICKS : 0;
          const startTick = Math.round(clip.startTick!);
          const lengthTicks = Math.round(clip.lengthTicks!);
          const rawPhase = clip.phaseOffsetTicks;
          const phase = typeof rawPhase === "number" && Number.isFinite(rawPhase) ? Math.max(0, rawPhase) : 0;
          const phaseOffsetTicks = patternTicks > 0 ? Math.round(phase) % patternTicks : 0;
          return {
            id: clip.id!,
            trackId: clip.trackId!,
            patternId: clip.patternId!,
            startTick,
            lengthTicks,
            ...(phaseOffsetTicks > 0 ? { phaseOffsetTicks } : {}),
            ...(clip.muted === true ? { muted: true } : {}),
            ...(clip.locked === true ? { locked: true } : {}),
          } satisfies MidiClip;
        })
        .sort((a, b) => a.startTick - b.startTick || a.id.localeCompare(b.id))
    : undefined;
  const midiClipsChanged = !jsonEqual(midiClips, rawMidiClips);
  const rawAutomationClips = (arrangement as unknown as Record<string, unknown>).automationClips;
  const automationClips = Array.isArray(rawAutomationClips)
    ? (rawAutomationClips as Partial<ArrangementAutomationClip>[])
        .filter((clip) => {
          if (
            typeof clip?.id !== "string" ||
            clip.id === "" ||
            !clip.target ||
            !isAutomationTargetValid(doc, clip.target) ||
            !Number.isFinite(clip.startTick) ||
            !Number.isFinite(clip.lengthTicks)
          )
            return false;
          const startTick = Math.round(clip.startTick!);
          const lengthTicks = Math.round(clip.lengthTicks!);
          return (
            startTick >= 0 &&
            lengthTicks > 0 &&
            startTick <= MAX_ARRANGEMENT_CLIP_TICKS &&
            lengthTicks <= MAX_ARRANGEMENT_CLIP_TICKS &&
            startTick + lengthTicks <= MAX_ARRANGEMENT_CLIP_TICKS
          );
        })
        .map((clip) => {
          const startTick = Math.round(clip.startTick!);
          const lengthTicks = Math.round(clip.lengthTicks!);
          const rawPhase = clip.phaseOffsetTicks;
          const phaseOffsetTicks =
            typeof rawPhase === "number" && Number.isFinite(rawPhase)
              ? Math.max(0, Math.min(MAX_ARRANGEMENT_CLIP_TICKS - lengthTicks, Math.round(rawPhase)))
              : 0;
          const points: AutomationPoint[] = Array.isArray(clip.points)
            ? clip.points
                .filter(
                  (point): point is AutomationPoint =>
                    Boolean(point) && Number.isFinite(point.tick) && Number.isFinite(point.value),
                )
                .slice(0, 16384)
                .map((point) => ({
                  tick: Math.max(0, Math.min(MAX_ARRANGEMENT_CLIP_TICKS, Math.round(point.tick))),
                  value: clampTargetValue(doc, clip.target!, point.value),
                }))
                .sort((a, b) => a.tick - b.tick)
            : [];
          const linkedTargets: AutomationTarget[] = [];
          const linkedTargetKeys = new Set([automationTargetKey(clip.target!)]);
          if (Array.isArray(clip.linkedTargets)) {
            for (const target of clip.linkedTargets) {
              if (!target || !isAutomationTargetValid(doc, target)) continue;
              const key = automationTargetKey(target);
              if (linkedTargetKeys.has(key)) continue;
              linkedTargetKeys.add(key);
              linkedTargets.push({ ...target });
            }
          }
          return {
            id: clip.id!,
            target: { ...clip.target! },
            startTick,
            lengthTicks,
            points,
            ...(linkedTargets.length > 0 ? { linkedTargets } : {}),
            ...(phaseOffsetTicks > 0 ? { phaseOffsetTicks } : {}),
            ...(clip.muted === true ? { muted: true } : {}),
            ...(clip.locked === true ? { locked: true } : {}),
          } satisfies ArrangementAutomationClip;
        })
        .sort((a, b) => a.startTick - b.startTick || a.id.localeCompare(b.id))
    : undefined;
  const automationClipsChanged = !jsonEqual(automationClips, rawAutomationClips);
  const transitions = sanitizeArrangementTransitions(arrangement.transitions, sorted);
  const sanitizedAudioClips = sanitizeAudioClips(
    (arrangement as unknown as Record<string, unknown>).audioClips,
    trackIds,
    s.doc.bpm,
    (startBar, lengthBars) => {
      const spt =
        60 /
        (tempoAtTick(
          s.doc.arrangement.clips,
          s.doc.scenes,
          startBar * ticksPerBar(s.doc),
          s.doc.bpm,
          ticksPerBar(s.doc),
        ) *
          PPQ);
      return lengthBars * ticksPerBar(s.doc) * spt;
    },
    ticksPerBar(s.doc),
  );
  const takeGroups = sanitizeAudioTakeGroups(
    (arrangement as unknown as Record<string, unknown>).takeGroups,
    sanitizedAudioClips,
    trackIds,
  );
  const validTakeGroups = new Map((takeGroups ?? []).map((group) => [group.id, group]));
  const liveSetIds = new Set((s.doc.liveSets ?? []).map((set) => set.id));
  const audioClips = sanitizedAudioClips?.map((clip) => {
    // `liveSetId` marks the Live Set pad this clip was launched from, and
    // `livePadSlot` is only meaningful next to it. `sanitizeAudioClips` accepts
    // the pair on SHAPE alone (non-empty string, slot 0-15), so a document that
    // arrived from import / share code / a collab peer kept the pair aimed at a
    // set that does not exist — in every save, with nothing to repair it.
    // `deleteLiveSet` clears it on the command path; this is that path's
    // backstop, same shape as the take-group strip below.
    if (clip.liveSetId !== undefined && !liveSetIds.has(clip.liveSetId)) {
      const unlaunched = { ...clip };
      delete unlaunched.liveSetId;
      delete unlaunched.livePadSlot;
      return unlaunched;
    }
    const group = clip.takeGroupId ? validTakeGroups.get(clip.takeGroupId) : undefined;
    if (!group || group.trackId !== clip.trackId) {
      const ordinaryClip = { ...clip };
      delete ordinaryClip.takeGroupId;
      delete ordinaryClip.takeId;
      delete ordinaryClip.compSourceTakeId;
      return ordinaryClip;
    }
    const compSourceTakeId =
      clip.takeId === group.compTakeId &&
      clip.compSourceTakeId &&
      sanitizedAudioClips?.some(
        (source) =>
          source.takeGroupId === group.id &&
          source.takeId === clip.compSourceTakeId &&
          source.trackId === group.trackId,
      )
        ? clip.compSourceTakeId
        : undefined;
    if (compSourceTakeId === clip.compSourceTakeId) return clip;
    const normalizedClip = { ...clip };
    if (compSourceTakeId) normalizedClip.compSourceTakeId = compSourceTakeId;
    else delete normalizedClip.compSourceTakeId;
    return normalizedClip;
  });
  const clipsChanged = sorted.length !== rawClips.length || sorted.some((clip, index) => clip !== rawClips[index]);
  const transitionsChanged = !jsonEqual(transitions, arrangement.transitions);
  const audioChanged = !jsonEqual(audioClips, (arrangement as unknown as Record<string, unknown>).audioClips);
  const takeGroupsChanged = !jsonEqual(takeGroups, (arrangement as unknown as Record<string, unknown>).takeGroups);
  // Clip groups (v15): membership is clamped to LIVE clips of all four kinds
  // (dead ids stripped, duplicates collapsed), empty groups are dropped — a
  // group dies with its last member. A hand-edited or partially-merged file
  // can never keep a group pointing at nothing.
  const validClipIds = new Set<string>([
    ...sorted.map((clip) => clip.id),
    ...(audioClips ?? []).map((clip) => clip.id),
    ...(midiClips ?? []).map((clip) => clip.id),
    ...(automationClips ?? []).map((clip) => clip.id),
  ]);
  const rawClipGroups = (arrangement as unknown as Record<string, unknown>).clipGroups;
  const clipGroups = Array.isArray(rawClipGroups)
    ? (rawClipGroups as { id?: unknown; name?: unknown; clipIds?: unknown }[])
        .filter((group) => typeof group?.id === "string" && group.id !== "" && Array.isArray(group.clipIds))
        .map((group) => {
          const seen = new Set<string>();
          const clipIds: string[] = [];
          for (const id of group.clipIds as unknown[]) {
            if (typeof id === "string" && validClipIds.has(id) && !seen.has(id)) {
              seen.add(id);
              clipIds.push(id);
            }
          }
          const name = typeof group.name === "string" && group.name.trim() !== "" ? group.name.trim() : undefined;
          return {
            id: group.id as string,
            ...(name ? { name } : {}),
            clipIds,
          };
        })
        .filter((group) => group.clipIds.length > 0)
    : undefined;
  const clipGroupsChanged = !jsonEqual(clipGroups, rawClipGroups);
  // Chord track (v17): whole-bar events; only shape-valid ones survive and
  // they are kept time-sorted. Overlap is a COMMAND-level contract (like
  // scene clips) — normalize deliberately does not drop overlapping chords.
  const rawChords = (arrangement as unknown as Record<string, unknown>).chords;
  const chords = Array.isArray(rawChords)
    ? (
        rawChords as {
          id?: unknown;
          startBar?: unknown;
          lengthBars?: unknown;
          root?: unknown;
          quality?: unknown;
        }[]
      )
        .filter(
          (chord) =>
            typeof chord?.id === "string" &&
            chord.id !== "" &&
            Number.isFinite(chord.startBar as number) &&
            (chord.startBar as number) >= 0 &&
            Number.isFinite(chord.lengthBars as number) &&
            (chord.lengthBars as number) >= 1 &&
            Number.isInteger(chord.startBar as number) &&
            Number.isInteger(chord.lengthBars as number) &&
            Number.isInteger(chord.root as number) &&
            (chord.root as number) >= 0 &&
            (chord.root as number) <= 11 &&
            typeof chord.quality === "string",
        )
        .filter((chord) => CHORD_QUALITIES.includes(chord.quality as never))
        .map((chord) => ({
          id: chord.id as string,
          startBar: chord.startBar as number,
          lengthBars: chord.lengthBars as number,
          root: chord.root as number,
          quality: chord.quality as import("./chords").ChordQuality,
        }))
        .sort((a, b) => a.startBar - b.startBar)
    : undefined;
  const chordsChanged = !jsonEqual(chords, rawChords);
  if (
    clipsChanged ||
    transitionsChanged ||
    audioChanged ||
    midiClipsChanged ||
    automationClipsChanged ||
    takeGroupsChanged ||
    clipGroupsChanged ||
    chordsChanged
  ) {
    s.doc = {
      ...doc,
      arrangement: {
        clips: sorted,
        ...(audioClips ? { audioClips } : {}),
        ...(midiClips ? { midiClips } : {}),
        ...(automationClips ? { automationClips } : {}),
        ...(takeGroups ? { takeGroups } : {}),
        ...(transitions !== undefined ? { transitions } : {}),
        ...(clipGroups ? { clipGroups } : {}),
        ...(chords ? { chords } : {}),
      },
    };
    s.changed = true;
  }
}

/**
 * Phase 3a migration: rewrite automation targets that name deprecated legacy
 * alias ids (eq.midGain…) to their canonical ids (eq.lowMidGain…) BEFORE
 * target validation runs — otherwise old documents silently lost their lanes
 * when the alias stopped being a valid target. Covers every collection that
 * stores AutomationTargets.
 */
function remapDeprecatedAliasTargets(s: NormalizeState): void {
  const doc = s.doc;
  const remap = (target: unknown): unknown =>
    target && typeof target === "object" ? canonicalizeDeprecatedTarget(doc, target as AutomationTarget) : target;
  let changed = false;
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  if (Array.isArray(doc.automation)) {
    for (const lane of doc.automation) {
      if (!lane?.target) continue;
      const next = remap(lane.target);
      if (!eq(next, lane.target)) {
        lane.target = next as typeof lane.target;
        changed = true;
      }
    }
  }
  if (Array.isArray(doc.sceneAutomation)) {
    for (const lane of doc.sceneAutomation) {
      if (!lane?.target) continue;
      const next = remap(lane.target);
      if (!eq(next, lane.target)) {
        lane.target = next as typeof lane.target;
        changed = true;
      }
    }
  }
  if (Array.isArray(doc.lfos)) {
    for (const lfo of doc.lfos) {
      if (!lfo?.target) continue;
      const next = remap(lfo.target);
      if (!eq(next, lfo.target)) {
        lfo.target = next as typeof lfo.target;
        changed = true;
      }
    }
  }
  if (Array.isArray(doc.macros)) {
    for (const macro of doc.macros) {
      if (!Array.isArray(macro?.mappings)) continue;
      for (const mapping of macro.mappings) {
        if (!mapping?.target) continue;
        const next = remap(mapping.target);
        if (!eq(next, mapping.target)) {
          mapping.target = next as typeof mapping.target;
          changed = true;
        }
      }
    }
  }
  const midi = doc.midi as { ccMappings?: { target?: unknown; aftertouchTarget?: unknown }[] } | undefined;
  if (Array.isArray(midi?.ccMappings)) {
    for (const mapping of midi!.ccMappings) {
      if (mapping?.target) {
        const next = remap(mapping.target);
        if (!eq(next, mapping.target)) {
          mapping.target = next;
          changed = true;
        }
      }
      if (mapping?.aftertouchTarget) {
        const next = remap(mapping.aftertouchTarget);
        if (!eq(next, mapping.aftertouchTarget)) {
          mapping.aftertouchTarget = next;
          changed = true;
        }
      }
    }
  }
  if (changed) s.changed = true;
}

function normalizeAutomationDomain(s: NormalizeState): void {
  const doc = s.doc;
  const automation = doc.automation;
  if (!Array.isArray(automation)) {
    s.doc = { ...doc, automation: [] };
    s.changed = true;
    return;
  }
  // Automation targets may point at regular tracks, groups, or return buses.
  // Validate the complete target against the normalized device catalog so a
  // deleted FX/parameter cannot survive as a silent lane after reload/collab.
  const filtered: typeof automation = [];
  for (const lane of automation) {
    if (!lane || typeof lane !== "object" || !lane.target || !isAutomationTargetValid(doc, lane.target)) continue;
    const points = Array.isArray(lane.points)
      ? lane.points
          .filter((point) => point && Number.isFinite(point.tick) && Number.isFinite(point.value))
          .map((point) => ({
            tick: Math.max(0, Math.round(point.tick)),
            value: clampTargetValue(doc, lane.target, point.value),
          }))
          .sort((a, b) => a.tick - b.tick)
      : [];
    filtered.push({ ...lane, points });
  }
  if (!jsonEqual(filtered, automation)) {
    s.doc = { ...doc, automation: filtered };
    s.changed = true;
  }
}

function normalizeLfosDomain(s: NormalizeState): void {
  const doc = s.doc;
  // Returns are valid modulation hosts/sources too. The project-aware target
  // catalog still rejects return-pan and dangling device targets below.
  const trackIds = new Set([...doc.tracks.map((t) => t.id), ...doc.returns.map((ret) => ret.id)]);
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
    // `sanitizeLfo` can only validate the serialized target shape. The
    // project-aware catalog must also reject deleted FX, unknown deep params
    // and return-pan targets, otherwise the UI shows a live-looking LFO that
    // the engine can never resolve.
    const rawTarget = (lfo as unknown as Record<string, unknown>)?.target;
    if (cleaned && rawTarget !== undefined && !cleaned.target) {
      sanitized.pop();
      continue;
    }
    if (cleaned?.target && !isAutomationTargetValid(doc, cleaned.target)) {
      sanitized.pop();
    }
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
      // Generic mappings are references, not free-form strings. Drop a
      // dangling target at load time instead of leaving an inert macro that
      // looks healthy in the UI. Legacy VOL/PAN mappings remain compatible.
      if (sanitized.target && !isAutomationTargetValid(doc, sanitized.target)) continue;
      if (!sanitized.target) {
        const owner = targetOwner(doc, sanitized.trackId);
        if (!owner || (sanitized.param !== "gain" && sanitized.param !== "pan")) continue;
        if (owner.kind === "return" && sanitized.param === "pan") continue;
      }
      if (
        sanitized.id !== mapping.id ||
        sanitized.trackId !== mapping.trackId ||
        sanitized.param !== mapping.param ||
        sanitized.amount !== mapping.amount ||
        sanitized.source !== (mapping.source ?? "macro") ||
        !jsonEqual(sanitized.target, mapping.target)
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
    // Scene tempo: absent = follow project; present = clamped to 40..240 BPM.
    let bpm: number | undefined;
    if (typeof scene.bpm === "number" && Number.isFinite(scene.bpm)) {
      bpm = Math.min(240, Math.max(40, Math.round(scene.bpm)));
      if (bpm !== scene.bpm) sceneChanged = true;
    } else if (scene.bpm !== undefined) {
      sceneChanged = true;
    }
    if (sceneChanged) scenesChanged = true;
    if (!sceneChanged) return scene;
    return { ...scene, intensity, intensityCurve: curve, loop, role, bpm };
  });

  // Scene pack selections (v23): fxId → pair id. Shape-only cleanup — pair
  // ids are matched against the packs at use time, so an unknown id is
  // dropped by the engine instead of corrupting playback.
  let packsChanged = false;
  const packedScenes = cleanedScenes.map((scene) => {
    if (scene.packs === undefined) return scene;
    const raw = scene.packs as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      packsChanged = true;
      return { ...scene, packs: undefined };
    }
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 64)) {
      if (typeof value === "string" && value.length > 0 && value.length <= 64 && key.length > 0 && key.length <= 64) {
        clean[key] = value;
      }
    }
    const next = Object.keys(clean).length > 0 ? clean : undefined;
    if (JSON.stringify(next) !== JSON.stringify(scene.packs)) {
      packsChanged = true;
      return { ...scene, packs: next };
    }
    return scene;
  });
  if (packsChanged) {
    s.doc = { ...s.doc, scenes: packedScenes };
    s.changed = true;
  }

  // Scene macro pins (v24): macroId → 0..1. Clamped here; macro existence is
  // matched at use time (an unknown id is inert, like the pair ids).
  let macrosChanged = false;
  const macroScenes = packedScenes.map((scene) => {
    if (scene.macros === undefined) return scene;
    const raw = scene.macros as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      macrosChanged = true;
      return { ...scene, macros: undefined };
    }
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 64)) {
      if (typeof value === "number" && Number.isFinite(value) && key.length > 0 && key.length <= 64) {
        clean[key] = Math.min(1, Math.max(0, value));
      }
    }
    const next = Object.keys(clean).length > 0 ? clean : undefined;
    if (JSON.stringify(next) !== JSON.stringify(scene.macros)) {
      macrosChanged = true;
      return { ...scene, macros: next };
    }
    return scene;
  });
  if (macrosChanged) {
    s.doc = { ...s.doc, scenes: macroScenes };
    s.changed = true;
  }

  // Scene CC remap allow-lists (v25): string ids, deduped. An EMPTY array is
  // meaningful ("none armed") and survives; a non-array is dropped; an array
  // with only invalid entries falls back to undefined (= all armed), so a
  // corrupt blob can never silently disarm every mapping.
  let ccChanged = false;
  const ccScenes = macroScenes.map((scene) => {
    if (scene.ccRemaps === undefined) return scene;
    const raw = scene.ccRemaps as unknown;
    if (!Array.isArray(raw)) {
      ccChanged = true;
      return { ...scene, ccRemaps: undefined };
    }
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const value of raw.slice(0, 64)) {
      if (typeof value === "string" && value.length > 0 && value.length <= 64 && !seen.has(value)) {
        seen.add(value);
        clean.push(value);
      }
    }
    const next = raw.length === 0 ? [] : clean.length > 0 ? clean : undefined;
    if (JSON.stringify(next) !== JSON.stringify(scene.ccRemaps)) {
      ccChanged = true;
      return { ...scene, ccRemaps: next };
    }
    return scene;
  });
  if (ccChanged) {
    s.doc = { ...s.doc, scenes: ccScenes };
    s.changed = true;
  }

  // Scene CC re-points (v29): mappingId → { ccNumber (0..127), channel
  // (1..16) }. Entries with neither field (after sanitizing) drop; the
  // record collapses to absent when empty. Unknown mapping ids stay inert.
  let ccOverrideChanged = false;
  const ccOverrideScenes = ccScenes.map((scene) => {
    if (scene.ccOverrides === undefined) return scene;
    const raw = scene.ccOverrides as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      ccOverrideChanged = true;
      return { ...scene, ccOverrides: undefined };
    }
    const clean: Record<string, { ccNumber?: number; channel?: number }> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 64)) {
      if (key.length === 0 || key.length > 64) continue;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const next: { ccNumber?: number; channel?: number } = {};
      if (
        typeof entry.ccNumber === "number" &&
        Number.isFinite(entry.ccNumber) &&
        Number.isInteger(entry.ccNumber) &&
        entry.ccNumber >= 0 &&
        entry.ccNumber <= 127
      ) {
        next.ccNumber = entry.ccNumber;
      }
      if (
        typeof entry.channel === "number" &&
        Number.isFinite(entry.channel) &&
        Number.isInteger(entry.channel) &&
        entry.channel >= 1 &&
        entry.channel <= 16
      ) {
        next.channel = entry.channel;
      }
      if (next.ccNumber !== undefined || next.channel !== undefined) clean[key] = next;
    }
    const next = Object.keys(clean).length > 0 ? clean : undefined;
    if (JSON.stringify(next) !== JSON.stringify(scene.ccOverrides)) {
      ccOverrideChanged = true;
      return { ...scene, ccOverrides: next };
    }
    return scene;
  });
  if (ccOverrideChanged) {
    s.doc = { ...s.doc, scenes: ccOverrideScenes };
    s.changed = true;
  }

  // Scene modulator patterns (v31): lfoId → { steps (≤64 bipolar values),
  // seed (≤64 chars) }. Entries with neither field drop; the record
  // collapses to absent when empty. Unknown lfo ids stay inert.
  let modulatorsChanged = false;
  const modulatorScenes = ccOverrideScenes.map((scene) => {
    if (scene.modulators === undefined) return scene;
    const raw = scene.modulators as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      modulatorsChanged = true;
      return { ...scene, modulators: undefined };
    }
    const clean: Record<string, { steps?: number[]; seed?: string }> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 32)) {
      if (key.length === 0 || key.length > 64) continue;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const next: { steps?: number[]; seed?: string } = {};
      if (Array.isArray(entry.steps)) {
        const steps = entry.steps
          .slice(0, 64)
          .filter((step): step is number => typeof step === "number" && Number.isFinite(step))
          .map((step) => Math.min(1, Math.max(-1, step)));
        if (steps.length > 0) next.steps = steps;
      }
      if (typeof entry.seed === "string" && entry.seed.length > 0 && entry.seed.length <= 64) {
        next.seed = entry.seed;
      }
      if (next.steps !== undefined || next.seed !== undefined) clean[key] = next;
    }
    const next = Object.keys(clean).length > 0 ? clean : undefined;
    if (JSON.stringify(next) !== JSON.stringify(scene.modulators)) {
      modulatorsChanged = true;
      return { ...scene, modulators: next };
    }
    return scene;
  });
  if (modulatorsChanged) {
    s.doc = { ...s.doc, scenes: modulatorScenes };
    s.changed = true;
  }

  if (scenesChanged) {
    s.doc = { ...s.doc, scenes: modulatorScenes };
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

/** Schema v3 — Remix-DNA family link. Invalid shapes are dropped (the beat
 * stays loadable); valid ones are rebuilt canonically so equivalent links
 * compare equal. Never throws. */
export const LINEAGE_ID_MAX = 128;
export const LINEAGE_TEXT_MAX = 160;
export const LINEAGE_DEPTH_MAX = 1000;

export function sanitizeLineage(value: unknown): ProjectLineage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.rootId !== "string" || v.rootId.trim() === "" || v.rootId.length > LINEAGE_ID_MAX) {
    return undefined;
  }
  const parentId =
    v.parentId === null || v.parentId === undefined
      ? null
      : typeof v.parentId === "string" && v.parentId.trim() !== "" && v.parentId.length <= LINEAGE_ID_MAX
        ? v.parentId
        : null;
  const depth =
    typeof v.depth === "number" && Number.isInteger(v.depth) && v.depth >= 0 && v.depth <= LINEAGE_DEPTH_MAX
      ? v.depth
      : 0;
  const prompt = typeof v.prompt === "string" && v.prompt.trim() !== "" ? v.prompt.slice(0, LINEAGE_TEXT_MAX) : null;
  const seed = typeof v.seed === "string" && v.seed !== "" && v.seed.length <= LINEAGE_ID_MAX ? v.seed : null;
  return { parentId, rootId: v.rootId, depth, prompt, seed };
}

function normalizeLineageDomain(s: NormalizeState): void {
  const doc = s.doc;
  if (doc.lineage === undefined) return;
  const cleaned = sanitizeLineage(doc.lineage);
  if (cleaned === undefined) {
    const rest = { ...doc };
    delete rest.lineage;
    s.doc = rest;
    s.changed = true;
    return;
  }
  if (!jsonEqual(cleaned, doc.lineage)) {
    s.doc = { ...doc, lineage: cleaned };
    s.changed = true;
  }
}

function normalizeProducerBriefDomain(s: NormalizeState): void {
  const doc = s.doc;
  if (doc.producerBrief === undefined) return;
  const cleaned = sanitizeProjectProducerBrief(doc.producerBrief);
  if (cleaned === undefined) {
    const rest = { ...doc };
    delete rest.producerBrief;
    s.doc = rest;
    s.changed = true;
    return;
  }
  if (!jsonEqual(cleaned, doc.producerBrief)) {
    s.doc = { ...doc, producerBrief: cleaned };
    s.changed = true;
  }
}

function sanitizeProjectTransferOrigin(value: unknown): ProjectTransferOriginV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const origin = value as Record<string, unknown>;
  if (origin.version !== 1 || origin.kind !== "aligned-audio-midi") return undefined;
  if (!["fl-studio", "cubase", "pro-tools", "other"].includes(String(origin.sourceDaw))) return undefined;
  return {
    version: 1,
    kind: "aligned-audio-midi",
    sourceDaw: origin.sourceDaw as ProjectTransferOriginV1["sourceDaw"],
  };
}

function normalizeTransferOriginDomain(s: NormalizeState): void {
  const doc = s.doc;
  if (doc.transferOrigin === undefined) return;
  const cleaned = sanitizeProjectTransferOrigin(doc.transferOrigin);
  if (cleaned === undefined) {
    const rest = { ...doc };
    delete rest.transferOrigin;
    s.doc = rest;
    s.changed = true;
    return;
  }
  if (!jsonEqual(cleaned, doc.transferOrigin)) {
    s.doc = { ...doc, transferOrigin: cleaned };
    s.changed = true;
  }
}

function normalizeMarkersDomain(s: NormalizeState): void {
  const doc = s.doc;
  // Markers are NAVIGATION points, not arrangement content. Normalize used
  // to clamp every marker to the project's current length on every command,
  // which silently collapsed anything past the last clip onto the final bar:
  // a producer placing cues at bars 8/16/24/32 got all four stacked on bar 4,
  // no error, no warning. Measured on every template ("empty" and "house"
  // both end at 4 bars, so a 32-bar song lost 80% of its markers).
  //
  // The intentional shrink-clamp still exists, in the command that shrinks:
  // `markerClampPatch` in commands.ts runs on the delete-scene path so undo
  // restores the original ticks. This pass only normalizes SHAPE (id, name,
  // type) and keeps ticks non-negative. Number.MAX_SAFE_INTEGER is the "no
  // ceiling" sentinel; `sanitizeMarkers` floors the value, so a corrupt file
  // still cannot produce an Infinity or fractional tick.
  const cleanedMarkers = sanitizeMarkers(doc.markers, Number.MAX_SAFE_INTEGER);
  // `linkedClipId` is a REFERENCE, and this pass is the only backstop for a
  // document that arrived from outside the command layer — project import,
  // share code, a collab peer, a hand-edited file. Every delete verb unlinks
  // in-command (`docOps.unlinkMarkersOfClips`), which is exactly why the gap
  // stayed invisible: no user gesture produces a stale link. Clip-group
  // membership has been validated here since v15 for the same reason, while
  // marker links never were. A stale id survives every save and the cue
  // preview silently falls back to the global bus. Same rule as a clip group:
  // clear the reference, keep the marker — a cue is navigation, not content.
  const liveClipIds = new Set<string>([
    ...doc.arrangement.clips.map((clip) => clip.id),
    ...(doc.arrangement.audioClips ?? []).map((clip) => clip.id),
    ...(doc.arrangement.midiClips ?? []).map((clip) => clip.id),
    ...(doc.arrangement.automationClips ?? []).map((clip) => clip.id),
  ]);
  const linkedMarkers = cleanedMarkers.map((marker) => {
    if (marker.linkedClipId === undefined || liveClipIds.has(marker.linkedClipId)) return marker;
    const next = { ...marker };
    delete next.linkedClipId;
    return next;
  });
  // JSON.stringify, NOT `jsonEqual`: `sanitizeMarkers` builds every marker with
  // `linkedClipId`/`customId` keys present, so `jsonEqual` — which counts an
  // `undefined`-valued key as PRESENT — reported every marker as changed and
  // rewrote a canonical document with explicit `customId: undefined` keys.
  // That broke `templates.test.ts`'s "scene-score template is unchanged by
  // normalization": a template is supposed to be a fixed point of the
  // normalizer. `stringify` drops `undefined`-valued keys, which is what this
  // call site has always compared with.
  const markersChanged = !Array.isArray(doc.markers) || JSON.stringify(linkedMarkers) !== JSON.stringify(doc.markers);
  if (markersChanged) {
    s.doc = { ...doc, markers: linkedMarkers };
    s.changed = true;
  }
}

function normalizeSceneAutomationDomain(s: NormalizeState): void {
  const doc = s.doc;
  // scene automation — clamp to valid scenes + non-empty lanes.
  const liveSceneIds = new Set(doc.scenes.map((sc) => sc.id));
  const cleanedSceneAuto = sanitizeSceneAutomation(doc.sceneAutomation, liveSceneIds, doc);
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
    const limiterLookaheadMs =
      typeof m.limiterLookaheadMs === "number" && Number.isFinite(m.limiterLookaheadMs)
        ? Math.min(20, Math.max(1, m.limiterLookaheadMs))
        : 5;
    const limiterReleaseMs =
      typeof m.limiterReleaseMs === "number" && Number.isFinite(m.limiterReleaseMs)
        ? Math.min(2000, Math.max(10, m.limiterReleaseMs))
        : 120;
    const limiterCharacter =
      m.limiterCharacter === "punch" || m.limiterCharacter === "smooth" ? m.limiterCharacter : "transparent";
    const legacyLimiterStereoLink =
      typeof m.limiterStereoLink === "number" && Number.isFinite(m.limiterStereoLink)
        ? Math.min(1, Math.max(0, m.limiterStereoLink))
        : 1;
    const limiterTransientLink =
      typeof m.limiterTransientLink === "number" && Number.isFinite(m.limiterTransientLink)
        ? Math.min(1, Math.max(0, m.limiterTransientLink))
        : legacyLimiterStereoLink;
    const limiterReleaseLink =
      typeof m.limiterReleaseLink === "number" && Number.isFinite(m.limiterReleaseLink)
        ? Math.min(1, Math.max(0, m.limiterReleaseLink))
        : legacyLimiterStereoLink;
    const tapeEnabled = typeof m.tapeEnabled === "boolean" ? m.tapeEnabled : false;
    const tapeDrive =
      typeof m.tapeDrive === "number" && Number.isFinite(m.tapeDrive) ? Math.min(1, Math.max(0, m.tapeDrive)) : 0.35;
    const msEnabled = typeof m.msEnabled === "boolean" ? m.msEnabled : false;
    const msMidGain =
      typeof m.msMidGain === "number" && Number.isFinite(m.msMidGain) ? Math.min(6, Math.max(-6, m.msMidGain)) : 0;
    const msSideGain =
      typeof m.msSideGain === "number" && Number.isFinite(m.msSideGain) ? Math.min(6, Math.max(-6, m.msSideGain)) : 0;
    const lufsTarget =
      typeof m.lufsTarget === "number" && Number.isFinite(m.lufsTarget)
        ? Math.min(0, Math.max(-24, m.lufsTarget))
        : -14;
    // Older projects only stored a loudness target and limiter ceiling. Map
    // the default -14 target to Streaming and preserve all other legacy target
    // choices as Custom. The delivery TP target defaults to the old ceiling,
    // so migration cannot silently change an existing verdict.
    const deliveryProfileId = isMasterProfileId(m.deliveryProfileId)
      ? m.deliveryProfileId
      : lufsTarget === -14
        ? "streaming"
        : "custom";
    const deliveryTruePeakDb =
      typeof m.deliveryTruePeakDb === "number" && Number.isFinite(m.deliveryTruePeakDb)
        ? Math.min(0, Math.max(-12, m.deliveryTruePeakDb))
        : dc;
    const masterEffectOwners = new Set([...doc.tracks, ...(doc.returns ?? [])].map((owner) => owner.id));
    const effects = normalizeEffects(m.effects, "master", masterEffectOwners);
    const effectsChanged = !Array.isArray(m.effects) || !jsonEqual(effects, m.effects);
    const glueEnabled = typeof m.glueEnabled === "boolean" ? m.glueEnabled : true;
    const bassMonoEnabled = typeof m.bassMonoEnabled === "boolean" ? m.bassMonoEnabled : false;
    const bassMonoFreq =
      typeof m.bassMonoFreq === "number" && Number.isFinite(m.bassMonoFreq)
        ? Math.min(400, Math.max(60, m.bassMonoFreq))
        : 120;
    const tiltDb = typeof m.tiltDb === "number" && Number.isFinite(m.tiltDb) ? Math.min(4, Math.max(-4, m.tiltDb)) : 0;
    // MATCH EQ (reference tonal match): sanitize per-band ±6 dB; an absent
    // or all-zero object is dropped entirely (transparent master stays clean
    // in serialized docs — the engine treats absence as 0 dB anyway).
    const matchEqRaw = m.matchEq as { low?: unknown; lowMid?: unknown; highMid?: unknown; high?: unknown } | undefined;
    const matchBand = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(6, Math.max(-6, v)) : 0;
    const matchEq =
      matchEqRaw && typeof matchEqRaw === "object"
        ? {
            low: matchBand(matchEqRaw.low),
            lowMid: matchBand(matchEqRaw.lowMid),
            highMid: matchBand(matchEqRaw.highMid),
            high: matchBand(matchEqRaw.high),
          }
        : undefined;
    const matchEqChanged =
      matchEq !== undefined &&
      (matchEq.low !== 0 || matchEq.lowMid !== 0 || matchEq.highMid !== 0 || matchEq.high !== 0);
    // loudnessTrimDb (song-builder genre trim): the rebuild below used to
    // OMIT it — any other out-of-range master field silently reset a
    // non-zero trim to 0 on load. Sanitize it like the rest.
    const loudnessTrimDb =
      typeof m.loudnessTrimDb === "number" && Number.isFinite(m.loudnessTrimDb)
        ? Math.min(12, Math.max(-12, m.loudnessTrimDb))
        : 0;
    if (
      dg !== m.masterGain ||
      dc !== m.ceilingDb ||
      dl !== m.limiterEnabled ||
      dcl !== m.clipperEnabled ||
      limiterLookaheadMs !== m.limiterLookaheadMs ||
      limiterReleaseMs !== m.limiterReleaseMs ||
      limiterCharacter !== m.limiterCharacter ||
      limiterTransientLink !== m.limiterTransientLink ||
      limiterReleaseLink !== m.limiterReleaseLink ||
      m.limiterStereoLink !== undefined ||
      tapeEnabled !== m.tapeEnabled ||
      tapeDrive !== m.tapeDrive ||
      msEnabled !== m.msEnabled ||
      msMidGain !== m.msMidGain ||
      msSideGain !== m.msSideGain ||
      lufsTarget !== m.lufsTarget ||
      deliveryProfileId !== m.deliveryProfileId ||
      deliveryTruePeakDb !== m.deliveryTruePeakDb ||
      effectsChanged ||
      glueEnabled !== m.glueEnabled ||
      bassMonoEnabled !== m.bassMonoEnabled ||
      bassMonoFreq !== m.bassMonoFreq ||
      tiltDb !== m.tiltDb ||
      loudnessTrimDb !== m.loudnessTrimDb ||
      matchEqChanged
    ) {
      const normalizedMaster: MasterConfig = {
        masterGain: dg,
        ceilingDb: dc,
        limiterEnabled: dl,
        clipperEnabled: dcl,
        limiterLookaheadMs,
        limiterReleaseMs,
        limiterCharacter,
        limiterTransientLink,
        limiterReleaseLink,
        tapeEnabled,
        tapeDrive,
        msEnabled,
        msMidGain,
        msSideGain,
        lufsTarget,
        deliveryProfileId,
        deliveryTruePeakDb,
        effects,
        glueEnabled,
        bassMonoEnabled,
        bassMonoFreq,
        tiltDb,
        loudnessTrimDb,
        ...(matchEqChanged ? { matchEq } : {}),
      };
      delete normalizedMaster.limiterStereoLink;
      doc = { ...doc, master: normalizedMaster };
      s.changed = true;
    }
  }
  // returns — normalize their effect chains with the same plugin schema as
  // regular tracks. Return FX are valid automation/macro owners and must not
  // remain a second, weakly-validated persistence path.
  if (!Array.isArray(doc.returns)) {
    doc = { ...doc, returns: createDefaultReturns() };
    s.changed = true;
  } else {
    const returnIds = new Set([...doc.tracks, ...doc.returns].map((item) => item.id));
    const returns = doc.returns
      .filter((ret): ret is ReturnTrack => Boolean(ret && typeof ret.id === "string" && ret.id.length > 0))
      .map((ret) => {
        const effects = normalizeEffects(ret.effects, ret.id, returnIds);
        const gain =
          typeof ret.gain === "number" && Number.isFinite(ret.gain) ? Math.min(1.5, Math.max(0, ret.gain)) : 0.9;
        const name = typeof ret.name === "string" && ret.name.trim() ? ret.name : "Return";
        return { ...ret, kind: "return" as const, name, gain, effects };
      });
    if (JSON.stringify(returns) !== JSON.stringify(doc.returns)) {
      doc = { ...doc, returns };
      s.changed = true;
    }
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
      const drumChannel =
        typeof m.drumChannel === "number" && Number.isFinite(m.drumChannel)
          ? Math.max(0, Math.min(16, Math.floor(m.drumChannel)))
          : 0;
      const instrumentChannel =
        typeof m.instrumentChannel === "number" && Number.isFinite(m.instrumentChannel)
          ? Math.max(0, Math.min(16, Math.floor(m.instrumentChannel)))
          : 0;
      const pitchBendRange =
        typeof m.pitchBendRange === "number" && Number.isFinite(m.pitchBendRange)
          ? Math.max(1, Math.min(24, m.pitchBendRange))
          : 2;
      const rawCcMappings = Array.isArray(m.ccMappings) ? m.ccMappings : [];
      const ccMappings = rawCcMappings
        .map((raw): import("./types").MidiCcMapping | null => {
          if (
            !isObject(raw) ||
            !isObject(raw.target) ||
            !isAutomationTargetValid(doc, raw.target as unknown as AutomationTarget)
          ) {
            return null;
          }
          const target = raw.target as unknown as AutomationTarget;
          const def = targetParamDef(doc, target);
          if (!def) return null;
          const ccNumber = Number(raw.ccNumber);
          if (!Number.isFinite(ccNumber) || ccNumber < 0 || ccNumber > 127) return null;
          const channel = Number(raw.channel);
          const minRaw = Number(raw.min);
          const maxRaw = Number(raw.max);
          const min = Number.isFinite(minRaw) ? Math.max(def.min, Math.min(def.max, minRaw)) : def.min;
          const max = Number.isFinite(maxRaw) ? Math.max(def.min, Math.min(def.max, maxRaw)) : def.max;
          return {
            id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : uid("midiMap"),
            ccNumber: Math.floor(ccNumber),
            ...(Number.isFinite(channel) && channel >= 1 && channel <= 16 ? { channel: Math.floor(channel) } : {}),
            target,
            min: Math.min(min, max),
            max: Math.max(min, max),
          };
        })
        .filter((mapping): mapping is import("./types").MidiCcMapping => mapping !== null);
      const rawDrumNoteMap = Array.isArray(m.drumNoteMap) ? m.drumNoteMap : [];
      // A drum-note mapping is a REFERENCE to a pad, and `deleteTrack` strips
      // the mappings of the pads it removes — but only on the command path.
      // This used to pass the array through verbatim, so a document from
      // import / share code / a collab peer kept a mapping aimed at a pad that
      // does not exist: the incoming MIDI note resolves to nothing, silently,
      // in every save from then on. Tracks are already normalized above
      // (`normalizeTracksDomain` runs before this domain), so the live pad set
      // here is authoritative.
      const padIds = new Set(
        doc.tracks.flatMap((track) => (track.kind === "drum" ? track.pads.map((pad) => pad.id) : [])),
      );
      const drumNoteMap = rawDrumNoteMap.filter(
        (entry) =>
          isObject(entry) &&
          typeof (entry as Record<string, unknown>).padId === "string" &&
          Number.isFinite(Number((entry as Record<string, unknown>).midiNote)) &&
          padIds.has((entry as Record<string, unknown>).padId as string),
      );
      const aftertouchTarget =
        isObject(m.aftertouchTarget) && isAutomationTargetValid(doc, m.aftertouchTarget as unknown as AutomationTarget)
          ? (m.aftertouchTarget as unknown as AutomationTarget)
          : undefined;
      const aftertouchRange =
        typeof m.aftertouchRange === "number" && Number.isFinite(m.aftertouchRange)
          ? Math.max(0, Math.min(1, m.aftertouchRange))
          : undefined;
      // Only create new object if something actually changed
      if (
        enabled !== (m.enabled === true) ||
        deviceId !== (typeof m.deviceId === "string" ? m.deviceId : "") ||
        drumChannel !== m.drumChannel ||
        instrumentChannel !== m.instrumentChannel ||
        pitchBendRange !== m.pitchBendRange ||
        JSON.stringify(ccMappings) !== JSON.stringify(rawCcMappings) ||
        // `drumNoteMap` was missing from this list: the field was rewritten in
        // the rebuilt object but never counted as a change, so a filtered
        // mapping would be computed and then discarded by the identity guard.
        !jsonEqual(drumNoteMap, rawDrumNoteMap) ||
        JSON.stringify(aftertouchTarget) !== JSON.stringify(m.aftertouchTarget) ||
        aftertouchRange !== m.aftertouchRange
      ) {
        s.doc = {
          ...doc,
          midi: {
            enabled,
            deviceId,
            drumChannel,
            instrumentChannel,
            ccMappings,
            drumNoteMap,
            pitchBendRange,
            ...(aftertouchTarget ? { aftertouchTarget } : {}),
            ...(aftertouchRange !== undefined ? { aftertouchRange } : {}),
          },
        };
        s.changed = true;
      }
    }
  }
}

function normalizeLiveSetsDomain(s: NormalizeState): void {
  const doc = s.doc;
  if (doc.liveSets === undefined && doc.activeLiveSetId === undefined) return;
  const liveSetsInput = doc.liveSets;
  const eligibleTrackIds = new Set(doc.tracks.filter((track) => track.kind !== "generative").map((track) => track.id));
  const allowedLoopBars = new Set([1, 2, 4, 8, 16]);
  const liveSets: import("./types").LiveSet[] = [];

  if (Array.isArray(liveSetsInput)) {
    for (let index = 0; index < Math.min(32, liveSetsInput.length); index++) {
      const rawSet = liveSetsInput[index];
      if (!isObject(rawSet)) continue;
      const id = typeof rawSet.id === "string" && rawSet.id.trim() !== "" ? rawSet.id : uid("liveSet");
      const name =
        typeof rawSet.name === "string" && rawSet.name.trim() !== ""
          ? rawSet.name.trim().slice(0, 64)
          : `Live Set ${index + 1}`;
      const trackId =
        typeof rawSet.trackId === "string" && eligibleTrackIds.has(rawSet.trackId) ? rawSet.trackId : undefined;
      const rawLoopBars = Number(rawSet.loopBars);
      const loopBars = allowedLoopBars.has(rawLoopBars) ? (rawLoopBars as 1 | 2 | 4 | 8 | 16) : 4;
      const pads: import("./types").LiveSetPad[] = [];
      const seenSlots = new Set<number>();
      if (Array.isArray(rawSet.pads)) {
        for (const rawPad of rawSet.pads) {
          if (!isObject(rawPad)) continue;
          const slot = Number(rawPad.slot);
          const bufferId = typeof rawPad.bufferId === "string" ? rawPad.bufferId.trim() : "";
          if (
            !Number.isInteger(slot) ||
            slot < 0 ||
            slot >= 16 ||
            seenSlots.has(slot) ||
            !bufferId ||
            bufferId.length > 512
          )
            continue;
          seenSlots.add(slot);
          const padName =
            typeof rawPad.name === "string" && rawPad.name.trim() !== ""
              ? rawPad.name.trim().slice(0, 96)
              : `Pad ${slot + 1}`;
          const rawBpm = Number(rawPad.bpm);
          const bpm = Number.isFinite(rawBpm) && rawBpm >= 40 && rawBpm <= 240 ? rawBpm : undefined;
          const pad: import("./types").LiveSetPad = {
            slot,
            bufferId,
            name: padName,
            ...(bpm !== undefined ? { bpm } : {}),
            ...(rawPad.loop === true ? { loop: true } : {}),
          };
          const unchanged =
            rawPad.slot === pad.slot &&
            rawPad.bufferId === pad.bufferId &&
            rawPad.name === pad.name &&
            rawPad.bpm === pad.bpm &&
            rawPad.loop === pad.loop;
          pads.push(unchanged ? (rawPad as unknown as import("./types").LiveSetPad) : pad);
        }
      }
      pads.sort((a, b) => a.slot - b.slot);
      const set: import("./types").LiveSet = {
        id,
        name,
        ...(trackId ? { trackId } : {}),
        loopBars,
        pads,
      };
      const rawPads = Array.isArray(rawSet.pads) ? rawSet.pads : [];
      const unchanged =
        rawSet.id === set.id &&
        rawSet.name === set.name &&
        rawSet.trackId === set.trackId &&
        rawSet.loopBars === set.loopBars &&
        rawPads.length === pads.length &&
        pads.every((pad, padIndex) => rawPads[padIndex] === pad);
      liveSets.push(unchanged ? (rawSet as unknown as import("./types").LiveSet) : set);
    }
  }

  const requestedActiveId = typeof doc.activeLiveSetId === "string" ? doc.activeLiveSetId : undefined;
  const activeLiveSetId = liveSets.some((set) => set.id === requestedActiveId) ? requestedActiveId : liveSets[0]?.id;
  const setsUnchanged =
    liveSetsInput === undefined
      ? liveSets.length === 0
      : liveSets.length === liveSetsInput.length && liveSets.every((set, index) => set === liveSetsInput[index]);
  if (setsUnchanged && activeLiveSetId === doc.activeLiveSetId) return;
  const next: ProjectDocument = { ...doc };
  if (liveSets.length > 0) next.liveSets = liveSets;
  else delete next.liveSets;
  if (activeLiveSetId) next.activeLiveSetId = activeLiveSetId;
  else delete next.activeLiveSetId;
  s.doc = next;
  s.changed = true;
}

function normalizePatternsDomain(s: NormalizeState): void {
  const doc = s.doc;
  const padIds = new Set(allPadIds(doc));
  const trackIds = new Set(doc.tracks.map((t) => t.id));
  const instrumentKinds = new Map(
    doc.tracks.filter((track) => track.kind === "instrument").map((track) => [track.id, track.instrument]),
  );
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
            const ALLOWED_LOCKS = new Set([
              "pitch",
              "gain",
              "pan",
              "cutoff",
              "sampleStart",
              "length",
              "fadeIn",
              "fadeOut",
              "ratio",
            ]);
            const def = {
              pitch: { min: -24, max: 24 },
              gain: { min: 0, max: 2 },
              pan: { min: -1, max: 1 },
              cutoff: { min: 80, max: 16000 },
              sampleStart: { min: 0, max: 1 },
              length: { min: 0.1, max: 2 },
              fadeIn: { min: 0, max: 1 },
              fadeOut: { min: 0, max: 1 },
              ratio: { min: 1, max: 7 },
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
    // Notes are sparse and may extend beyond the bounded step grid; keep them
    // within the same finite musical-time ceiling as arrangement clips.
    const notesByTrack: Record<string, typeof p.notes extends Record<string, infer V> ? V : never> = {};
    let notesChanged = false;
    for (const [trackId, noteList] of Object.entries(p.notes ?? {})) {
      if (!trackIds.has(trackId)) {
        notesChanged = true;
        continue;
      }
      const maxNoteEndTick = MAX_ARRANGEMENT_CLIP_TICKS;
      // Defect A03.D1 (sequencer integrity audit): a note with
      // duration <= 0 would fire its noteOn() with a non-positive
      // durationSec, which the instrument runtimes interpret as
      // "release immediately" — the audible result is either silence
      // or, in some runtimes, a stuck tail because the scheduled
      // noteOff has already happened by the time the envelope is
      // running. A negative `start` would schedule the note in the
      // past; the scheduler's `audible()` check would still accept
      // it within its 2 ms grace window, so the user could hear
      // one-shot ghost notes at pattern start. Filter both.
      // Fast path (GOAL 08/B2): validate first, allocate only when a note
      // is actually invalid — the 95 % clean case keeps the array reference
      // instead of churning a fresh list per pattern per keystroke.
      let hasInvalid = false;
      for (const n of noteList) {
        if (
          !Number.isFinite(n.start) ||
          n.start < 0 ||
          !Number.isFinite(n.duration) ||
          n.duration <= 0 ||
          n.start + n.duration > maxNoteEndTick
        ) {
          hasInvalid = true;
          break;
        }
        if (!noteExpressionEquals(normalizeNoteExpression(n.expression), n.expression)) {
          hasInvalid = true;
          break;
        }
        const normalizedSlideNote =
          n.slideNote === true && n.slide !== true && supportsHeldVoiceSlideNote(instrumentKinds.get(trackId));
        if ((n.slideNote === true) !== normalizedSlideNote) {
          hasInvalid = true;
          break;
        }
      }
      if (!hasInvalid) {
        notesByTrack[trackId] = noteList as never;
      } else {
        const normalizedNotes: NoteEvent[] = [];
        for (const n of noteList) {
          if (
            !Number.isFinite(n.start) ||
            n.start < 0 ||
            !Number.isFinite(n.duration) ||
            n.duration <= 0 ||
            n.start + n.duration > maxNoteEndTick
          ) {
            notesChanged = true;
            continue;
          }
          const expression = normalizeNoteExpression(n.expression);
          const slideNote =
            n.slideNote === true && n.slide !== true && supportsHeldVoiceSlideNote(instrumentKinds.get(trackId));
          if (noteExpressionEquals(expression, n.expression) && (n.slideNote === true) === slideNote)
            normalizedNotes.push(n);
          else {
            notesChanged = true;
            const { expression: _oldExpression, slideNote: _oldSlideNote, ...rest } = n;
            normalizedNotes.push({
              ...rest,
              ...(expression ? { expression } : {}),
              ...(slideNote ? { slideNote: true } : {}),
            });
          }
        }
        notesByTrack[trackId] = normalizedNotes as never;
      }
    }
    if (notesChanged) {
      p = { ...p, notes: notesByTrack as typeof p.notes };
      patternsChanged = true;
    }
    // Rows: drop unknown pad rows, fill missing pad rows, fix wrong length
    let rows = p.rows;
    const validPadIds = new Set<string>();
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
      validPadIds.add(padId);
    }
    for (const padId of padIds) {
      if (!validPadIds.has(padId)) {
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

function normalizeNoteExpression(value: unknown): NoteExpression | undefined {
  if (!isObject(value)) return undefined;
  const expression: NoteExpression = {};
  const pan = value.pan;
  if (typeof pan === "number" && Number.isFinite(pan)) {
    const normalized = Math.round(Math.max(-1, Math.min(1, pan)) * 100) / 100;
    if (normalized !== 0) expression.pan = normalized;
  }
  const filterCutoffHz = value.filterCutoffHz;
  if (typeof filterCutoffHz === "number" && Number.isFinite(filterCutoffHz)) {
    const normalized = Math.round(Math.max(80, Math.min(16000, filterCutoffHz)));
    expression.filterCutoffHz = normalized;
  }
  const filterResonance = value.filterResonance;
  if (typeof filterResonance === "number" && Number.isFinite(filterResonance)) {
    const normalized = Math.round(Math.max(0, Math.min(1, filterResonance)) * 100) / 100;
    if (normalized !== 0.08) expression.filterResonance = normalized;
  }
  const releaseVelocity = value.releaseVelocity;
  if (typeof releaseVelocity === "number" && Number.isFinite(releaseVelocity)) {
    const normalized = Math.round(Math.max(0, Math.min(1, releaseVelocity)) * 100) / 100;
    if (normalized !== 0.5) expression.releaseVelocity = normalized;
  }
  const modX = value.modX;
  if (typeof modX === "number" && Number.isFinite(modX)) {
    const normalized = Math.round(Math.max(0, Math.min(1, modX)) * 100) / 100;
    if (normalized !== 0.5) expression.modX = normalized;
  }
  const modY = value.modY;
  if (typeof modY === "number" && Number.isFinite(modY)) {
    const normalized = Math.round(Math.max(0, Math.min(1, modY)) * 100) / 100;
    if (normalized !== 0.5) expression.modY = normalized;
  }
  const pitchOffsetSemitones = value.pitchOffsetSemitones;
  if (typeof pitchOffsetSemitones === "number" && Number.isFinite(pitchOffsetSemitones)) {
    const normalized = Math.round(Math.max(-12, Math.min(12, pitchOffsetSemitones)) * 100) / 100;
    if (normalized !== 0) expression.pitchOffsetSemitones = normalized;
  }
  return Object.keys(expression).length > 0 ? expression : undefined;
}

function noteExpressionEquals(left: NoteExpression | undefined, right: unknown): boolean {
  if (!left) return right === undefined;
  if (!isObject(right)) return false;
  return (
    left.pan === right.pan &&
    left.filterCutoffHz === right.filterCutoffHz &&
    left.filterResonance === right.filterResonance &&
    left.releaseVelocity === right.releaseVelocity &&
    left.modX === right.modX &&
    left.modY === right.modY &&
    left.pitchOffsetSemitones === right.pitchOffsetSemitones &&
    Object.keys(right).every(
      (key) =>
        key === "pan" ||
        key === "filterCutoffHz" ||
        key === "filterResonance" ||
        key === "releaseVelocity" ||
        key === "modX" ||
        key === "modY" ||
        key === "pitchOffsetSemitones",
    )
  );
}

/**
 * Duplicate-entity-id backstop (first domain in the pipeline).
 *
 * Every id in this model is the primary key for `find(t => t.id === …)` — so a
 * document carrying two entities under one id produces a DUPLICATE RUNTIME
 * OBJECT: the mixer builds a strip for each, while every command, every
 * selection and every id-lookup silently addresses only the first. The second
 * is live audio with no owner. Measured on a duplicated `testDoc()` before
 * this pass existed: `doc.tracks.length` 4 for a 3-track project, with the
 * extra strip rendered and unreachable.
 *
 * The command layer already refuses colliding ids at the boundary
 * (`createInstrumentTrack` in the AI executor throws on an existing id), which
 * is why only an out-of-band document could produce this — project import,
 * share code, a collab peer, a hand-edited file. This pass is that missing
 * backstop, and it runs FIRST so every later domain validates against the
 * deduped sets rather than against a set with twins in it.
 *
 * Keep the FIRST occurrence: it is the entity every `find` already resolves
 * to, so no live reference changes meaning. Within-collection only — the four
 * clip systems are separately namespaced by their `uid()` prefixes, so
 * dropping a clip because another system's clip shares its id would destroy
 * content to fix a collision nothing can produce.
 *
 * COST, measured 2026-10-18 (`.artifacts/measure-dedupe.mjs`): 0.069 ms at 269
 * entities, 0.911 ms at 4,184 — linear, and a stable **~6 % of
 * `normalizeProject`'s total**, independent of scale. Against the 100 ms
 * normalization budget in `tests/stress.test.ts` that is under 1 % at 16x a
 * large project, so no early-out is warranted.
 *
 * A lazy variant of this loop was tried and REVERTED: allocating the result
 * array only on the first duplicate is strictly less garbage, but the measured
 * difference sat inside the machine's noise floor (the same run's
 * `normalizeProject` totals drifted by 30 % between passes), so it could not be
 * shown to help. An unmeasurable optimization that makes the obvious version
 * harder to read is not worth keeping.
 */
function dedupeEntityIdsDomain(s: NormalizeState): void {
  const doc = s.doc;
  /** First-wins dedupe of one top-level collection. Returns undefined when unchanged. */
  const dedupe = <T>(list: unknown): T[] | undefined => {
    if (!Array.isArray(list)) return undefined;
    const seen = new Set<string>();
    const out: T[] = [];
    let dropped = 0;
    for (const entry of list as T[]) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (typeof id === "string") {
        if (seen.has(id)) {
          dropped++;
          continue;
        }
        seen.add(id);
      }
      out.push(entry);
    }
    return dropped > 0 ? out : undefined;
  };
  const patch: Record<string, unknown> = {};
  for (const key of TOP_LEVEL_ID_COLLECTIONS) {
    const next = dedupe(doc[key]);
    if (next) patch[key] = next;
  }
  const arrangement = doc.arrangement as unknown as Record<string, unknown> | undefined;
  if (arrangement && typeof arrangement === "object") {
    const arrPatch: Record<string, unknown> = {};
    for (const key of ARRANGEMENT_ID_COLLECTIONS) {
      const next = dedupe(arrangement[key]);
      if (next) arrPatch[key] = next;
    }
    if (Object.keys(arrPatch).length > 0) patch.arrangement = { ...arrangement, ...arrPatch };
  }
  if (Object.keys(patch).length === 0) return;
  s.doc = { ...doc, ...patch } as ProjectDocument;
  s.changed = true;
}

/** Collections whose ids are primary keys and must be unique. */
const TOP_LEVEL_ID_COLLECTIONS = [
  "tracks",
  "returns",
  "patterns",
  "scenes",
  "liveSets",
  "automation",
  "sceneAutomation",
  "lfos",
  "macros",
  // `markers` is deliberately absent: `sanitizeMarkers` already dedupes by id
  // and its own contract promises that, so covering markers here too would be
  // the same invariant enforced twice. Measured: with the sanitizeMarkers
  // dedupe removed, the marker-dedupe mutation below still went green on this
  // list and red without it — one owner, provably load-bearing.
] as const;

/** Same, one level down — the four clip systems plus their side collections. */
const ARRANGEMENT_ID_COLLECTIONS = [
  "clips",
  "audioClips",
  "midiClips",
  "automationClips",
  "clipGroups",
  "takeGroups",
  "transitions",
  "chords",
] as const;

const NORMALIZE_DOMAINS: ((s: NormalizeState) => void)[] = [
  dedupeEntityIdsDomain,
  normalizeTimeSignatureDomain,
  normalizeBpmDomain,
  normalizeActivePatternDomain,
  normalizeTracksDomain,
  normalizeMasterAndReturnsDomain,
  normalizeScenesDomain,
  normalizeArrangementDomain,
  remapDeprecatedAliasTargets,
  normalizeAutomationDomain,
  normalizeLfosDomain,
  normalizeMacrosDomain,
  normalizeSceneDetailsDomain,
  normalizeKeyAndTagsDomain,
  normalizeLineageDomain,
  normalizeProducerBriefDomain,
  normalizeTransferOriginDomain,
  normalizeMarkersDomain,
  normalizeSceneAutomationDomain,
  normalizeTimestampsDomain,
  normalizeGrooveDomain,
  normalizeMidiDomain,
  normalizeLiveSetsDomain,
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

export function migrateProject(doc: ProjectDocument): ProjectDocument {
  if (doc.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Project schema ${doc.schemaVersion} is newer than supported ${SCHEMA_VERSION}`);
  }
  let migrated = doc;
  if (migrated.schemaVersion === SCHEMA_VERSION) return normalizeProject(migrated);
  // v3 adds the optional `lineage` family link; v4 adds optional AudioClip
  // source-channel routing; v5 adds non-destructive AudioClip take groups;
  // v6 adds an optional production profile to generated-pattern provenance;
  // v7 adds take-comp provenance and permits short, positive AudioClip ranges;
  // v8 adds optional per-pad round-robin / velocity layers (`DrumPad.layers`);
  // v9 adds `AudioClip.loopPhaseOffsetSec` for phase-preserving loop splits;
  // v10 adds the opt-in, structured project Producer Brief (no raw prompts/audio);
  // v11 adds ArrangementClip pattern/scene phase offsets (missing means phase 0);
  // v12 adds the explicit mastering delivery profile, true-peak target, and final-sum insert chain.
  // v13 adds the optional `InstrumentTrack.sampleIdB` (TSAR Source B identity; ADR 0023).
  // v14 adds the optional `AudioClip.muted` clip-level mute (absent = audible).
  // v15 adds clip groups (`Arrangement.clipGroups`, membership by clip id) and
  // the optional clip-level `locked` flag on BOTH clip systems (absent =
  // unlocked).
  // v16 adds the optional `AudioClip.fadeCurve` ("equal" = equal-power
  // sine/cosine fades; absent = linear).
  // v17 adds the chord track (`Arrangement.chords` — whole-bar harmonic
  // skeleton events).
  // v18 adds adjustable built-in master limiter look-ahead and release times;
  // v19 adds one master stereo link; v20 splits it into transient/release
  // links while mapping the v19 value to both; v21 adds opt-in limiter
  // character modes while preserving the old envelope as the default.
  // v22 adds the optional per-track `inputInsert` (armed-input chain + raw vs
  // baked recording mode). Absent = dry monitoring, so older files are
  // unchanged and carry no insert.
  // v23 adds the optional per-scene `packs` (fxId → scene-pack pair id; the
  // performance override applied at clip boundaries). Absent = play the
  // effect's own applied pair.
  // v24 adds the optional per-scene `macros` (macroId → 0..1; pinned macro
  // values that substitute the live macro in every macro-sourced mapping
  // while the scene is active). Absent = play the doc macro values.
  // v25 adds the optional per-scene `ccRemaps` (the source:"midiCC" mapping
  // ids armed while the scene is active; absent = all armed, [] = none).
  // v26 adds optional per-instrument MIDI arrangement clips; absent = none.
  // v27 adds independent song-timeline automation clips; absent = none.
  // v28 lets sparse MIDI notes extend to the arrangement safety limit without
  // growing the bounded step arrays; older projects remain unchanged.
  // v29 adds the optional per-scene `ccOverrides` (mappingId → { ccNumber,
  // channel }: the channel/CC re-point a source:"midiCC" mapping listens on
  // while the scene is active; absent fields keep the mapping's own).
  // v30 adds optional automation clip linkedTargets; absent = single target.
  // v31 adds the optional per-scene `modulators` (lfoId → { steps?, seed? }:
  // the step / random-S&H modulation pattern a scene plays; absent fields
  // keep the modulator's own pattern).
  // v32 adds optional per-step sample fade-in / fade-out locks and preserves
  // the existing ratio p-lock during normalization. Older projects remain
  // unchanged and continue using the pad's fade settings when no fade is set.
  // v33 adds optional per-note expression (pan, filter and release velocity);
  // absent or default-valued fields preserve the original sound.
  // v34 adds a distinct held-voice slide-note articulation, first supported on 808; legacy `slide` remains
  // the note-on portamento transition. v35 adds normalized per-note Mod X/Y
  // values; their neutral value (0.5) is omitted to preserve instrument defaults.
  // v36 adds optional DAW-neutral audio + MIDI transfer provenance.
  // v37 adds an independent, duration-preserving AudioClip pitch offset.
  // v38 adds project-local Live Sets with named 4×4 loop-pad assignments.
  // Older files remain playable; legacy recipe fields stay absent.
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
  if (doc.producerBrief !== undefined && sanitizeProjectProducerBrief(doc.producerBrief) === undefined) return false;
  if (doc.transferOrigin !== undefined && sanitizeProjectTransferOrigin(doc.transferOrigin) === undefined) return false;
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

/**
 * Ticks in one bar of the given meter (4/4 → 1920, 6/8 → 1440, 2/2 → 1920).
 *
 * The single source for "how long is a bar" in musical terms. The arrangement
 * grid has its own, separate unit — `BAR_TICKS`, always four quarter notes —
 * and the two disagree outside 4/4-like meters. See ADR 0056.
 */
export function ticksPerBarFor(sig: TimeSignature): number {
  return PPQ * (4 / sig.denominator) * sig.numerator;
}

export function ticksPerBar(doc: Pick<ProjectDocument, "timeSignature">): number {
  return ticksPerBarFor(doc.timeSignature);
}

/** Ticks per beat (one quarter note in 4/4, one eighth note in 6/8). */
export function ticksPerBeat(doc: Pick<ProjectDocument, "timeSignature">): number {
  return PPQ * (4 / doc.timeSignature.denominator);
}

/**
 * Is one 16-step PATTERN exactly one bar of the given meter?
 *
 * ADR 0056 Stage 2 moved the arrangement onto the document's meter: the ruler,
 * clip placement, the metronome and the readouts all measure the metrical bar
 * now. The PATTERN grid is the one unit that did not move — a pattern is 16
 * sixteenth steps (`PATTERN_TICKS`, four quarter notes) whatever the meter
 * declares. A meter is "one bar per pattern" only when its bar is also four
 * quarter notes: 4/4, 2/2 and 8/8 are; 3/4, 6/8, 4/2, 12/8 and 2/4 are not.
 *
 * Where it is not, a pattern's phrase does not line up with the bar: in 6/8 one
 * pattern is 1.33 bars long and its downbeat reaches the bar line only every
 * fourth bar. That gap is measured and recorded in ADR 0056; it is the one the
 * transfer dialog discloses.
 */
export function patternGridIsOneBar(sig: TimeSignature): boolean {
  return ticksPerBarFor(sig) === PATTERN_TICKS;
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
