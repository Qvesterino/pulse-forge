import type {
  DrumPad,
  DrumTrack,
  EffectInstance,
  InstrumentKind,
  InstrumentTrack,
  IntensityPoint,
  Macro,
  MacroMapping,
  Marker,
  MasterConfig,
  Pattern,
  ProjectDocument,
  ReturnTrack,
  Scene,
  SceneAutomation,
  StepMeta,
} from "./types";
import { BAR_TICKS, PPQ, STEP_TICKS, STEPS_PER_PATTERN, isMusicalKey } from "./types";
import { uid } from "../shared/ids";
import { defaultInstrumentParams } from "../instruments/registry";
import { createProjectFromTemplate } from "./templates";

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
    sampleId: kind === "sampler" ? "factory.tonal.pluck" : null,
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
export function sanitizeSceneAutomation(
  input: unknown,
  sceneIds: Set<string>,
): SceneAutomation[] {
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
  const param = raw.param === "pan" ? "pan" : "gain";
  const amount = Math.max(-1, Math.min(1, Number(raw.amount) || 0));
  const source = raw.source === "intensity" ? "intensity" : "macro";
  return { id, trackId, param, amount, source };
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

/**
 * Bring a project document (possibly loaded from disk, possibly mutated by an
 * outdated client) to a state the current engine can use without errors.
 *
 * Normalization is idempotent and never throws — it always returns a valid
 * `ProjectDocument`. Callers should treat the return value as the new truth
 * and discard the input.
 */
export function normalizeProject(doc: ProjectDocument): ProjectDocument {
  let changed = false;
  let next: ProjectDocument = doc;

  // timeSignature
  if (!isValidTimeSignature(next.timeSignature)) {
    next = { ...next, timeSignature: { numerator: 4, denominator: 4 } };
    changed = true;
  }

  // bpm
  const clampedBpm = clampBpm(next.bpm);
  if (clampedBpm !== next.bpm) {
    next = { ...next, bpm: clampedBpm };
    changed = true;
  }

  // activePatternId
  const patternIds = new Set(next.patterns.map((p) => p.id));
  if (next.patterns.length === 0 || !patternIds.has(next.activePatternId)) {
    if (next.patterns.length === 0) {
      // Should be impossible (createDefaultProject always seeds a pattern),
      // but synthesize a placeholder so the schema stays valid.
      const seed = createPatternForDoc(next, "Pattern A");
      next = {
        ...next,
        patterns: [seed],
        activePatternId: seed.id,
        scenes: [],
        arrangement: { clips: [] },
      };
      changed = true;
    } else {
      next = { ...next, activePatternId: next.patterns[0].id };
      changed = true;
    }
  }

  // tracks: ensure drum effects/instrument params/sends, strip dangling
  const trackIds = new Set(next.tracks.map((t) => t.id));
  let tracksChanged = false;
  const tracks = next.tracks.map((track): DrumTrack | InstrumentTrack | import("../project-model/types").GroupTrack => {
    if (track.kind === "drum") {
      let t: DrumTrack = track;
      if (t.effects === undefined) {
        t = { ...t, effects: [] as EffectInstance[] } as DrumTrack;
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
      if (t.effects === undefined) {
        t = { ...t, effects: [] as EffectInstance[] };
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
    if (t.effects === undefined) {
      t = { ...t, effects: [] as EffectInstance[] };
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
    next = { ...next, tracks: tracks as ProjectDocument["tracks"] };
    changed = true;
  }

  // scenes
  let scenes: Scene[] | undefined = next.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    scenes = [defaultSceneFor(next)];
    changed = true;
  } else {
    const filtered = scenes.filter((s) => patternIds.has(s.patternId));
    if (filtered.length !== scenes.length) {
      scenes = filtered.length > 0 ? filtered : [defaultSceneFor(next)];
      changed = true;
    }
  }
  if (scenes !== next.scenes) {
    next = { ...next, scenes: scenes! };
  }
  const sceneIds = new Set(next.scenes.map((s) => s.id));

  // arrangement
  let arrangement = next.arrangement;
  if (arrangement === undefined || arrangement === null) {
    arrangement = { clips: [] };
    changed = true;
  } else {
    const sorted = [...arrangement.clips]
      .filter((c) => sceneIds.has(c.sceneId) && Number.isFinite(c.startBar) && c.startBar >= 0 && c.lengthBars >= 1)
      .sort((a, b) => a.startBar - b.startBar);
    if (sorted.length !== arrangement.clips.length) {
      arrangement = { clips: sorted };
      changed = true;
    } else {
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i] !== arrangement.clips[i]) {
          arrangement = { clips: sorted };
          changed = true;
          break;
        }
      }
    }
  }
  if (arrangement !== next.arrangement) {
    next = { ...next, arrangement };
  }

  // automation / lfos — ensure arrays, filter dangling
  let automation = next.automation;
  if (!Array.isArray(automation)) {
    automation = [];
    changed = true;
  } else {
    const filtered = automation.filter((lane) => trackIds.has(lane.target.trackId));
    if (filtered.length !== automation.length) {
      automation = filtered;
      changed = true;
    }
  }
  let lfos = next.lfos;
  if (!Array.isArray(lfos)) {
    lfos = [];
    changed = true;
  } else {
    const filtered = lfos.filter((lfo) => trackIds.has(lfo.trackId));
    if (filtered.length !== lfos.length) {
      lfos = filtered;
      changed = true;
    }
  }
  if (automation !== next.automation) next = { ...next, automation };
  if (lfos !== next.lfos) next = { ...next, lfos };

  // macros
  if (!Array.isArray(next.macros) || next.macros.length === 0) {
    next = { ...next, macros: defaultMacros() };
    changed = true;
  } else {
    // Update existing macros: forward-fill default source "macro" on mappings.
    let macrosChanged = false;
    const cleanedMacros: Macro[] = [];
    for (const macro of next.macros) {
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
      const validValue = Math.max(0, Math.min(1, Number(macro.value) || 0.5));
      if (validValue !== macro.value) macroChanged = true;
      if (cleanedMappings.length !== macro.mappings.length) macroChanged = true;
      if (macroChanged) macrosChanged = true;
      cleanedMacros.push({ ...macro, value: validValue, mappings: cleanedMappings });
    }
    if (macrosChanged) {
      next = { ...next, macros: cleanedMacros };
      changed = true;
    }
  }

  // scenes — backfill intensity (default 0.7) on older scenes.
  let scenesChanged = false;
  const cleanedScenes: Scene[] = next.scenes.map((scene) => {
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
    if (sceneChanged) scenesChanged = true;
    if (!sceneChanged) return scene;
    return { ...scene, intensity, intensityCurve: curve, loop };
  });
  if (scenesChanged) {
    next = { ...next, scenes: cleanedScenes };
    changed = true;
  }

  // project.key — clamp to valid MUSICAL_KEYS.
  if (next.key !== undefined && !isMusicalKey(next.key)) {
    next = { ...next, key: undefined };
    changed = true;
  }

  // project.tags — clamp to string[] (non-empty strings).
  if (next.tags !== undefined) {
    if (!Array.isArray(next.tags)) {
      next = { ...next, tags: [] };
      changed = true;
    } else {
      const cleanedTags = next.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "");
      if (cleanedTags.length !== next.tags.length) {
        next = { ...next, tags: cleanedTags };
        changed = true;
      }
    }
  }

  // markers — backfill array, clamp each.
  const totalProjectTicks = Math.max(
    0,
    ...next.scenes.map((s) => (next.patterns.find((p) => p.id === s.patternId)?.stepCount ?? 0) * STEP_TICKS),
    ...next.arrangement?.clips?.map((c) => (c.startBar + c.lengthBars) * BAR_TICKS) ?? [],
  );
  const cleanedMarkers = sanitizeMarkers(next.markers, totalProjectTicks);
  const markersChanged =
    !Array.isArray(next.markers) ||
    JSON.stringify(cleanedMarkers) !== JSON.stringify(next.markers);
  if (markersChanged) {
    next = { ...next, markers: cleanedMarkers };
    changed = true;
  }

  // scene automation — clamp to valid scenes + non-empty lanes.
  const liveSceneIds = new Set(next.scenes.map((s) => s.id));
  const cleanedSceneAuto = sanitizeSceneAutomation(next.sceneAutomation, liveSceneIds);
  // Only replace if the content actually changed (sanitize rebuilds objects,
  // so a reference equality check would always fail). JSON.stringify is fine
  // here — the structures are small and we run this on save/commit only.
  const sceneAutoChanged =
    !Array.isArray(next.sceneAutomation) ||
    JSON.stringify(cleanedSceneAuto) !== JSON.stringify(next.sceneAutomation);
  if (sceneAutoChanged) {
    next = { ...next, sceneAutomation: cleanedSceneAuto };
    changed = true;
  }
  // master — clamp gain + ceiling; backfill missing fields from defaults
  if (isObject(next.master)) {
    const m = next.master as Record<string, unknown>;
    const dg = clampMasterGain(m.masterGain);
    const dc = clampCeilingDb(m.ceilingDb);
    const dl = typeof m.limiterEnabled === "boolean" ? m.limiterEnabled : true;
    const dcl = typeof m.clipperEnabled === "boolean" ? m.clipperEnabled : false;
    if (
      dg !== m.masterGain ||
      dc !== m.ceilingDb ||
      dl !== m.limiterEnabled ||
      dcl !== m.clipperEnabled
    ) {
      next = { ...next, master: { masterGain: dg, ceilingDb: dc, limiterEnabled: dl, clipperEnabled: dcl } };
      changed = true;
    }
  }
  // returns
  if (!Array.isArray(next.returns)) {
    next = { ...next, returns: createDefaultReturns() };
    changed = true;
  }
  // master
  if (next.master === undefined || next.master === null || typeof next.master !== "object") {
    next = { ...next, master: defaultMasterConfig() };
    changed = true;
  }

  // createdAt / updatedAt
  if (typeof next.createdAt !== "string" || !Number.isFinite(Date.parse(next.createdAt))) {
    next = { ...next, createdAt: new Date().toISOString() };
    changed = true;
  }
  if (typeof next.updatedAt !== "string" || !Number.isFinite(Date.parse(next.updatedAt))) {
    next = { ...next, updatedAt: new Date().toISOString() };
    changed = true;
  }

  // groove — clamp optional swing/humanize settings
  if (next.groove !== undefined) {
    if (!isObject(next.groove)) {
      next = { ...next, groove: undefined };
      changed = true;
    } else {
      const g = next.groove;
      const swing = clampUnit(g.swing);
      const humanizeTiming = clampUnit(g.humanizeTiming);
      const humanizeVelocity = clampUnit(g.humanizeVelocity);
      if (swing !== g.swing || humanizeTiming !== g.humanizeTiming || humanizeVelocity !== g.humanizeVelocity) {
        next = { ...next, groove: { swing, humanizeTiming, humanizeVelocity } };
        changed = true;
      }
    }
  }

  // midi — sanitize optional MIDI config
  if (next.midi !== undefined) {
    if (!isObject(next.midi)) {
      next = { ...next, midi: undefined };
      changed = true;
    } else {
      const m = next.midi as Record<string, unknown>;
      const enabled = m.enabled === true;
      const deviceId = typeof m.deviceId === "string" ? m.deviceId : "";
      const drumChannel = typeof m.drumChannel === "number" ? Math.max(0, Math.min(16, m.drumChannel)) : 0;
      const instrumentChannel = typeof m.instrumentChannel === "number" ? Math.max(0, Math.min(16, m.instrumentChannel)) : 0;
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
        next = { ...next, midi: { enabled, deviceId, drumChannel, instrumentChannel, ccMappings, drumNoteMap, pitchBendRange } };
        changed = true;
      }
    }
  }

  // patterns: stepCount, rows, notes, stepMeta
  const padIds = new Set(allPadIds(next));
  let patternsChanged = false;
  const patterns = next.patterns.map((pattern) => {
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
        rows[padId] = new Array<number>(safeStepCount)
          .fill(0)
          .map((_, i) => (Array.isArray(row) ? (row[i] ?? 0) : 0));
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
    next = { ...next, patterns };
    changed = true;
  }

  return changed ? next : doc;
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
