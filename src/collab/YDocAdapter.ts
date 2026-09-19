/**
 * YDocAdapter — bidirectional converter between Y.Doc and ProjectDocument.
 *
 * Critical Y.js rule: Y types MUST be attached to a parent (via yMap.set)
 * BEFORE they can be modified. The adapter follows this pattern strictly:
 *   1. Create Y.Array/Y.Map
 *   2. Set on parent: parentMap.set("key", yType)
 *   3. Then modify: yType.push() / yType.set()
 */
import * as Y from "yjs";
import type {
  ArrangementClip,
  ArrangementTransition,
  AudioClip,
  AutomationLane,
  AutomationPoint,
  DrumPad,
  EffectInstance,
  FrozenState,
  GrooveSettings,
  Lfo,
  Macro,
  MacroMapping,
  Marker,
  MasterConfig,
  MidiConfig,
  NoteEvent,
  Pattern,
  PatternAssist,
  PatternGeneration,
  PatternPhraseBar,
  ProjectDocument,
  ReturnTrack,
  SampleLayer,
  Scene,
  SceneAutomation,
  StepMeta,
  Track,
} from "../project-model/types";

// ─── Y.Doc → ProjectDocument ────────────────────────────────────────────────

export function yDocToProject(yMap: Y.Map<unknown>): ProjectDocument {
  return yMapToProject(yMap);
}

function yMapToProject(m: Y.Map<unknown>): ProjectDocument {
  return {
    schemaVersion: (m.get("schemaVersion") as number) ?? 1,
    id: (m.get("id") as string) ?? "",
    name: (m.get("name") as string) ?? "",
    bpm: (m.get("bpm") as number) ?? 120,
    timeSignature: (plainValue(m.get("timeSignature")) as unknown as { numerator: number; denominator: number }) ?? {
      numerator: 4,
      denominator: 4,
    },
    key: m.get("key") as string | undefined as any,
    tags: listValue(m.get("tags")) as string[],
    tracks: yArrToList(m.get("tracks") as Y.Array<unknown>).map(yMapToTrack),
    patterns: yArrToList(m.get("patterns") as Y.Array<unknown>).map(yMapToPattern),
    activePatternId: (m.get("activePatternId") as string) ?? "",
    scenes: yArrToList(m.get("scenes") as Y.Array<unknown>).map(yMapToScene),
    arrangement: (() => {
      const arrangement = m.get("arrangement") as Y.Map<unknown> | undefined;
      return {
        clips: yArrToList(arrangement?.get("clips") as Y.Array<unknown>).map(yMapToClip),
        // Audio clips are plain-JSON entities (no nested Y types) — project
        // them as blobs. They were silently dropped before, which erased
        // every audio clip the moment a collab session opened.
        ...(arrangement?.has("audioClips")
          ? {
              audioClips: yArrToList(arrangement.get("audioClips") as Y.Array<unknown>).map(
                (v) => plainValue(v) as unknown as AudioClip,
              ),
            }
          : {}),
        ...(arrangement?.has("transitions")
          ? { transitions: yArrToList(arrangement.get("transitions") as Y.Array<unknown>).map(yMapToTransition) }
          : {}),
      };
    })(),
    markers: yArrToList(m.get("markers") as Y.Array<unknown>).map(yMapToMarker),
    sceneAutomation: yArrToList(m.get("sceneAutomation") as Y.Array<unknown>).map(yMapToSceneAutomation),
    automation: yArrToList(m.get("automation") as Y.Array<unknown>).map(yMapToAutomation),
    lfos: yArrToList(m.get("lfos") as Y.Array<unknown>).map(yMapToLfo),
    macros: yArrToList(m.get("macros") as Y.Array<unknown>).map(yMapToMacro),
    returns: yArrToList(m.get("returns") as Y.Array<unknown>).map(yMapToReturn),
    master: (plainValue(m.get("master")) as unknown as MasterConfig) ?? {
      masterGain: 1,
      ceilingDb: -1,
      limiterEnabled: true,
      clipperEnabled: false,
    },
    groove: m.has("groove") ? (plainValue(m.get("groove")) as unknown as Partial<GrooveSettings>) : undefined,
    midi: m.has("midi") ? (plainValue(m.get("midi")) as unknown as MidiConfig) : undefined,
    createdAt: (m.get("createdAt") as string) ?? "",
    updatedAt: (m.get("updatedAt") as string) ?? "",
  };
}

function yMapToTrack(m: unknown): Track {
  const map = m as Y.Map<unknown>;
  const kind = map.get("kind") as string;
  const base = {
    id: map.get("id") as string,
    name: map.get("name") as string,
    gain: map.get("gain") as number,
    pan: map.get("pan") as number,
    mute: map.get("mute") as boolean,
    solo: map.get("solo") as boolean,
    effects: yArrToList(map.get("effects") as Y.Array<unknown>).map(yMapToEffect),
    sends: yMapToRecord(map.get("sends") as Y.Map<unknown>),
    groupId: map.get("groupId") as string | undefined,
    color: map.has("color") ? (map.get("color") as string) : undefined,
    frozen: map.has("frozen") ? (yMapToObj(map.get("frozen") as Y.Map<unknown>) as unknown as FrozenState) : undefined,
  };
  if (kind === "drum") {
    return { ...base, kind: "drum", pads: yArrToList(map.get("pads") as Y.Array<unknown>).map(yMapToPad) };
  }
  if (kind === "group") {
    return {
      ...base,
      kind: "group",
      collapsed: map.has("collapsed") ? (map.get("collapsed") as boolean) : undefined,
    };
  }
  return {
    ...base,
    kind: "instrument",
    instrument: map.get("instrument") as any,
    sampleId: map.get("sampleId") as string | null,
    params: yMapToRecord(map.get("params") as Y.Map<unknown>),
    presetId: map.get("presetId") as string | null | undefined,
    midiOutput: map.has("midiOutput") ? (yMapToObj(map.get("midiOutput") as Y.Map<unknown>) as any) : undefined,
    ...(map.has("velocityLayers")
      ? { velocityLayers: plainValue(map.get("velocityLayers")) as unknown as SampleLayer[] }
      : {}),
  };
}

