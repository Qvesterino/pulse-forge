import type {
  ArrangementClip,
  DrumPad,
  DrumTrack,
  Lfo,
  Macro,
  MacroMapping,
  NoteEvent,
  Pattern,
  ProjectDocument,
  Scene,
} from "./types";
import { BAR_TICKS, PPQ, STEPS_PER_PATTERN } from "./types";
import { uid } from "../shared/ids";
import {
  SCHEMA_VERSION,
  createDefaultReturns,
  createDrumTrackModel,
  createInstrumentTrackModel,
  defaultMacros,
  defaultMasterConfig,
} from "./schema";

export type TemplateId = "empty" | "house" | "techno" | "trap" | "ambient" | "scene-score";

export interface TemplateInfo {
  id: TemplateId;
  name: string;
  description: string;
  bpm: number;
  tags: string[];
}

export const TEMPLATES: TemplateInfo[] = [
  {
    id: "house",
    name: "House",
    description: "4-on-the-floor groove with offbeat hats and a sub bass line. Ready to play.",
    bpm: 124,
    tags: ["groove", "sub", "starter"],
  },
  {
    id: "techno",
    name: "Techno",
    description: "Driving kick, offbeat open hats and a gritty rumble bass. Two loop variations.",
    bpm: 132,
    tags: ["driving", "dark", "loop"],
  },
  {
    id: "trap",
    name: "Trap",
    description: "Half-time snare, rolling hats and a long-decay 808 with a sparse lead.",
    bpm: 140,
    tags: ["808", "half-time"],
  },
  {
    id: "ambient",
    name: "Ambient",
    description: "Slow evolving texture pads and soft analog chords. No drums in your way.",
    bpm: 80,
    tags: ["pads", "atmosphere", "slow"],
  },
  {
    id: "scene-score",
    name: "Scene Score",
    description: "Arrangement-first: INTRO / BUILD / DROP / BREAK / OUTRO scenes pre-placed on a 24-bar timeline.",
    bpm: 120,
    tags: ["arrangement", "scenes", "sync"],
  },
  {
    id: "empty",
    name: "Empty",
    description: "One drum track and a blank pattern. Nothing else.",
    bpm: 120,
    tags: ["blank", "advanced"],
  },
];

