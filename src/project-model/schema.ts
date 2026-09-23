import type {
  DrumPad,
  DrumTrack,
  DeviceState,
  EffectInstance,
  GenerativeTrack,
  GenerativeMacroAutomation,
  GenerativeMacroName,
  GenerativeTrackConfig,
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
import { sanitizeGateSteps, sanitizeLfo, sanitizeManglerSteps } from "./modulators";
import { uid } from "../shared/ids";
import { defaultInstrumentParams, INSTRUMENT_META } from "../instruments/definitions";
import { createProjectFromTemplate } from "./templates";
import { clampEffectParam, defaultParamsOf, EFFECT_META, normalizePluginParams } from "../effects/definitions";
import { clampFxOutputTrimDb } from "../effects/presetLoudness";
import { clampTargetValue, isAutomationTargetValid, targetOwner, targetParamDef } from "./targets";

export const SCHEMA_VERSION = 2;
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
  fm: "FM",
  pluck: "Pluck",
  logdrum: "Log Drum",
  spectral: "Spectral",
  vocalchop: "Vocal Chop",
  drumsynth: "Drum Synth",
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
    tapeEnabled: false,
    tapeDrive: 0.35,
    msEnabled: false,
    msMidGain: 0,
    msSideGain: 0,
    lufsTarget: -14,
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
    const loop = raw.loop === true;
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
      reverse,
      ...(loop ? { loop } : {}),
      ...(stretchMode ? { stretchMode } : {}),
      ...(warpMarkers ? { warpMarkers } : {}),
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
      const pluginParams = normalizePluginParams(type, source as Record<string, unknown>);
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
      const deviceState = sanitizeDeviceState((item as { deviceState?: unknown }).deviceState);
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

/** Clamp a per-pad mod to a legal voice-local LFO; null = disabled. */
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
    rateHz: Math.min(40, rateHz),
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
      // engine unclamped (+52 dB into the FX bus).
      const clamped = Math.min(1, Math.max(0, v));
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
          // Per-pad mod (voice-local LFO) sanitization — null = disabled/off
          const rawMod: unknown = (pad as unknown as Record<string, unknown>).mod;
          const saneMod = rawMod !== undefined ? sanitizePadMod(rawMod) : undefined;
          const modChanged = rawMod !== undefined && JSON.stringify(saneMod) !== JSON.stringify(rawMod ?? null);
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
            if (!padColorChanged && !earlyLoopChanged && !modChanged) return pad;
            return {
              ...pad,
              color: padColor,
              sliceLoop: sliceLoop ?? undefined,
              sliceLoopStart: sliceLoopStart ?? undefined,
              sliceLoopEnd: sliceLoopEnd ?? undefined,
              ...(modChanged ? { mod: saneMod } : {}),
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
          // Per-pad mod sanitization (already computed above for the early-return path)
          if (modChanged) {
            nextPad = { ...nextPad, mod: saneMod } as any;
            padChanged = true;
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
        if (JSON.stringify(generative) !== JSON.stringify(t.generative)) {
          t = { ...t, generative };
          tracksChanged = true;
        }
        const normalizedEffects = normalizeEffects(t.effects ?? [], t.id, trackIds);
        if (t.effects === undefined || JSON.stringify(normalizedEffects) !== JSON.stringify(t.effects)) {
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
        if (t.effects === undefined || JSON.stringify(normalizedEffects) !== JSON.stringify(t.effects)) {
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
        if (v === undefined) {
          paramsChanged = true;
        } else {
          merged[k] = v;
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
      if (t.effects === undefined || JSON.stringify(normalizedEffects) !== JSON.stringify(t.effects)) {
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
        const rawLayers = Array.isArray(t.velocityLayers) ? (t.velocityLayers as unknown[]) : [];
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
        const canonical = cleanLayers.length > 0 ? cleanLayers : undefined;
        if (JSON.stringify(canonical) !== JSON.stringify(t.velocityLayers)) {
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
  if (JSON.stringify(filtered) !== JSON.stringify(automation)) {
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
        JSON.stringify(sanitized.target) !== JSON.stringify(mapping.target)
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
    const glueEnabled = typeof m.glueEnabled === "boolean" ? m.glueEnabled : true;
    const bassMonoEnabled = typeof m.bassMonoEnabled === "boolean" ? m.bassMonoEnabled : false;
    const bassMonoFreq =
      typeof m.bassMonoFreq === "number" && Number.isFinite(m.bassMonoFreq)
        ? Math.min(400, Math.max(60, m.bassMonoFreq))
        : 120;
    const tiltDb = typeof m.tiltDb === "number" && Number.isFinite(m.tiltDb) ? Math.min(4, Math.max(-4, m.tiltDb)) : 0;
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
      tapeEnabled !== m.tapeEnabled ||
      tapeDrive !== m.tapeDrive ||
      msEnabled !== m.msEnabled ||
      msMidGain !== m.msMidGain ||
      msSideGain !== m.msSideGain ||
      lufsTarget !== m.lufsTarget ||
      glueEnabled !== m.glueEnabled ||
      bassMonoEnabled !== m.bassMonoEnabled ||
      bassMonoFreq !== m.bassMonoFreq ||
      tiltDb !== m.tiltDb ||
      loudnessTrimDb !== m.loudnessTrimDb
    ) {
      doc = {
        ...doc,
        master: {
          masterGain: dg,
          ceilingDb: dc,
          limiterEnabled: dl,
          clipperEnabled: dcl,
          tapeEnabled,
          tapeDrive,
          msEnabled,
          msMidGain,
          msSideGain,
          lufsTarget,
          glueEnabled,
          bassMonoEnabled,
          bassMonoFreq,
          tiltDb,
          loudnessTrimDb,
        },
      };
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
      const drumNoteMap = Array.isArray(m.drumNoteMap) ? m.drumNoteMap : [];
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
      const filtered = noteList.filter(
        (n) =>
          Number.isFinite(n.start) &&
          n.start >= 0 &&
          Number.isFinite(n.duration) &&
          n.duration > 0 &&
          n.start + n.duration <= patternTicks,
      );
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
  normalizeMasterAndReturnsDomain,
  normalizeScenesDomain,
  normalizeArrangementDomain,
  normalizeAutomationDomain,
  normalizeLfosDomain,
  normalizeMacrosDomain,
  normalizeSceneDetailsDomain,
  normalizeKeyAndTagsDomain,
  normalizeMarkersDomain,
  normalizeSceneAutomationDomain,
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