function yMapToPad(m: unknown): DrumPad {
  const map = m as Y.Map<unknown>;
  const synthRaw = map.get("synth") as Y.Map<unknown> | undefined;
  let synth: DrumPad["synth"] | undefined;
  if (synthRaw && synthRaw instanceof Y.Map) {
    synth = {
      type: synthRaw.get("type") as DrumPad["synth"] extends { type: infer T } ? T : never,
      decay: synthRaw.get("decay") as number,
      tone: synthRaw.get("tone") as number,
      snap: synthRaw.get("snap") as number,
      body: synthRaw.get("body") as number,
    } as DrumPad["synth"];
  }
  const base: DrumPad = {
    id: map.get("id") as string,
    name: map.get("name") as string,
    assetId: map.get("assetId") as string | null,
    gain: map.get("gain") as number,
    pan: map.get("pan") as number,
    pitch: map.get("pitch") as number,
    mute: map.get("mute") as boolean,
    solo: map.get("solo") as boolean,
    chokeGroup: map.get("chokeGroup") as number | null,
    color: map.has("color") ? (map.get("color") as string) : undefined,
    sliceLoop: map.has("sliceLoop") ? (map.get("sliceLoop") as boolean) : undefined,
    sliceLoopStart: map.has("sliceLoopStart") ? (map.get("sliceLoopStart") as number) : undefined,
    sliceLoopEnd: map.has("sliceLoopEnd") ? (map.get("sliceLoopEnd") as number) : undefined,
    sliceStart: map.has("sliceStart") ? (map.get("sliceStart") as number) : undefined,
    sliceEnd: map.has("sliceEnd") ? (map.get("sliceEnd") as number) : undefined,
    sliceFadeIn: map.has("sliceFadeIn") ? (map.get("sliceFadeIn") as number) : undefined,
    sliceFadeOut: map.has("sliceFadeOut") ? (map.get("sliceFadeOut") as number) : undefined,
    sliceReverse: map.has("sliceReverse") ? (map.get("sliceReverse") as boolean) : undefined,
    ...(map.has("mod") ? { mod: (plainValue(map.get("mod")) as unknown as DrumPad["mod"]) ?? null } : {}),
  } as DrumPad;
  if (synth) (base as unknown as { synth: DrumPad["synth"] }).synth = synth;
  return base;
}

function yMapToEffect(m: unknown): EffectInstance {
  const map = m as Y.Map<unknown>;
  const rawSteps = map.get("steps");
  const rawDeviceState = map.get("deviceState");
  return {
    id: map.get("id") as string,
    type: map.get("type") as any,
    bypassed: map.get("bypassed") as boolean,
    params: yMapToRecord(map.get("params") as Y.Map<unknown>),
    steps: Array.isArray(rawSteps) ? rawSteps.map((v) => Number(v) || 0) : undefined,
    sidechainTrackId: map.get("sidechainTrackId") as string | undefined,
    deviceState:
      rawDeviceState && typeof rawDeviceState === "object"
        ? (plainValue(rawDeviceState) as EffectInstance["deviceState"])
        : undefined,
  };
}

function yMapToPattern(m: unknown): Pattern {
  const map = m as Y.Map<unknown>;
  const rowsMap = map.get("rows") as Y.Map<unknown>;
  const rows: Record<string, number[]> = {};
  if (rowsMap) {
    rowsMap.forEach((val, key) => {
      rows[key as string] = (val as Y.Array<number>).toArray();
    });
  }
  const notesMap = map.get("notes") as Y.Map<unknown>;
  const notes: Record<string, NoteEvent[]> = {};
  if (notesMap) {
    notesMap.forEach((val, key) => {
      notes[key as string] = yArrToList(val as Y.Array<unknown>).map(yMapToNote);
    });
  }
  const metaMap = map.get("stepMeta") as Y.Map<unknown>;
  const stepMeta: Record<string, Record<number, StepMeta>> = {};
  if (metaMap) {
    metaMap.forEach((padMeta, padId) => {
      const inner = padMeta as Y.Map<unknown>;
      const padSteps: Record<number, StepMeta> = {};
      inner.forEach((stepMeta, stepIdx) => {
        padSteps[Number(stepIdx)] = yMapToObj(stepMeta as Y.Map<unknown>) as unknown as StepMeta;
      });
      stepMeta[padId as string] = padSteps;
    });
  }
  return {
    id: map.get("id") as string,
    name: map.get("name") as string,
    stepCount: map.get("stepCount") as number,
    rows,
    notes,
    stepMeta: Object.keys(stepMeta).length > 0 ? stepMeta : undefined,
    // AI provenance — plain JSON values written by the adapter. Dropped here
    // once meant recipe-based variation and Assist hashes silently died after
    // any collaborative edit.
    generation: map.has("generation") ? (plainValue(map.get("generation")) as unknown as PatternGeneration) : undefined,
    assist: map.has("assist") ? (plainValue(map.get("assist")) as unknown as PatternAssist) : undefined,
    phrasePlan: map.has("phrasePlan")
      ? (plainValue(map.get("phrasePlan")) as unknown as PatternPhraseBar[])
      : undefined,
  };
}

function yMapToNote(m: unknown): NoteEvent {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    pitch: map.get("pitch") as number,
    start: map.get("start") as number,
    duration: map.get("duration") as number,
    velocity: map.get("velocity") as number,
  };
}

function yMapToScene(m: unknown): Scene {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    name: map.get("name") as string,
    patternId: map.get("patternId") as string,
    intensity: map.get("intensity") as number,
    intensityCurve: map.has("intensityCurve")
      ? (yArrToList(map.get("intensityCurve") as Y.Array<unknown>).map((v) => yMapToObj(v as Y.Map<unknown>)) as any)
      : undefined,
    loop: map.get("loop") as boolean | undefined,
    role: map.get("role") as Scene["role"],
    bpm: map.has("bpm") ? (map.get("bpm") as number) : undefined,
  };
}

