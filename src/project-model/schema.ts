import type { DrumPad, DrumTrack, EffectInstance, InstrumentKind, InstrumentTrack, Macro, MasterConfig, Pattern, ProjectDocument, ReturnTrack, Scene } from "./types";
import { PPQ, STEPS_PER_PATTERN } from "./types";
import { uid } from "../shared/ids";
import { defaultInstrumentParams } from "../instruments/registry";

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
  return { limiterEnabled: true, clipperEnabled: false };
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

function starterGroove(pattern: Pattern, pads: DrumPad[]): Pattern {
  const rows = { ...pattern.rows };
  const set = (padIndex: number, steps: [number, number][]) => {
    const pad = pads[padIndex];
    const row = [...rows[pad.id]];
    for (const [step, velocity] of steps) row[step] = velocity;
    rows[pad.id] = row;
  };
  set(0, [[0, 0.95], [4, 0.95], [8, 0.95], [12, 0.95]]);
  set(6, [[4, 0.7], [12, 0.75]]);
  set(8, [[2, 0.5], [6, 0.5], [10, 0.5], [14, 0.55]]);
  set(10, [[14, 0.4]]);
  return { ...pattern, rows };
}

export function createDefaultProject(): ProjectDocument {
  const track: DrumTrack = {
    id: uid("track"),
    kind: "drum",
    name: "Drums",
    gain: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    pads: makeKit(),
    effects: [],
    sends: {},
  };
  const bass = createInstrumentTrackModel("808", 1);
  const pattern = starterGroove(
    {
      id: uid("pattern"),
      name: "Pattern A",
      stepCount: STEPS_PER_PATTERN,
      rows: emptyRows(track.pads.map((p) => p.id), STEPS_PER_PATTERN),
      notes: {
        [bass.id]: [
          { id: uid("note"), pitch: 28, start: 0, duration: PPQ / 2, velocity: 0.9 },
          { id: uid("note"), pitch: 28, start: 3 * (PPQ / 4), duration: PPQ / 2, velocity: 0.7 },
          { id: uid("note"), pitch: 31, start: 2 * PPQ, duration: PPQ / 2, velocity: 0.9 },
          { id: uid("note"), pitch: 28, start: 3 * PPQ, duration: PPQ / 2, velocity: 0.8 },
        ],
      },
    },
    track.pads,
  );
  const now = new Date().toISOString();
  const scene: Scene = { id: uid("scene"), name: "Groove", patternId: pattern.id };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid("project"),
    name: "Untitled Beat",
    bpm: 124,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [track, bass],
    patterns: [pattern],
    activePatternId: pattern.id,
    scenes: [scene],
    arrangement: { clips: [{ id: uid("clip"), sceneId: scene.id, startBar: 0, lengthBars: 4 }] },
    automation: [],
    lfos: [],
    macros: defaultMacros(),
    returns: createDefaultReturns(),
    master: defaultMasterConfig(),
    createdAt: now,
    updatedAt: now,
  };
}

export function defaultMacros(): Macro[] {
  return ["A", "B", "C", "D"].map((letter) => ({
    id: uid("macro"),
    name: `MACRO ${letter}`,
    value: 0.5,
    mappings: [],
  }));
}

/** Clamp a BPM value to the supported range. NaN/non-finite → FALLBACK_BPM. */
export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return FALLBACK_BPM;
  if (bpm < MIN_BPM) return MIN_BPM;
  if (bpm > MAX_BPM) return MAX_BPM;
  return bpm;
}

/** Validate a stepCount. Returns a safe positive integer or the fallback. */
export function normalizeStepCount(stepCount: number): number {
  if (!Number.isFinite(stepCount) || stepCount <= 0 || !Number.isInteger(stepCount)) {
    return FALLBACK_STEP_COUNT;
  }
  return stepCount;
}

function defaultSceneFor(doc: ProjectDocument): Scene {
  return { id: uid("scene"), name: "Scene A", patternId: doc.activePatternId };
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
  const tracks = next.tracks.map((track): DrumTrack | InstrumentTrack => {
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
      return t;
    }
    // instrument: merge params with defaults only when keys are missing or values differ
    const defaults = defaultInstrumentParams(track.instrument);
    let t: InstrumentTrack = track;
    let paramsChanged = false;
    const merged: Record<string, number> = { ...defaults };
    const paramsRecord: Record<string, number> = track.params ?? {};
    for (const k of Object.keys(defaults)) {
      const v = paramsRecord[k];
      if (v === undefined) {
        paramsChanged = true;
      } else if (v !== defaults[k]) {
        paramsChanged = true;
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

  // patterns: stepCount, rows, notes
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

export function validateProjectShape(doc: unknown): doc is ProjectDocument {
  if (typeof doc !== "object" || doc === null) return false;
  const d = doc as Record<string, unknown>;
  return (
    typeof d.schemaVersion === "number" &&
    typeof d.id === "string" &&
    typeof d.name === "string" &&
    typeof d.bpm === "number" &&
    Array.isArray(d.tracks) &&
    Array.isArray(d.patterns) &&
    typeof d.activePatternId === "string"
  );
}

export function beatsPerBar(doc: ProjectDocument): number {
  return doc.timeSignature.numerator;
}

export function ticksPerBar(doc: ProjectDocument): number {
  return PPQ * (4 / doc.timeSignature.denominator) * doc.timeSignature.numerator;
}