export function templateInfo(id: TemplateId): TemplateInfo {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

/* ---------------- builder helpers ---------------- */

function note(pitch: number, start: number, duration: number, velocity: number): NoteEvent {
  return { id: uid("note"), pitch, start, duration, velocity };
}

function emptyPattern(name: string, drumTracks: DrumTrack[], stepCount = STEPS_PER_PATTERN): Pattern {
  const rows: Record<string, number[]> = {};
  for (const track of drumTracks) {
    for (const pad of track.pads) rows[pad.id] = new Array<number>(stepCount).fill(0);
  }
  return { id: uid("pattern"), name, stepCount, rows, notes: {} };
}

/** Set velocities on a pattern row by pad index (of the first drum track). Returns the mutated copy. */
function setSteps(pattern: Pattern, pads: DrumPad[], padIndex: number, steps: [number, number][]): Pattern {
  const pad = pads[padIndex];
  const row = [...(pattern.rows[pad.id] ?? [])];
  for (const [step, velocity] of steps) row[step] = velocity;
  return { ...pattern, rows: { ...pattern.rows, [pad.id]: row } };
}

function withNotes(pattern: Pattern, trackId: string, notes: NoteEvent[]): Pattern {
  return { ...pattern, notes: { ...pattern.notes, [trackId]: notes } };
}

function scene(name: string, patternId: string, intensity: number = 0.7): Scene {
  return { id: uid("scene"), name, patternId, intensity };
}

function clip(sceneId: string, startBar: number, lengthBars: number): ArrangementClip {
  return { id: uid("clip"), sceneId, startBar, lengthBars };
}

function baseDocument(name: string, bpm: number): ProjectDocument {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid("project"),
    name,
    bpm,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [],
    patterns: [],
    activePatternId: "",
    scenes: [],
    arrangement: { clips: [] },
    markers: [],
    sceneAutomation: [],
    automation: [],
    lfos: [],
    macros: defaultMacros(),
    returns: createDefaultReturns(),
    master: defaultMasterConfig(),
    midi: {
      enabled: false,
      deviceId: "",
      drumChannel: 0,
      instrumentChannel: 0,
      ccMappings: [],
      drumNoteMap: [],
      pitchBendRange: 2,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function finish(doc: ProjectDocument, activePatternIndex = 0): ProjectDocument {
  return { ...doc, activePatternId: doc.patterns[activePatternIndex]?.id ?? "" };
}

/** Four performance macros mapped to the classic mix bus roles of the template. */
function performanceMacros(drumsId: string, bassId: string | null, musicId: string | null): Macro[] {
  const mappings = (trackId: string | null, param: MacroMapping["param"], amount: number): MacroMapping[] =>
    trackId ? [{ id: uid("map"), trackId, param, amount }] : [];
  return [
    { id: uid("macro"), name: "DRUMS", value: 0.5, mappings: mappings(drumsId, "gain", 0.6) },
    { id: uid("macro"), name: "BASS", value: 0.5, mappings: mappings(bassId, "gain", 0.6) },
    { id: uid("macro"), name: "MUSIC", value: 0.5, mappings: mappings(musicId, "gain", 0.6) },
    {
      id: uid("macro"),
      name: "WIDTH",
      value: 0.5,
      mappings: musicId ? mappings(musicId, "pan", 0.35) : mappings(drumsId, "pan", 0.3),
    },
  ];
}

/* ---------------- templates ---------------- */

function buildEmpty(): ProjectDocument {
  const doc = baseDocument("Empty Project", 120);
  const drums = createDrumTrackModel("Drums");
  const pattern = emptyPattern("Pattern A", [drums]);
  const sc = scene("Scene A", pattern.id);
  doc.tracks = [drums];
  doc.patterns = [pattern];
  doc.scenes = [sc];
  doc.arrangement = { clips: [clip(sc.id, 0, 4)] };
  doc.macros = performanceMacros(drums.id, null, null);
  return finish(doc);
}

function buildHouse(): ProjectDocument {
  const doc = baseDocument("House Beat", 124);
  const drums = createDrumTrackModel("Drums");
  const bass = createInstrumentTrackModel("808", 1);
  const chords = createInstrumentTrackModel("analog", 1);
  chords.name = "Chords";
  chords.params = {
    ...chords.params,
    oscA: 2,
    oscB: 1,
    oscBDetune: 9,
    subLevel: 0.2,
    cutoff: 5200,
    resonance: 1.3,
    filterEnv: 0.4,
    attack: 0.004,
    decay: 0.24,
    sustain: 0.3,
    release: 0.2,
    level: -10,
  };

  let pattern = emptyPattern("Pattern A", [drums]);
  pattern = setSteps(pattern, drums.pads, 0, [
    [0, 0.95],
    [4, 0.95],
    [8, 0.95],
    [12, 0.95],
  ]);
  pattern = setSteps(pattern, drums.pads, 6, [
    [4, 0.7],
    [12, 0.75],
  ]);
  pattern = setSteps(pattern, drums.pads, 8, [
    [2, 0.5],
    [6, 0.5],
    [10, 0.5],
    [14, 0.55],
  ]);
  pattern = setSteps(pattern, drums.pads, 10, [[14, 0.4]]);
  pattern = withNotes(pattern, bass.id, [
    note(28, 0, PPQ / 2, 0.9),
    note(28, 3 * (PPQ / 4), PPQ / 2, 0.7),
    note(31, 2 * PPQ, PPQ / 2, 0.9),
    note(28, 3 * PPQ, PPQ / 2, 0.8),
  ]);
  pattern = withNotes(pattern, chords.id, [
    note(60, 0, PPQ / 2, 0.5),
    note(63, 0, PPQ / 2, 0.42),
    note(67, 0, PPQ / 2, 0.4),
    note(60, 2 * PPQ, PPQ / 2, 0.5),
    note(63, 2 * PPQ, PPQ / 2, 0.42),
    note(67, 2 * PPQ, PPQ / 2, 0.4),
  ]);

  const sc = scene("Groove", pattern.id);
  doc.tracks = [drums, bass, chords];
  doc.patterns = [pattern];
  doc.scenes = [sc];
  doc.arrangement = { clips: [clip(sc.id, 0, 4)] };
  doc.macros = performanceMacros(drums.id, bass.id, chords.id);
  return finish(doc);
}

function buildTechno(): ProjectDocument {
  const doc = baseDocument("Techno Loop", 132);
  const drums = createDrumTrackModel("Drums");
  const rumble = createInstrumentTrackModel("bass", 1);
  rumble.name = "Rumble";
  rumble.params = {
    ...rumble.params,
    sub: 0.8,
    body: 0.45,
    punch: 0.3,
    grit: 0.55,
    movement: 0.25,
    width: 0.1,
    cutoff: 420,
    resonance: 2.5,
  };
  const stab = createInstrumentTrackModel("analog", 1);
  stab.name = "Stab";
  stab.params = {
    ...stab.params,
    oscA: 2,
    oscB: 3,
    oscBDetune: 14,
    subLevel: 0.3,
    noiseLevel: 0.05,
    cutoff: 4200,
    resonance: 2.2,
    filterEnv: 0.5,
    attack: 0.003,
    decay: 0.2,
    sustain: 0.3,
    release: 0.12,
    level: -9,
  };

  const bassline = (pattern: Pattern): Pattern =>
    withNotes(pattern, rumble.id, [
      note(28, 240, 180, 0.85),
      note(28, 720, 180, 0.75),
      note(28, 1200, 180, 0.85),
      note(28, 1680, 180, 0.7),
    ]);

  const stabline = (pattern: Pattern, root: number): Pattern =>
    withNotes(pattern, stab.id, [note(root, 0, 180, 0.55), note(root + 3, 0, 180, 0.45), note(root + 7, 0, 180, 0.42)]);

  let loopA = emptyPattern("Loop A", [drums]);
  loopA = setSteps(loopA, drums.pads, 2, [
    [0, 0.95],
    [4, 0.95],
    [8, 0.95],
    [12, 0.95],
  ]);
  loopA = setSteps(loopA, drums.pads, 6, [
    [4, 0.55],
    [12, 0.6],
  ]);
  loopA = setSteps(loopA, drums.pads, 10, [
    [2, 0.4],
    [6, 0.4],
    [10, 0.4],
    [14, 0.42],
  ]);
  loopA = setSteps(loopA, drums.pads, 8, [
    [1, 0.3],
    [3, 0.3],
    [5, 0.3],
    [7, 0.32],
    [9, 0.3],
    [11, 0.3],
    [13, 0.3],
    [15, 0.34],
  ]);
  loopA = bassline(loopA);
  loopA = stabline(loopA, 48);

  let loopB = emptyPattern("Loop B", [drums]);
  loopB = setSteps(loopB, drums.pads, 2, [
    [0, 0.95],
    [4, 0.95],
    [8, 0.95],
    [12, 0.95],
  ]);
  loopB = setSteps(loopB, drums.pads, 6, [
    [4, 0.55],
    [12, 0.6],
  ]);
  loopB = setSteps(loopB, drums.pads, 10, [
    [2, 0.4],
    [6, 0.4],
    [10, 0.4],
    [14, 0.42],
  ]);
  loopB = setSteps(loopB, drums.pads, 11, [
    [2, 0.3],
    [6, 0.3],
    [10, 0.3],
    [14, 0.3],
  ]);
  loopB = setSteps(loopB, drums.pads, 12, [[14, 0.45]]);
  loopB = setSteps(loopB, drums.pads, 3, [
    [7, 0.4],
    [15, 0.42],
  ]);
  loopB = bassline(loopB);
  loopB = stabline(loopB, 51);

  const scA = scene("Loop A", loopA.id);
  const scB = scene("Loop B", loopB.id);
  doc.tracks = [drums, rumble, stab];
  doc.patterns = [loopA, loopB];
  doc.scenes = [scA, scB];
  doc.arrangement = { clips: [clip(scA.id, 0, 4), clip(scB.id, 4, 4)] };
  doc.macros = performanceMacros(drums.id, rumble.id, stab.id);
  return finish(doc);
}

function buildTrap(): ProjectDocument {
  const doc = baseDocument("Trap Beat", 140);
  const drums = createDrumTrackModel("Drums");
  const sub = createInstrumentTrackModel("808", 1);
  sub.name = "808 Sub";
  sub.params = { ...sub.params, decay: 1.6, pitchDrop: 0.5, click: 0.3, drive: 0.35, tone: 0.3, gain: 0.9 };
  const lead = createInstrumentTrackModel("analog", 1);
  lead.name = "Lead";
  lead.params = {
    ...lead.params,
    oscA: 2,
    oscB: 3,
    cutoff: 5200,
    resonance: 2,
    filterEnv: 0.4,
    attack: 0.005,
    decay: 0.3,
    sustain: 0.4,
    release: 0.3,
    level: -12,
  };

  let pattern = emptyPattern("Pattern A", [drums]);
  pattern = setSteps(pattern, drums.pads, 0, [
    [0, 0.95],
    [7, 0.8],
    [10, 0.9],
  ]);
  pattern = setSteps(pattern, drums.pads, 5, [[8, 0.9]]);
  pattern = setSteps(pattern, drums.pads, 8, [
    [0, 0.55],
    [1, 0.3],
    [2, 0.45],
    [3, 0.3],
    [4, 0.5],
    [5, 0.3],
    [6, 0.45],
    [7, 0.32],
    [8, 0.55],
    [9, 0.3],
    [10, 0.45],
    [11, 0.35],
    [12, 0.5],
    [13, 0.4],
    [14, 0.45],
    [15, 0.35],
  ]);
  pattern = setSteps(pattern, drums.pads, 10, [[12, 0.35]]);
  pattern = setSteps(pattern, drums.pads, 3, [
    [3, 0.35],
    [11, 0.35],
  ]);
  pattern = withNotes(pattern, sub.id, [
    note(21, 0, 660, 0.95),
    note(21, 720, 220, 0.8),
    note(24, 960, 420, 0.85),
    note(19, 1440, 420, 0.8),
  ]);
  pattern = withNotes(pattern, lead.id, [note(76, 480, 180, 0.4), note(74, 1200, 180, 0.35)]);

  const sc = scene("Groove", pattern.id);
  doc.tracks = [drums, sub, lead];
  doc.patterns = [pattern];
  doc.scenes = [sc];
  doc.arrangement = { clips: [clip(sc.id, 0, 4)] };
  doc.macros = performanceMacros(drums.id, sub.id, lead.id);
  return finish(doc);
}

function buildAmbient(): ProjectDocument {
  const doc = baseDocument("Ambient Drift", 80);
  const drums = createDrumTrackModel("Drums");
  const texture = createInstrumentTrackModel("texture", 1);
  texture.name = "Drift";
  texture.params = {
    ...texture.params,
    color: 0.45,
    motion: 0.5,
    space: 0.6,
    density: 0.6,
    texture: 0.35,
    chaos: 0.15,
    level: -8,
  };
  const pad = createInstrumentTrackModel("analog", 1);
  pad.name = "Pad";
  pad.params = {
    ...pad.params,
    oscA: 1,
    oscB: 1,
    oscBDetune: 12,
    subLevel: 0.15,
    cutoff: 2400,
    resonance: 0.8,
    filterEnv: 0.15,
    attack: 0.8,
    decay: 1.2,
    sustain: 0.8,
    release: 1.6,
    level: -10,
  };

  const stepCount = STEPS_PER_PATTERN * 2;
  let pattern = emptyPattern("Drift A", [drums], stepCount);
  pattern = withNotes(pattern, texture.id, [
    note(48, 0, 3840, 0.6),
    note(52, 0, 3840, 0.5),
    note(55, 0, 3840, 0.5),
    note(59, 0, 3840, 0.4),
  ]);
  pattern = withNotes(pattern, pad.id, [
    note(60, 1920, 1920, 0.4),
    note(64, 1920, 1920, 0.35),
    note(67, 1920, 1920, 0.35),
  ]);

  const lfos: Lfo[] = [
    {
      id: uid("lfo"),
      trackId: texture.id,
      param: "gain",
      wave: "sine",
      rateMode: "sync",
      rateHz: 0.3,
      division: 0,
      amount: 0.15,
    },
  ];

  const sc = scene("Drift", pattern.id);
  doc.tracks = [drums, texture, pad];
  doc.patterns = [pattern];
  doc.scenes = [sc];
  doc.arrangement = { clips: [clip(sc.id, 0, 8)] };
  doc.lfos = lfos;
  doc.returns[0].effects[0].params = { ...doc.returns[0].effects[0].params, decay: 4.5 };
  doc.macros = performanceMacros(drums.id, texture.id, pad.id);
  return finish(doc);
}

function buildSceneScore(): ProjectDocument {
  const doc = baseDocument("Scene Score", 120);
  const drums = createDrumTrackModel("Drums");
  const bass = createInstrumentTrackModel("808", 1);
  bass.name = "Score Bass";
  const texture = createInstrumentTrackModel("texture", 1);
  texture.name = "Bed";
  texture.params = { ...texture.params, color: 0.5, motion: 0.35, space: 0.5, density: 0.65, level: -10 };

  const textureChord = (start: number, duration: number, velocity: number): NoteEvent[] => [
    note(48, start, duration, velocity),
    note(55, start, duration, velocity * 0.85),
    note(60, start, duration, velocity * 0.8),
  ];

  let intro = emptyPattern("Intro", [drums]);
  intro = setSteps(intro, drums.pads, 9, [
    [0, 0.25],
    [4, 0.25],
    [8, 0.25],
    [12, 0.25],
  ]);
  intro = withNotes(intro, texture.id, textureChord(0, 1920, 0.5));

  let build = emptyPattern("Build", [drums]);
  build = setSteps(build, drums.pads, 0, [
    [0, 0.9],
    [4, 0.9],
    [8, 0.9],
    [12, 0.9],
  ]);
  build = setSteps(build, drums.pads, 8, [
    [2, 0.4],
    [6, 0.42],
    [10, 0.44],
    [14, 0.5],
  ]);
  build = setSteps(build, drums.pads, 7, [
    [1, 0.3],
    [3, 0.3],
    [5, 0.32],
    [7, 0.34],
    [9, 0.36],
    [11, 0.38],
    [13, 0.42],
    [15, 0.48],
  ]);
  build = withNotes(build, texture.id, textureChord(0, 1920, 0.55));

  let drop = emptyPattern("Drop", [drums]);
  drop = setSteps(drop, drums.pads, 0, [
    [0, 0.95],
    [4, 0.95],
    [8, 0.95],
    [12, 0.95],
  ]);
  drop = setSteps(drop, drums.pads, 6, [
    [4, 0.7],
    [12, 0.75],
  ]);
  drop = setSteps(drop, drums.pads, 8, [
    [2, 0.5],
    [6, 0.5],
    [10, 0.5],
    [14, 0.55],
  ]);
  drop = setSteps(drop, drums.pads, 10, [[14, 0.4]]);
  drop = withNotes(drop, bass.id, [
    note(28, 0, PPQ / 2, 0.9),
    note(28, 3 * (PPQ / 4), PPQ / 2, 0.7),
    note(31, 2 * PPQ, PPQ / 2, 0.9),
    note(28, 3 * PPQ, PPQ / 2, 0.8),
  ]);
  drop = withNotes(drop, texture.id, textureChord(0, 1920, 0.5));

  let breakP = emptyPattern("Break", [drums]);
  breakP = withNotes(breakP, texture.id, textureChord(0, 1920, 0.55));
  breakP = withNotes(breakP, bass.id, [note(28, 0, 1440, 0.6)]);

  let outro = emptyPattern("Outro", [drums]);
  outro = setSteps(outro, drums.pads, 0, [
    [0, 0.7],
    [4, 0.6],
    [8, 0.5],
    [12, 0.4],
  ]);
  outro = setSteps(outro, drums.pads, 9, [
    [2, 0.3],
    [6, 0.28],
    [10, 0.26],
    [14, 0.24],
  ]);
  outro = withNotes(outro, texture.id, textureChord(0, 1920, 0.45));

  const scIntro = scene("INTRO", intro.id, 0.4);
  const scBuild = scene("BUILD", build.id, 0.7);
  const scDrop = scene("DROP", drop.id, 1.0);
  const scBreak = scene("BREAK", breakP.id, 0.6);
  const scOutro = scene("OUTRO", outro.id, 0.5);

  doc.tracks = [drums, bass, texture];
  doc.patterns = [intro, build, drop, breakP, outro];
  doc.scenes = [scIntro, scBuild, scDrop, scBreak, scOutro];
  doc.arrangement = {
    clips: [
      clip(scIntro.id, 0, 4),
      clip(scBuild.id, 4, 4),
      clip(scDrop.id, 8, 8),
      clip(scBreak.id, 16, 4),
      clip(scOutro.id, 20, 4),
    ],
  };
  doc.macros = performanceMacros(drums.id, bass.id, texture.id);
  // Named timeline markers — auto-trigger their typed FX cue during playback.
  // Bar 1 (BUILD), bar 9 (DROP), bar 21 (OUTRO) align 1 tick AT each clip start.
  doc.markers = [
    {
      id: uid("marker"),
      name: "Lift",
      type: "buildup",
      tick: 4 * BAR_TICKS,
      linkedClipId: doc.arrangement.clips[1].id,
    },
    { id: uid("marker"), name: "Hit", type: "drop", tick: 8 * BAR_TICKS, linkedClipId: doc.arrangement.clips[2].id },
    {
      id: uid("marker"),
      name: "Outro",
      type: "riser",
      tick: 20 * BAR_TICKS,
      linkedClipId: doc.arrangement.clips[4].id,
    },
  ];
  // Per-scene intensity curves: BUILD ramps up, DROP holds at 1.0, BREAK eases back.
  doc.scenes = doc.scenes.map((s, i) => {
    if (i === 1)
      return {
        ...s,
        intensityCurve: [
          { offset: 0, value: 0.4 },
          { offset: 1920, value: 0.95 },
        ],
      };
    if (i === 2)
      return {
        ...s,
        intensityCurve: [
          { offset: 0, value: 1.0 },
          { offset: 3840, value: 1.0 },
        ],
      };
    if (i === 3)
      return {
        ...s,
        intensityCurve: [
          { offset: 0, value: 0.95 },
          { offset: 1920, value: 0.5 },
        ],
      };
    return s;
  });
  // Sample scene automation: texture filter-style gain ride into the DROP.
  doc.sceneAutomation = [
    {
      id: uid("sceneAuto"),
      sceneId: scBuild.id,
      target: { kind: "trackGain", trackId: texture.id },
      points: [
        { tick: 0, value: 0.7 },
        { tick: 1920, value: 1.0 },
      ],
    },
  ];
  return finish(doc, 2);
}

/* ---------------- entry point ---------------- */

export function createProjectFromTemplate(id: TemplateId): ProjectDocument {
  switch (id) {
    case "empty":
      return buildEmpty();
    case "house":
      return buildHouse();
    case "techno":
      return buildTechno();
    case "trap":
      return buildTrap();
    case "ambient":
      return buildAmbient();
    case "scene-score":
      return buildSceneScore();
  }
}