function yMapToClip(m: unknown): ArrangementClip {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    sceneId: map.get("sceneId") as string,
    startBar: map.get("startBar") as number,
    lengthBars: map.get("lengthBars") as number,
    loop: map.get("loop") as boolean | undefined,
  };
}

function yMapToTransition(m: unknown): ArrangementTransition {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    fromClipId: map.get("fromClipId") as string,
    toClipId: map.get("toClipId") as string,
    type: map.get("type") as ArrangementTransition["type"],
    lengthBars: map.get("lengthBars") as number,
    cueAssetId: map.get("cueAssetId") as string | undefined,
  };
}

function yMapToMarker(m: unknown): Marker {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    name: map.get("name") as string,
    type: map.get("type") as any,
    tick: map.get("tick") as number,
    linkedClipId: map.get("linkedClipId") as string | undefined,
    customId: map.get("customId") as string | undefined,
  };
}

// Points are written as Y.Maps (via objToYMap) — fields must be read with
// .get(), plain property access on a Y.Map always yields undefined.
function yPointToAutomation(p: unknown): AutomationPoint {
  if (!(p instanceof Y.Map)) return { tick: 0, value: 0 };
  return { tick: Number(p.get("tick")) || 0, value: Number(p.get("value")) || 0 };
}

function yMapToAutomation(m: unknown): AutomationLane {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    target: yMapToObj(map.get("target") as Y.Map<unknown>) as unknown as AutomationLane["target"],
    points: yArrToList(map.get("points") as Y.Array<unknown>).map(yPointToAutomation),
  };
}

function yMapToSceneAutomation(m: unknown): SceneAutomation {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    sceneId: map.get("sceneId") as string,
    target: yMapToObj(map.get("target") as Y.Map<unknown>) as unknown as SceneAutomation["target"],
    points: yArrToList(map.get("points") as Y.Array<unknown>).map(yPointToAutomation),
  };
}

function yMapToLfo(m: unknown): Lfo {
  return yMapToObj(m as Y.Map<unknown>) as unknown as Lfo;
}

function yMapToMacro(m: unknown): Macro {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    name: map.get("name") as string,
    value: map.get("value") as number,
    mappings: yArrToList(map.get("mappings") as Y.Array<unknown>).map(
      (v) => yMapToObj(v as Y.Map<unknown>) as unknown as MacroMapping,
    ),
  };
}

function yMapToReturn(m: unknown): ReturnTrack {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    kind: "return",
    name: map.get("name") as string,
    gain: map.get("gain") as number,
    effects: yArrToList(map.get("effects") as Y.Array<unknown>).map(yMapToEffect),
  };
}

// ─── ProjectDocument → Y.Doc ────────────────────────────────────────────────

// ─── Targeted-diff helpers ──────────────────────────────────────────────────
//
// The fallback path for commands without applyToYDoc used to RECREATE every
// collection from the command's (possibly stale) `next` document — silently
// erasing concurrent peer edits. The helpers below instead sync a ProjectDocument
// into an existing Y.Map structurally:
//   - entities are matched by id: updated IN PLACE, inserted, removed, moved
//   - scalar fields are written only when the value actually differs (LWW)
//   - blob fields are replaced only when their JSON content differs
// so a command only ever writes what it actually changed.

function plainValue(value: unknown): unknown {
  if (value instanceof Y.Array) return value.toArray().map(plainValue);
  if (value instanceof Y.Map) {
    const out: Record<string, unknown> = {};
    value.forEach((v, k) => {
      out[k] = plainValue(v);
    });
    return out;
  }
  return value;
}

function listValue(value: unknown): unknown[] {
  if (value instanceof Y.Array) return value.toArray();
  if (Array.isArray(value)) return value;
  return [];
}

function plainEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function setIfChanged(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (plainEquals(map.get(key), value)) return;
  map.set(key, value);
}

/** undefined removes the key; otherwise write only when the value differs. */
function setOrDelete(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    if (map.has(key)) map.delete(key);
    return;
  }
  setIfChanged(map, key, value);
}

/** Mirror ALL keys of a plain object into a Y.Map (absent keys are deleted). */
function syncPlainFields(target: Y.Map<unknown>, source: Record<string, unknown>): void {
  for (const key of Array.from(target.keys())) {
    if (!(key in source)) target.delete(key);
  }
  for (const [key, value] of Object.entries(source)) {
    setOrDelete(target, key, value);
  }
}

/** Mirror a fixed list of scalar fields (undefined deletes). */
function mirrorScalars(target: Y.Map<unknown>, source: unknown, keys: string[]): void {
  const record = source as Record<string, unknown>;
  for (const key of keys) setOrDelete(target, key, record[key]);
}

function ensureChildMap(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
  let child = parent.get(key) as Y.Map<unknown> | undefined;
  if (!(child instanceof Y.Map)) {
    child = new Y.Map<unknown>();
    parent.set(key, child);
  }
  return child;
}

function ensureChildArray(parent: Y.Map<unknown>, key: string): Y.Array<unknown> {
  let child = parent.get(key) as Y.Array<unknown> | undefined;
  if (!(child instanceof Y.Array)) {
    child = new Y.Array<unknown>();
    parent.set(key, child);
  }
  return child;
}

/**
 * Sync an id-keyed entity list: remove stale ids, update survivors in place,
 * insert new entities, and move misplaced ones (delete + insert of the SAME
 * Y.Map keeps entity identity intact for concurrent merges).
 */
