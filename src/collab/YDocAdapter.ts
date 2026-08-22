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
  ProjectDocument,
  ReturnTrack,
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
    timeSignature: (yMapToObj(m.get("timeSignature") as Y.Map<unknown>) as unknown as { numerator: number; denominator: number }) ?? { numerator: 4, denominator: 4 },
    key: (m.get("key") as string | undefined) as any,
    tags: (yArrToList(m.get("tags") as Y.Array<unknown>) as string[]),
    tracks: yArrToList(m.get("tracks") as Y.Array<unknown>).map(yMapToTrack),
    patterns: yArrToList(m.get("patterns") as Y.Array<unknown>).map(yMapToPattern),
    activePatternId: (m.get("activePatternId") as string) ?? "",
    scenes: yArrToList(m.get("scenes") as Y.Array<unknown>).map(yMapToScene),
    arrangement: {
      clips: yArrToList((m.get("arrangement") as Y.Map<unknown>)?.get("clips") as Y.Array<unknown>).map(yMapToClip),
    },
    markers: yArrToList(m.get("markers") as Y.Array<unknown>).map(yMapToMarker),
    sceneAutomation: yArrToList(m.get("sceneAutomation") as Y.Array<unknown>).map(yMapToSceneAutomation),
    automation: yArrToList(m.get("automation") as Y.Array<unknown>).map(yMapToAutomation),
    lfos: yArrToList(m.get("lfos") as Y.Array<unknown>).map(yMapToLfo),
    macros: yArrToList(m.get("macros") as Y.Array<unknown>).map(yMapToMacro),
    returns: yArrToList(m.get("returns") as Y.Array<unknown>).map(yMapToReturn),
    master: (yMapToObj(m.get("master") as Y.Map<unknown>) as unknown as MasterConfig) ?? { masterGain: 1, ceilingDb: -1, limiterEnabled: true, clipperEnabled: false },
    groove: m.has("groove") ? yMapToObj(m.get("groove") as Y.Map<unknown>) as unknown as Partial<GrooveSettings> : undefined,
    midi: m.has("midi") ? yMapToObj(m.get("midi") as Y.Map<unknown>) as unknown as MidiConfig : undefined,
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
    frozen: map.has("frozen") ? yMapToObj(map.get("frozen") as Y.Map<unknown>) as unknown as FrozenState : undefined,
  };
  if (kind === "drum") {
    return { ...base, kind: "drum", pads: yArrToList(map.get("pads") as Y.Array<unknown>).map(yMapToPad) };
  }
  if (kind === "group") {
    return { ...base, kind: "group" };
  }
  return {
    ...base,
    kind: "instrument",
    instrument: map.get("instrument") as any,
    sampleId: map.get("sampleId") as string | null,
    params: yMapToRecord(map.get("params") as Y.Map<unknown>),
    presetId: map.get("presetId") as string | null | undefined,
    midiOutput: map.has("midiOutput") ? yMapToObj(map.get("midiOutput") as Y.Map<unknown>) as any : undefined,
  };
}

function yMapToPad(m: unknown): DrumPad {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    name: map.get("name") as string,
    assetId: map.get("assetId") as string | null,
    gain: map.get("gain") as number,
    pan: map.get("pan") as number,
    pitch: map.get("pitch") as number,
    mute: map.get("mute") as boolean,
    solo: map.get("solo") as boolean,
    chokeGroup: map.get("chokeGroup") as number | null,
  };
}

function yMapToEffect(m: unknown): EffectInstance {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    type: map.get("type") as any,
    bypassed: map.get("bypassed") as boolean,
    params: yMapToRecord(map.get("params") as Y.Map<unknown>),
    sidechainTrackId: map.get("sidechainTrackId") as string | undefined,
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
    intensityCurve: map.has("intensityCurve") ? yArrToList(map.get("intensityCurve") as Y.Array<unknown>).map((v) => yMapToObj(v as Y.Map<unknown>)) as any : undefined,
    loop: map.get("loop") as boolean | undefined,
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

function yMapToAutomation(m: unknown): AutomationLane {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    target: yMapToObj(map.get("target") as Y.Map<unknown>) as unknown as AutomationLane["target"],
    points: yArrToList(map.get("points") as Y.Array<unknown>).map((p) => ({ tick: (p as any).tick, value: (p as any).value })) as AutomationPoint[],
  };
}

