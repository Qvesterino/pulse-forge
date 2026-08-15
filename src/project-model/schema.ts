import type { DrumPad, DrumTrack, InstrumentKind, InstrumentTrack, Pattern, ProjectDocument } from "./types";
import { PPQ, STEPS_PER_PATTERN } from "./types";
import { uid } from "../shared/ids";
import { defaultInstrumentParams } from "../instruments/registry";

export const SCHEMA_VERSION = 1;

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
  };
}

const INSTRUMENT_NAMES: Record<InstrumentKind, string> = {
  sampler: "Sampler",
  analog: "Analog",
  bass: "Bass",
  "808": "808",
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
  };
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
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid("project"),
    name: "Untitled Beat",
    bpm: 124,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [track, bass],
    patterns: [pattern],
    activePatternId: pattern.id,
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeProject(doc: ProjectDocument): ProjectDocument {
  const padIds = new Set(allPadIds(doc));
  let changed = false;

  const tracks = doc.tracks.map((track) => {
    if (track.kind !== "instrument") {
      if (track.kind === "drum" && track.effects === undefined) {
        changed = true;
        return { ...track, effects: [] };
      }
      return track;
    }
    let next = track;
    if (next.effects === undefined) {
      next = { ...next, effects: [] };
      changed = true;
    }
    if (next.params === undefined) {
      next = { ...next, params: defaultInstrumentParams(next.instrument) };
      changed = true;
    } else {
      const defaults = defaultInstrumentParams(next.instrument);
      const merged = { ...defaults, ...next.params };
      for (const key of Object.keys(defaults)) {
        if (next.params[key] === undefined) changed = true;
      }
      next = { ...next, params: merged };
    }
    return next;
  });
  const withTracks = changed ? { ...doc, tracks } : doc;

  const patterns = withTracks.patterns.map((pattern) => {
    let next = pattern;
    if (next.notes === undefined) {
      next = { ...next, notes: {} };
      changed = true;
    }
    let rows = next.rows;
    for (const padId of padIds) {
      const row = rows[padId];
      const invalid = !row || row.length !== next.stepCount;
      if (!invalid) continue;
      if (rows === next.rows) rows = { ...next.rows };
      const base = row ?? [];
      rows[padId] = new Array<number>(next.stepCount)
        .fill(0)
        .map((_, i) => base[i] ?? 0);
      changed = true;
    }
    if (rows !== next.rows) next = { ...next, rows };
    return next;
  });
  return changed ? { ...withTracks, patterns } : withTracks;
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