function syncIdList<T extends { id: string }>(
  arr: Y.Array<unknown>,
  items: T[],
  syncEntity: (target: Y.Map<unknown>, item: T) => void,
  createEntity: (item: T) => Y.Map<unknown>,
): void {
  const desiredIds = new Set(items.map((item) => item.id));

  const indexIds = (): Map<string, number> => {
    const positions = new Map<string, number>();
    for (let i = 0; i < arr.length; i++) {
      const id = (arr.get(i) as Y.Map<unknown>).get("id") as string | undefined;
      positions.set(id ?? "", i);
    }
    return positions;
  };

  // 1. Removals — descending so indices stay valid.
  for (let i = arr.length - 1; i >= 0; i--) {
    const id = (arr.get(i) as Y.Map<unknown>).get("id") as string | undefined;
    if (!desiredIds.has(id ?? "")) arr.delete(i, 1);
  }

  // 2. Updates / inserts / moves in desired order.
  let positions = indexIds();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const at = positions.get(item.id);
    if (at === undefined) {
      arr.insert(i, [createEntity(item)]);
      positions = indexIds();
    } else if (at !== i) {
      const ref = arr.get(at) as Y.Map<unknown>;
      syncEntity(ref, item);
      arr.delete(at, 1);
      arr.insert(i, [ref]);
      positions = indexIds();
    } else {
      syncEntity(arr.get(i) as Y.Map<unknown>, item);
    }
  }
}

/** Replace a plain-JSON blob field only when its content actually differs. */
function syncPlainJsonField(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    if (map.has(key)) map.delete(key);
    return;
  }
  setIfChanged(map, key, plainValue(value));
}

/**
 * Replace a Y.Array of plain strings only when content differs.
 */
function syncStringArray(map: Y.Map<unknown>, key: string, values: string[]): void {
  const current = map.get(key);
  const currentJson = current instanceof Y.Array ? JSON.stringify(current.toArray()) : JSON.stringify(current ?? null);
  if (currentJson === JSON.stringify(values)) return;
  if (map.has(key)) map.delete(key);
  const arr = new Y.Array<string>();
  map.set(key, arr);
  if (values.length) arr.push(values);
}

/**
 * Replace a nested Y container (array of Y.Maps) only when its JSON content
 * differs — preserves the representation readers expect without churning
 * Y identities on every apply.
 */
function syncBlobContainer(
  map: Y.Map<unknown>,
  key: string,
  items: unknown[],
  createItem: (item: unknown) => Y.Map<unknown>,
): void {
  const current = map.get(key);
  const currentJson =
    current instanceof Y.Array ? JSON.stringify(current.toArray().map((v) => plainValue(v))) : undefined;
  if (currentJson !== undefined && currentJson === JSON.stringify(items)) return;
  if (current !== undefined) map.delete(key);
  const arr = new Y.Array<unknown>();
  map.set(key, arr);
  for (const item of items) arr.push([createItem(item)]);
}

// ─── Entity sync (targeted diff) ────────────────────────────────────────────

const TRACK_SCALARS = [
  "kind",
  "name",
  "gain",
  "pan",
  "mute",
  "solo",
  "groupId",
  "instrument",
  "sampleId",
  "presetId",
  "color",
  "collapsed",
];
const PAD_SCALARS = [
  "name",
  "assetId",
  "gain",
  "pan",
  "pitch",
  "mute",
  "solo",
  "chokeGroup",
  "color",
  "sliceLoop",
  "sliceLoopStart",
  "sliceLoopEnd",
  "sliceStart",
  "sliceEnd",
  "sliceFadeIn",
  "sliceFadeOut",
  "sliceReverse",
];
const EFFECT_SCALARS = ["type", "bypassed", "sidechainTrackId"];
const NOTE_SCALARS = ["pitch", "start", "duration", "velocity"];
const SCENE_SCALARS = ["name", "patternId", "intensity", "loop", "role", "bpm"];
const CLIP_SCALARS = ["sceneId", "startBar", "lengthBars", "loop"];
const TRANSITION_SCALARS = ["fromClipId", "toClipId", "type", "lengthBars", "cueAssetId"];
const MARKER_SCALARS = ["name", "type", "tick", "linkedClipId", "customId"];
const MACRO_SCALARS = ["name", "value"];

function syncTrackEntity(target: Y.Map<unknown>, track: Track): void {
  mirrorScalars(target, track, TRACK_SCALARS);

  syncIdList(ensureChildArray(target, "effects"), track.effects, syncEffectEntity, effectToYMap);
  syncPlainFields(ensureChildMap(target, "sends"), track.sends);

  if (track.kind === "drum") {
    syncIdList(ensureChildArray(target, "pads"), track.pads, syncPadEntity, padToYMap);
  } else if (track.kind === "instrument") {
    syncPlainFields(ensureChildMap(target, "params"), track.params);
    // Velocity/round-robin layers — plain JSON blob (replaced on change).
    syncPlainJsonField(target, "velocityLayers", track.velocityLayers);
    if (track.midiOutput) {
      syncPlainFields(ensureChildMap(target, "midiOutput"), track.midiOutput as unknown as Record<string, unknown>);
    } else if (target.has("midiOutput")) {
      target.delete("midiOutput");
    }
  }

  if (track.frozen) {
    syncPlainFields(ensureChildMap(target, "frozen"), track.frozen as unknown as Record<string, unknown>);
  } else if (target.has("frozen")) {
    target.delete("frozen");
  }
}

function syncPadEntity(target: Y.Map<unknown>, pad: DrumPad): void {
  mirrorScalars(target, pad, PAD_SCALARS);
  // Per-pad voice LFO — plain JSON blob (nested object, not a scalar).
  syncPlainJsonField(target, "mod", pad.mod ?? undefined);
  if (pad.synth) {
    const synthMap = ensureChildMap(target, "synth");
    synthMap.set("type", pad.synth.type);
    synthMap.set("decay", pad.synth.decay);
    synthMap.set("tone", pad.synth.tone);
    synthMap.set("snap", pad.synth.snap);
    synthMap.set("body", pad.synth.body);
  } else if (target.has("synth")) {
    target.delete("synth");
  }
}