function yMapToSceneAutomation(m: unknown): SceneAutomation {
  const map = m as Y.Map<unknown>;
  return {
    id: map.get("id") as string,
    sceneId: map.get("sceneId") as string,
    target: yMapToObj(map.get("target") as Y.Map<unknown>) as unknown as SceneAutomation["target"],
    points: yArrToList(map.get("points") as Y.Array<unknown>).map((p) => ({ tick: (p as any).tick, value: (p as any).value })) as AutomationPoint[],
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
    mappings: yArrToList(map.get("mappings") as Y.Array<unknown>).map((v) => yMapToObj(v as Y.Map<unknown>) as unknown as MacroMapping),
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

export function projectToYDoc(doc: ProjectDocument, yMap: Y.Map<unknown>): void {
  const yDoc = yMap.doc!;
  yDoc.transact(() => {
    // Scalar fields
    yMap.set("schemaVersion", doc.schemaVersion);
    yMap.set("id", doc.id);
    yMap.set("name", doc.name);
    yMap.set("bpm", doc.bpm);
    yMap.set("activePatternId", doc.activePatternId);
    yMap.set("createdAt", doc.createdAt);
    yMap.set("updatedAt", doc.updatedAt);
    if (doc.key) yMap.set("key", doc.key);

    // timeSignature
    const ts = new Y.Map<unknown>();
    yMap.set("timeSignature", ts);
    ts.set("numerator", doc.timeSignature.numerator);
    ts.set("denominator", doc.timeSignature.denominator);

    // Tracks
    const tracks = new Y.Array<unknown>();
    yMap.set("tracks", tracks);
    for (const track of doc.tracks) {
      const tm = trackToYMap(track);
      tracks.push([tm]);
    }

    // Patterns
    const patterns = new Y.Array<unknown>();
    yMap.set("patterns", patterns);
    for (const pattern of doc.patterns) {
      patterns.push([patternToYMap(pattern)]);
    }

    // Scenes
    const scenes = new Y.Array<unknown>();
    yMap.set("scenes", scenes);
    for (const scene of doc.scenes) {
      scenes.push([sceneToYMap(scene)]);
    }

    // Arrangement
    const arr = new Y.Map<unknown>();
    yMap.set("arrangement", arr);
    const clips = new Y.Array<unknown>();
    arr.set("clips", clips);
    for (const clip of doc.arrangement.clips) {
      clips.push([clipToYMap(clip)]);
    }

    // Markers
    const markers = new Y.Array<unknown>();
    yMap.set("markers", markers);
    for (const mk of doc.markers) {
      markers.push([markerToYMap(mk)]);
    }

    // Scene automation
    const sa = new Y.Array<unknown>();
    yMap.set("sceneAutomation", sa);
    for (const s of doc.sceneAutomation) {
      sa.push([sceneAutoToYMap(s)]);
    }

    // Automation
    const auto = new Y.Array<unknown>();
    yMap.set("automation", auto);
    for (const lane of doc.automation) {
      auto.push([automationToYMap(lane)]);
    }

    // LFOs
    const lfos = new Y.Array<unknown>();
    yMap.set("lfos", lfos);
    for (const lfo of doc.lfos) {
      const m = new Y.Map<unknown>();
      lfos.push([m]);
      for (const [k, v] of Object.entries(lfo)) {
        m.set(k, v);
      }
    }

    // Macros
    const macros = new Y.Array<unknown>();
    yMap.set("macros", macros);
    for (const macro of doc.macros) {
      macros.push([macroToYMap(macro)]);
    }

    // Returns
    const returns = new Y.Array<unknown>();
    yMap.set("returns", returns);
    for (const r of doc.returns) {
      returns.push([returnToYMap(r)]);
    }

    // Master
    const master = new Y.Map<unknown>();
    yMap.set("master", master);
    master.set("masterGain", doc.master.masterGain);
    master.set("ceilingDb", doc.master.ceilingDb);
    master.set("limiterEnabled", doc.master.limiterEnabled);
    master.set("clipperEnabled", doc.master.clipperEnabled);

    // Groove
    if (doc.groove) {
      const g = new Y.Map<unknown>();
      yMap.set("groove", g);
      if (doc.groove.swing !== undefined) g.set("swing", doc.groove.swing);
      if (doc.groove.humanizeTiming !== undefined) g.set("humanizeTiming", doc.groove.humanizeTiming);
      if (doc.groove.humanizeVelocity !== undefined) g.set("humanizeVelocity", doc.groove.humanizeVelocity);
    }

    // MIDI
    if (doc.midi) {
      const mi = new Y.Map<unknown>();
      yMap.set("midi", mi);
      mi.set("enabled", doc.midi.enabled);
      mi.set("deviceId", doc.midi.deviceId);
      mi.set("drumChannel", doc.midi.drumChannel);
      mi.set("instrumentChannel", doc.midi.instrumentChannel);
      mi.set("pitchBendRange", doc.midi.pitchBendRange);
      if (doc.midi.clockMode) mi.set("clockMode", doc.midi.clockMode);
      if (doc.midi.ccMappings) {
        const cc = new Y.Array<unknown>();
        mi.set("ccMappings", cc);
        for (const m of doc.midi.ccMappings) cc.push([objToYMap(m as any)]);
      }
      if (doc.midi.drumNoteMap) {
        const dn = new Y.Array<unknown>();
        mi.set("drumNoteMap", dn);
        for (const m of doc.midi.drumNoteMap) dn.push([objToYMap(m as any)]);
      }
    }
  });
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
  if (fx.sidechainTrackId) m.set("sidechainTrackId", fx.sidechainTrackId);
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
  m.forEach((v, k) => { obj[k] = v; });
  return obj;
}

function yMapToRecord(m: Y.Map<unknown> | undefined): Record<string, number> {
  if (!m) return {};
  const obj: Record<string, number> = {};
  m.forEach((v, k) => { obj[k] = v as number; });
  return obj;
}

function objToYMap(obj: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(obj)) {
    m.set(k, v);
  }
  return m;
}