function syncEffectEntity(target: Y.Map<unknown>, fx: EffectInstance): void {
  mirrorScalars(target, fx, EFFECT_SCALARS);
  syncPlainFields(ensureChildMap(target, "params"), fx.params);
  // Plugin editor state (A/B snapshots) — plain JSON blob, replaced on change.
  syncPlainJsonField(target, "deviceState", fx.deviceState);
  // Step-gate pattern: replaced wholesale on every sync (small array).
  if (fx.steps) {
    const steps = ensureChildArray(target, "steps");
    if (steps.length !== fx.steps.length || steps.toArray().some((v, i) => (Number(v) || 0) !== fx.steps![i])) {
      steps.delete(0, steps.length);
      steps.insert(0, [...fx.steps]);
    }
  } else if (target.has("steps")) {
    target.delete("steps");
  }
}

function syncPatternEntity(target: Y.Map<unknown>, pattern: Pattern): void {
  setIfChanged(target, "name", pattern.name);
  setIfChanged(target, "stepCount", pattern.stepCount);

  // AI provenance — plain JSON blobs (recipe, assist hashes, phrase plan).
  syncPlainJsonField(target, "generation", pattern.generation);
  syncPlainJsonField(target, "assist", pattern.assist);
  syncPlainJsonField(target, "phrasePlan", pattern.phrasePlan);

  // Rows: padId → Y.Array<number>, per-cell granularity.
  const rowsMap = ensureChildMap(target, "rows");
  for (const key of Array.from(rowsMap.keys())) {
    if (!(key in pattern.rows)) rowsMap.delete(key);
  }
  for (const [padId, row] of Object.entries(pattern.rows)) {
    let yRow = rowsMap.get(padId) as Y.Array<number> | undefined;
    if (!yRow || !(yRow instanceof Y.Array)) {
      yRow = new Y.Array<number>();
      rowsMap.set(padId, yRow);
    }
    if (yRow.length > row.length) yRow.delete(row.length, yRow.length - row.length);
    for (let i = 0; i < row.length; i++) {
      const current = i < yRow.length ? yRow.get(i) : undefined;
      if (current === undefined) yRow.insert(i, [row[i]]);
      else if (current !== row[i]) {
        yRow.delete(i, 1);
        yRow.insert(i, [row[i]]);
      }
    }
  }

  // Notes: trackId → id-keyed note entities.
  const notesMap = ensureChildMap(target, "notes");
  for (const key of Array.from(notesMap.keys())) {
    if (!(key in (pattern.notes ?? {}))) notesMap.delete(key);
  }
  for (const [trackId, list] of Object.entries(pattern.notes ?? {})) {
    syncIdList(ensureChildArray(notesMap, trackId), list, syncNoteEntity, noteToYMap);
  }

  // StepMeta: padId → stepIndex → meta fields.
  if (pattern.stepMeta && Object.keys(pattern.stepMeta).length > 0) {
    const metaMap = ensureChildMap(target, "stepMeta");
    for (const key of Array.from(metaMap.keys())) {
      if (!(key in pattern.stepMeta)) metaMap.delete(key);
    }
    for (const [padId, steps] of Object.entries(pattern.stepMeta)) {
      let inner = metaMap.get(padId) as Y.Map<unknown> | undefined;
      if (!(inner instanceof Y.Map)) {
        inner = new Y.Map<unknown>();
        metaMap.set(padId, inner);
      }
      const stepKeys = new Set(Object.keys(steps));
      for (const key of Array.from(inner.keys())) {
        if (!stepKeys.has(key)) inner.delete(key);
      }
      for (const [stepKey, meta] of Object.entries(steps)) {
        let stepMap = inner.get(stepKey) as Y.Map<unknown> | undefined;
        if (!(stepMap instanceof Y.Map)) {
          stepMap = new Y.Map<unknown>();
          inner.set(stepKey, stepMap);
        }
        syncPlainFields(stepMap, meta as unknown as Record<string, unknown>);
      }
    }
  } else if (target.has("stepMeta")) {
    target.delete("stepMeta");
  }
}

function syncNoteEntity(target: Y.Map<unknown>, note: NoteEvent): void {
  mirrorScalars(target, note, NOTE_SCALARS);
}

function syncSceneEntity(target: Y.Map<unknown>, scene: Scene): void {
  mirrorScalars(target, scene, SCENE_SCALARS);
  if (scene.intensityCurve) {
    syncBlobContainer(target, "intensityCurve", scene.intensityCurve, (pt) => objToYMap(pt as Record<string, unknown>));
  } else if (target.has("intensityCurve")) {
    target.delete("intensityCurve");
  }
}

function syncClipEntity(target: Y.Map<unknown>, clip: ArrangementClip): void {
  mirrorScalars(target, clip, CLIP_SCALARS);
}

function syncTransitionEntity(target: Y.Map<unknown>, transition: ArrangementTransition): void {
  mirrorScalars(target, transition, TRANSITION_SCALARS);
}

function syncMarkerEntity(target: Y.Map<unknown>, marker: Marker): void {
  mirrorScalars(target, marker, MARKER_SCALARS);
}

function syncAutomationEntity(target: Y.Map<unknown>, lane: AutomationLane): void {
  syncPlainFields(ensureChildMap(target, "target"), lane.target as unknown as Record<string, unknown>);
  syncPoints(ensureChildArray(target, "points"), lane.points);
}

function syncSceneAutomationEntity(target: Y.Map<unknown>, lane: SceneAutomation): void {
  setIfChanged(target, "sceneId", lane.sceneId);
  syncPlainFields(ensureChildMap(target, "target"), lane.target as unknown as Record<string, unknown>);
  syncPoints(ensureChildArray(target, "points"), lane.points);
}

function syncPoints(pointsArr: Y.Array<unknown>, points: AutomationPoint[]): void {
  if (pointsArr.length > points.length) pointsArr.delete(points.length, pointsArr.length - points.length);
  for (let i = 0; i < points.length; i++) {
    if (i >= pointsArr.length) {
      pointsArr.insert(i, [objToYMap(points[i] as unknown as Record<string, unknown>)]);
      continue;
    }
    const target = pointsArr.get(i) as Y.Map<unknown>;
    setIfChanged(target, "tick", points[i].tick);
    setIfChanged(target, "value", points[i].value);
  }
}

function syncLfoEntity(target: Y.Map<unknown>, lfo: Lfo): void {
  // LFOs are a loose flat shape (forward-compatible) — mirror every key.
  syncPlainFields(target, lfo as unknown as Record<string, unknown>);
}

function syncMacroEntity(target: Y.Map<unknown>, macro: Macro): void {
  mirrorScalars(target, macro, MACRO_SCALARS);
  syncIdList(
    ensureChildArray(target, "mappings"),
    macro.mappings,
    (map, mapping) => syncPlainFields(map, mapping as unknown as Record<string, unknown>),
    (mapping) => objToYMap(mapping as unknown as Record<string, unknown>),
  );
}

function syncReturnEntity(target: Y.Map<unknown>, ret: ReturnTrack): void {
  mirrorScalars(target, ret, ["name", "gain"]);
  syncIdList(ensureChildArray(target, "effects"), ret.effects, syncEffectEntity, effectToYMap);
}

/**
 * Apply a new ProjectDocument to an existing Y.Map as a TARGETED DIFF:
 * scalar fields are compared before writing, id-keyed collections are synced
 * per entity (in-place updates, inserts, removals, moves), nested blobs are
 * replaced only when their content changes. Unlike the previous whole-
 * collection rebuild, a fallback command no longer erases concurrent peer
 * edits to entities it did not touch — and applying an identical document is
 * a no-op. Runs inside the caller's transaction.
 */
export function applyProjectToYMap(_oldDoc: ProjectDocument, newDoc: ProjectDocument, yMap: Y.Map<unknown>): void {
  // Scalar fields (compare-before-set — same client, higher clock wins LWW)
  setIfChanged(yMap, "schemaVersion", newDoc.schemaVersion);
  setIfChanged(yMap, "id", newDoc.id);
  setIfChanged(yMap, "name", newDoc.name);
  setIfChanged(yMap, "bpm", newDoc.bpm);
  setIfChanged(yMap, "activePatternId", newDoc.activePatternId);
  setIfChanged(yMap, "createdAt", newDoc.createdAt);
  setIfChanged(yMap, "updatedAt", newDoc.updatedAt);
  setOrDelete(yMap, "key", newDoc.key);

  // Tags — Y.Array of plain strings, replaced only when content differs.
  syncStringArray(yMap, "tags", newDoc.tags ?? []);

  // timeSignature
  const ts = ensureChildMap(yMap, "timeSignature");
  setIfChanged(ts, "numerator", newDoc.timeSignature.numerator);
  setIfChanged(ts, "denominator", newDoc.timeSignature.denominator);

  syncIdList(ensureChildArray(yMap, "tracks"), newDoc.tracks, syncTrackEntity, trackToYMap);
  syncIdList(ensureChildArray(yMap, "patterns"), newDoc.patterns, syncPatternEntity, patternToYMap);
  syncIdList(ensureChildArray(yMap, "scenes"), newDoc.scenes, syncSceneEntity, sceneToYMap);
  syncIdList(ensureChildArray(yMap, "markers"), newDoc.markers, syncMarkerEntity, markerToYMap);
  syncIdList(
    ensureChildArray(yMap, "sceneAutomation"),
    newDoc.sceneAutomation,
    syncSceneAutomationEntity,
    sceneAutoToYMap,
  );
  syncIdList(ensureChildArray(yMap, "automation"), newDoc.automation, syncAutomationEntity, automationToYMap);
  syncIdList(ensureChildArray(yMap, "lfos"), newDoc.lfos, syncLfoEntity, lfoToYMap);
  syncIdList(ensureChildArray(yMap, "macros"), newDoc.macros, syncMacroEntity, macroToYMap);
  syncIdList(ensureChildArray(yMap, "returns"), newDoc.returns, syncReturnEntity, returnToYMap);

  // Arrangement
  const arrangement = ensureChildMap(yMap, "arrangement");
  syncIdList(ensureChildArray(arrangement, "clips"), newDoc.arrangement.clips, syncClipEntity, clipToYMap);
  // Audio clips — plain-JSON entities mirrored as a blob container so peers
  // see them (they were silently dropped before this sync existed).
  if (newDoc.arrangement.audioClips !== undefined) {
    syncBlobContainer(arrangement, "audioClips", newDoc.arrangement.audioClips, (item) =>
      objToYMap(item as Record<string, unknown>),
    );
  } else if (arrangement.has("audioClips")) {
    arrangement.delete("audioClips");
  }
  if (newDoc.arrangement.transitions !== undefined) {
    syncIdList(
      ensureChildArray(arrangement, "transitions"),
      newDoc.arrangement.transitions,
      syncTransitionEntity,
      transitionToYMap,
    );
  } else if (arrangement.has("transitions")) {
    arrangement.delete("transitions");
  }
  // Master — mirror every MasterConfig field, otherwise collab round-trips
  // silently drop the newer keys (lufsTarget/tape/ms vanished for peers).
  const master = ensureChildMap(yMap, "master");
  mirrorScalars(master, newDoc.master, [
    "masterGain",
    "ceilingDb",
    "limiterEnabled",
    "clipperEnabled",
    "tapeEnabled",
    "tapeDrive",
    "msEnabled",
    "msMidGain",
    "msSideGain",
    "lufsTarget",
    "glueEnabled",
    "bassMonoEnabled",
    "bassMonoFreq",
  ]);

  // Groove
  if (newDoc.groove) {
    syncPlainFields(ensureChildMap(yMap, "groove"), newDoc.groove as unknown as Record<string, unknown>);
  } else if (yMap.has("groove")) {
    yMap.delete("groove");
  }

  // MIDI
  if (newDoc.midi) {
    const midiMap = ensureChildMap(yMap, "midi");
    mirrorScalars(midiMap, newDoc.midi, [
      "enabled",
      "deviceId",
      "drumChannel",
      "instrumentChannel",
      "pitchBendRange",
      "clockMode",
      "bankSelect",
      "aftertouchTarget",
      "aftertouchRange",
    ]);
    syncPlainJsonField(midiMap, "ccMappings", newDoc.midi.ccMappings);
    syncPlainJsonField(midiMap, "drumNoteMap", newDoc.midi.drumNoteMap);
    syncPlainJsonField(midiMap, "programMap", newDoc.midi.programMap);
  } else if (yMap.has("midi")) {
    yMap.delete("midi");
  }
}

export function projectToYDoc(doc: ProjectDocument, yMap: Y.Map<unknown>): void {
  const yDoc = yMap.doc!;
  yDoc.transact(() => {
    applyProjectToYMap(doc, doc, yMap);
  });
}

function lfoToYMap(lfo: Lfo): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(lfo)) {
    m.set(k, v);
  }
  return m;
}

// ─── Entity converters (ProjectDocument → Y.Map) ───────────────────────────

function trackToYMap(track: Track): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", track.id);
  m.set("kind", track.kind);
  m.set("name", track.name);
  m.set("gain", track.gain);
  m.set("pan", track.pan);
  m.set("mute", track.mute);
  m.set("solo", track.solo);
  if ("groupId" in track && track.groupId) m.set("groupId", track.groupId);
  // Keep in lockstep with TRACK_SCALARS — the insert path of syncIdList
  // builds entities with THIS creator, so fields only listed in the scalar
  // mirror would silently vanish at session seed.
  if (track.color) m.set("color", track.color);
  if (track.kind === "group" && track.collapsed !== undefined) m.set("collapsed", track.collapsed);
  if (track.frozen) m.set("frozen", objToYMap(track.frozen as unknown as Record<string, unknown>));

  // Effects
  const effects = new Y.Array<unknown>();
  m.set("effects", effects);
  for (const fx of track.effects) {
    effects.push([effectToYMap(fx)]);
  }

  // Sends
  const sends = new Y.Map<unknown>();
  m.set("sends", sends);
  for (const [k, v] of Object.entries(track.sends)) {
    sends.set(k, v);
  }

  if (track.kind === "drum") {
    const pads = new Y.Array<unknown>();
    m.set("pads", pads);
    for (const pad of track.pads) {
      pads.push([padToYMap(pad)]);
    }
  } else if (track.kind === "instrument") {
    m.set("instrument", track.instrument);
    m.set("sampleId", track.sampleId);
    const params = new Y.Map<unknown>();
    m.set("params", params);
    for (const [k, v] of Object.entries(track.params)) {
      params.set(k, v);
    }
    if (track.presetId !== undefined) m.set("presetId", track.presetId);
    if (track.velocityLayers) m.set("velocityLayers", plainValue(track.velocityLayers));
    if (track.midiOutput) {
      const mo = new Y.Map<unknown>();
      m.set("midiOutput", mo);
      mo.set("enabled", track.midiOutput.enabled);
      mo.set("channel", track.midiOutput.channel);
      if (track.midiOutput.deviceId) mo.set("deviceId", track.midiOutput.deviceId);
    }
  }
  return m;
}

function padToYMap(pad: DrumPad): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", pad.id);
  m.set("name", pad.name);
  m.set("assetId", pad.assetId);
  m.set("gain", pad.gain);
  m.set("pan", pad.pan);
  m.set("pitch", pad.pitch);
  m.set("mute", pad.mute);
  m.set("solo", pad.solo);
  m.set("chokeGroup", pad.chokeGroup);
  // Keep in lockstep with PAD_SCALARS — syncIdList's insert path builds pads
  // with THIS creator (fields only in the scalar mirror would vanish at seed).
  if (pad.color) m.set("color", pad.color);
  if (pad.sliceLoop !== undefined) m.set("sliceLoop", pad.sliceLoop);
  if (pad.sliceLoopStart !== undefined) m.set("sliceLoopStart", pad.sliceLoopStart);
  if (pad.sliceLoopEnd !== undefined) m.set("sliceLoopEnd", pad.sliceLoopEnd);
  if (pad.sliceStart !== undefined) m.set("sliceStart", pad.sliceStart);
  if (pad.sliceEnd !== undefined) m.set("sliceEnd", pad.sliceEnd);
  if (pad.sliceFadeIn !== undefined) m.set("sliceFadeIn", pad.sliceFadeIn);
  if (pad.sliceFadeOut !== undefined) m.set("sliceFadeOut", pad.sliceFadeOut);
  if (pad.sliceReverse !== undefined) m.set("sliceReverse", pad.sliceReverse);
  if (pad.mod) m.set("mod", plainValue(pad.mod));
  if (pad.synth) {
    const synthMap = new Y.Map<unknown>();
    synthMap.set("type", pad.synth.type);
    synthMap.set("decay", pad.synth.decay);
    synthMap.set("tone", pad.synth.tone);
    synthMap.set("snap", pad.synth.snap);
    synthMap.set("body", pad.synth.body);
    m.set("synth", synthMap);
  }
  return m;
}

function effectToYMap(fx: EffectInstance): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", fx.id);
  m.set("type", fx.type);
  m.set("bypassed", fx.bypassed);
  const params = new Y.Map<unknown>();
  m.set("params", params);
  for (const [k, v] of Object.entries(fx.params)) {
    params.set(k, v);
  }
  if (fx.steps) m.set("steps", [...fx.steps]);
  if (fx.sidechainTrackId) m.set("sidechainTrackId", fx.sidechainTrackId);
  if (fx.deviceState) m.set("deviceState", plainValue(fx.deviceState));
  return m;
}

function patternToYMap(p: Pattern): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", p.id);
  m.set("name", p.name);
  m.set("stepCount", p.stepCount);

  // Rows: Y.Map<padId, Y.Array<number>>
  const rowsMap = new Y.Map<unknown>();
  m.set("rows", rowsMap);
  for (const [padId, row] of Object.entries(p.rows)) {
    const yRow = new Y.Array<number>();
    rowsMap.set(padId, yRow);
    yRow.push(row);
  }

  // Notes: Y.Map<trackId, Y.Array<Y.Map>>
  const notesMap = new Y.Map<unknown>();
  m.set("notes", notesMap);
  for (const [trackId, notes] of Object.entries(p.notes ?? {})) {
    const yNotes = new Y.Array<unknown>();
    notesMap.set(trackId, yNotes);
    for (const note of notes) {
      yNotes.push([noteToYMap(note)]);
    }
  }

  // StepMeta
  if (p.stepMeta && Object.keys(p.stepMeta).length > 0) {
    const metaMap = new Y.Map<unknown>();
    m.set("stepMeta", metaMap);
    for (const [padId, steps] of Object.entries(p.stepMeta)) {
      const stepMap = new Y.Map<unknown>();
      metaMap.set(padId, stepMap);
      for (const [stepIdx, meta] of Object.entries(steps)) {
        const metaM = new Y.Map<unknown>();
        stepMap.set(stepIdx, metaM);
        for (const [k, v] of Object.entries(meta)) {
          metaM.set(k, v);
        }
      }
    }
  }

  // AI provenance — plain JSON values (round-trip via plainValue on read).
  if (p.generation !== undefined) m.set("generation", p.generation);
  if (p.assist !== undefined) m.set("assist", p.assist);
  if (p.phrasePlan !== undefined) m.set("phrasePlan", p.phrasePlan);
  return m;
}

function noteToYMap(n: NoteEvent): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", n.id);
  m.set("pitch", n.pitch);
  m.set("start", n.start);
  m.set("duration", n.duration);
  m.set("velocity", n.velocity);
  return m;
}

function sceneToYMap(s: Scene): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", s.id);
  m.set("name", s.name);
  m.set("patternId", s.patternId);
  m.set("intensity", s.intensity);
  if (s.intensityCurve) {
    const ic = new Y.Array<unknown>();
    m.set("intensityCurve", ic);
    for (const pt of s.intensityCurve) ic.push([objToYMap(pt as unknown as Record<string, unknown>)]);
  }
  if (s.loop !== undefined) m.set("loop", s.loop);
  if (s.role !== undefined) m.set("role", s.role);
  if (s.bpm !== undefined) m.set("bpm", s.bpm);
  return m;
}

function clipToYMap(c: ArrangementClip): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", c.id);
  m.set("sceneId", c.sceneId);
  m.set("startBar", c.startBar);
  m.set("lengthBars", c.lengthBars);
  if (c.loop !== undefined) m.set("loop", c.loop);
  return m;
}

function transitionToYMap(t: ArrangementTransition): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", t.id);
  m.set("fromClipId", t.fromClipId);
  m.set("toClipId", t.toClipId);
  m.set("type", t.type);
  m.set("lengthBars", t.lengthBars);
  if (t.cueAssetId) m.set("cueAssetId", t.cueAssetId);
  return m;
}

function markerToYMap(mk: Marker): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", mk.id);
  m.set("name", mk.name);
  m.set("type", mk.type);
  m.set("tick", mk.tick);
  if (mk.linkedClipId) m.set("linkedClipId", mk.linkedClipId);
  if (mk.customId) m.set("customId", mk.customId);
  return m;
}

function automationToYMap(lane: AutomationLane): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", lane.id);
  const target = new Y.Map<unknown>();
  m.set("target", target);
  for (const [k, v] of Object.entries(lane.target)) {
    target.set(k, v);
  }
  const points = new Y.Array<unknown>();
  m.set("points", points);
  for (const pt of lane.points) {
    points.push([objToYMap(pt as unknown as Record<string, unknown>)]);
  }
  return m;
}

function sceneAutoToYMap(sa: SceneAutomation): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", sa.id);
  m.set("sceneId", sa.sceneId);
  const target = new Y.Map<unknown>();
  m.set("target", target);
  for (const [k, v] of Object.entries(sa.target)) {
    target.set(k, v);
  }
  const points = new Y.Array<unknown>();
  m.set("points", points);
  for (const pt of sa.points) {
    points.push([objToYMap(pt as unknown as Record<string, unknown>)]);
  }
  return m;
}

function macroToYMap(macro: Macro): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", macro.id);
  m.set("name", macro.name);
  m.set("value", macro.value);
  const mappings = new Y.Array<unknown>();
  m.set("mappings", mappings);
  for (const mapping of macro.mappings) {
    mappings.push([objToYMap(mapping as any)]);
  }
  return m;
}

function returnToYMap(r: ReturnTrack): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", r.id);
  m.set("kind", "return");
  m.set("name", r.name);
  m.set("gain", r.gain);
  const effects = new Y.Array<unknown>();
  m.set("effects", effects);
  for (const fx of r.effects) {
    effects.push([effectToYMap(fx)]);
  }
  return m;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function yArrToList<T>(arr: Y.Array<T> | undefined): T[] {
  if (!arr) return [];
  return arr.toArray() as T[];
}

function yMapToObj(m: Y.Map<unknown> | undefined): Record<string, unknown> | undefined {
  if (!m) return undefined;
  const obj: Record<string, unknown> = {};
  m.forEach((v, k) => {
    obj[k] = v;
  });
  return obj;
}

function yMapToRecord(m: Y.Map<unknown> | undefined): Record<string, number> {
  if (!m) return {};
  const obj: Record<string, number> = {};
  m.forEach((v, k) => {
    obj[k] = v as number;
  });
  return obj;
}

function objToYMap(obj: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(obj)) {
    m.set(k, v);
  }
  return m;
}
