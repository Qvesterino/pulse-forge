import {
  baseDocument,
  clip,
  emptyPattern,
  finish,
  note,
  performanceMacros,
  scene,
  setSteps,
  withNotes,
} from "./templates";
import { defaultParamsOf } from "../effects/registry";
import { createDrumTrackModel, createInstrumentTrackModel } from "./schema";
import { uid } from "../shared/ids";
import { PPQ } from "./types";
import type { ProjectDocument } from "./types";

/* ---------------- Template pack #2 — genre starters ---------------- */

/* ---------------- UK Garage — 133 BPM, swung 2-step ---------------- */

export function buildUkGarage(): ProjectDocument {
  const doc = baseDocument("UK Garage", 133);
  const drums = createDrumTrack();
  const bass = createBass();
  const stab = createKeys();
  stab.name = "Stabs";

  let pattern = emptyPattern("2-Step", [drums]);
  // Shuffled 2-step kick.
  pattern = setSteps(pattern, drums.pads, 0, [
    [0, 0.95],
    [7, 0.45],
    [10, 0.9],
  ]);
  // Snare on the swung 4s.
  pattern = setSteps(pattern, drums.pads, 4, [
    [4, 0.85],
    [12, 0.85],
  ]);
  // Shuffled hats.
  pattern = setSteps(pattern, drums.pads, 8, [
    [2, 0.5],
    [5, 0.42],
    [6, 0.5],
    [10, 0.48],
    [13, 0.4],
    [14, 0.5],
  ]);
  pattern = setSteps(pattern, drums.pads, 10, [[7, 0.38]]);
  // Sub syncopation.
  pattern = withNotes(pattern, bass.id, [
    note(33, 0, PPQ * 0.75, 0.9),
    note(33, 5 * (PPQ / 2), PPQ / 2, 0.6),
    note(31, 2 * PPQ + 3 * (PPQ / 4), PPQ * 0.75, 0.85),
    note(28, 3 * PPQ + PPQ / 2, PPQ / 2, 0.75),
  ]);
  // Organ-ish stabs off the beat.
  pattern = withNotes(pattern, stab.id, [
    note(60, 3 * (PPQ / 2), PPQ / 4, 0.5),
    note(63, 3 * (PPQ / 2), PPQ / 4, 0.42),
    note(67, 1440, PPQ / 4, 0.5),
    note(70, 1440, PPQ / 4, 0.4),
  ]);

  doc.tracks = [drums, bass, stab];
  doc.patterns = [pattern];
  doc.scenes = [scene("2-Step", pattern.id)];
  doc.arrangement = { clips: [clip(doc.scenes[0].id, 0, 4)] };
  doc.groove = { swing: 0.35, humanizeTiming: 0, humanizeVelocity: 0 };
  doc.macros = performanceMacros(drums.id, bass.id, stab.id);
  return finish(doc);
}

/* ---------------- Jersey Club — 140 BPM bounce ---------------- */

export function buildJerseyClub(): ProjectDocument {
  const doc = baseDocument("Jersey Club", 140);
  const drums = createDrumTrack();
  const bass = createBass();

  let pattern = emptyPattern("Bounce", [drums]);
  // The signature 3-3-2-3-3-2 kick bounce.
  pattern = setSteps(pattern, drums.pads, 0, [
    [0, 0.95],
    [3, 0.85],
    [6, 0.9],
    [8, 0.95],
    [11, 0.85],
    [14, 0.9],
  ]);
  pattern = setSteps(pattern, drums.pads, 6, [
    [4, 0.9],
    [12, 0.9],
  ]);
  pattern = setSteps(pattern, drums.pads, 10, [
    [2, 0.5],
    [10, 0.5],
  ]);
  // The "squeak" — short tick accents.
  pattern = setSteps(pattern, drums.pads, 14, [
    [7, 0.5],
    [13, 0.55],
  ]);
  pattern = withNotes(pattern, bass.id, [
    note(28, 0, PPQ / 2, 0.9),
    note(28, 3 * (PPQ / 2), PPQ / 4, 0.5),
    note(31, 1440, PPQ / 2, 0.85),
  ]);

  doc.tracks = [drums, bass];
  doc.patterns = [pattern];
  doc.scenes = [scene("Bounce", pattern.id)];
  doc.arrangement = { clips: [clip(doc.scenes[0].id, 0, 4)] };
  doc.groove = { swing: 0.12, humanizeTiming: 0, humanizeVelocity: 0 };
  doc.macros = performanceMacros(drums.id, bass.id, null);
  return finish(doc);
}

/* ---------------- Phonk — 145 BPM half-time ---------------- */

export function buildPhonk(): ProjectDocument {
  const doc = baseDocument("Phonk", 145);
  const drums = createDrumTrack();
  drums.effects = [
    {
      id: uid("fx"),
      type: "drumBuss",
      bypassed: false,
      params: { ...defaultParamsOf("drumBuss"), drive: 0.35, transient: 0.2, compressor: 0.3, tone: 7000 },
    },
  ];
  const bass = createBass();

  let pattern = emptyPattern("Half-Time", [drums]);
  pattern = setSteps(pattern, drums.pads, 0, [
    [0, 0.95],
    [7, 0.8],
    [10, 0.85],
  ]);
  // Half-time snare.
  pattern = setSteps(pattern, drums.pads, 5, [[8, 0.9]]);
  // Quiet driving hats.
  pattern = setSteps(pattern, drums.pads, 8, [
    [2, 0.32],
    [6, 0.32],
    [10, 0.34],
    [14, 0.32],
  ]);
  // The cowbell-style lead line, played by the blip.
  pattern = setSteps(pattern, drums.pads, 15, [
    [0, 0.55],
    [6, 0.5],
    [12, 0.55],
  ]);
  // Long overlapping 808s — the phonk slide, all inside one bar.
  pattern = withNotes(pattern, bass.id, [
    note(24, 0, PPQ * 1.75, 0.95),
    note(25, PPQ * 1.75, PPQ * 0.75, 0.9),
    note(20, PPQ * 2.5, PPQ * 0.75, 0.9),
    note(27, PPQ * 3.25, PPQ * 0.75, 0.85),
  ]);

  doc.tracks = [drums, bass];
  doc.patterns = [pattern];
  doc.scenes = [scene("Half-Time", pattern.id)];
  doc.arrangement = { clips: [clip(doc.scenes[0].id, 0, 4)] };
  doc.macros = performanceMacros(drums.id, bass.id, null);
  return finish(doc);
}

/* ---------------- Drill — 142 BPM sliding 808 ---------------- */

export function buildDrill(): ProjectDocument {
  const doc = baseDocument("Drill", 142);
  const drums = createDrumTrack();
  const bass = createBass();
  bass.name = "808 Slide";

  let pattern = emptyPattern("Slide", [drums]);
  pattern = setSteps(pattern, drums.pads, 0, [
    [0, 0.9],
    [6, 0.8],
    [11, 0.85],
  ]);
  pattern = setSteps(pattern, drums.pads, 5, [
    [8, 0.85],
    [15, 0.5],
  ]);
  // Rolling hats with velocity variation.
  pattern = setSteps(pattern, drums.pads, 8, [
    [0, 0.3],
    [2, 0.24],
    [4, 0.34],
    [6, 0.24],
    [8, 0.36],
    [10, 0.24],
    [12, 0.34],
    [14, 0.26],
  ]);
  // Sliding 808: overlapping short notes into a long hold.
  pattern = withNotes(pattern, bass.id, [
    note(26, 0, PPQ / 2, 0.9),
    note(26, PPQ / 2, PPQ / 2, 0.6),
    note(21, 2 * PPQ, PPQ, 0.9),
    note(23, 1260, PPQ / 2, 0.7),
    note(19, 1440, PPQ * 0.5, 0.9),
  ]);

  doc.tracks = [drums, bass];
  doc.patterns = [pattern];
  doc.scenes = [scene("Slide", pattern.id)];
  doc.arrangement = { clips: [clip(doc.scenes[0].id, 0, 4)] };
  doc.macros = performanceMacros(drums.id, bass.id, null);
  return finish(doc);
}

/* ---------------- Lo-Fi House — 118 BPM dusty swing ---------------- */

export function buildLoFiHouse(): ProjectDocument {
  const doc = baseDocument("Lo-Fi House", 118);
  const drums = createDrumTrack();
  drums.effects = [
    {
      id: uid("fx"),
      type: "tapeSat",
      bypassed: false,
      params: { ...defaultParamsOf("tapeSat"), drive: 0.45, hysteresis: 0.5, tone: 4200 },
    },
  ];
  const bass = createBass();
  bass.name = "Dusty Bass";
  const chords = createKeys();
  chords.name = "Dusty Keys";
  chords.params = {
    ...chords.params,
    oscA: 1,
    oscB: 0,
    cutoff: 2400,
    resonance: 0.6,
    attack: 0.01,
    decay: 0.5,
    sustain: 0.25,
    release: 0.4,
    level: -14,
  };

  let pattern = emptyPattern("Dusty", [drums]);
  pattern = setSteps(pattern, drums.pads, 0, [
    [0, 0.82],
    [4, 0.8],
    [8, 0.82],
    [12, 0.8],
  ]);
  pattern = setSteps(pattern, drums.pads, 9, [
    [2, 0.38],
    [6, 0.4],
    [10, 0.38],
    [14, 0.36],
  ]);
  pattern = setSteps(pattern, drums.pads, 7, [
    [5, 0.3],
    [13, 0.28],
  ]);
  pattern = withNotes(pattern, bass.id, [
    note(33, 0, PPQ * 0.75, 0.8),
    note(36, 1080, PPQ / 2, 0.65),
    note(31, 1440, PPQ * 0.5, 0.8),
    note(29, 1680, PPQ / 4, 0.6),
  ]);
  pattern = withNotes(pattern, chords.id, [
    note(57, 0, PPQ * 0.9, 0.45),
    note(60, 0, PPQ * 0.9, 0.38),
    note(64, 0, PPQ * 0.9, 0.34),
    note(55, 2 * PPQ, PPQ * 0.9, 0.42),
    note(59, 2 * PPQ, PPQ * 0.9, 0.36),
    note(62, 2 * PPQ, PPQ * 0.9, 0.33),
  ]);

  doc.returns[0].effects[0].params = { ...doc.returns[0].effects[0].params, decay: 3.4, tone: 4200 };
  doc.tracks = [drums, bass, chords];
  doc.patterns = [pattern];
  doc.scenes = [scene("Dusty", pattern.id)];
  doc.arrangement = { clips: [clip(doc.scenes[0].id, 0, 4)] };
  doc.groove = { swing: 0.25, humanizeTiming: 0.3, humanizeVelocity: 0.35 }; // already full
  doc.macros = performanceMacros(drums.id, bass.id, chords.id);
  return finish(doc);
}

/* ---------------- Reggaeton — 96 BPM dembow ---------------- */

export function buildReggaeton(): ProjectDocument {
  const doc = baseDocument("Reggaeton", 96);
  const drums = createDrumTrack();
  const bass = createBass();
  bass.name = "Sub";
  const lead = createKeys();
  lead.name = "Lead";

  let pattern = emptyPattern("Dembow", [drums]);
  pattern = setSteps(pattern, drums.pads, 0, [
    [0, 0.95],
    [4, 0.9],
    [8, 0.95],
    [12, 0.9],
  ]);
  // The dembow riddim.
  pattern = setSteps(pattern, drums.pads, 5, [
    [3, 0.85],
    [6, 0.8],
    [11, 0.85],
    [14, 0.8],
  ]);
  pattern = setSteps(pattern, drums.pads, 8, [
    [2, 0.35],
    [10, 0.35],
  ]);
  // Dembow sub line — one note per beat, all inside the 16-step bar.
  pattern = withNotes(pattern, bass.id, [
    note(26, 0, PPQ, 0.9),
    note(21, PPQ, PPQ, 0.85),
    note(26, 2 * PPQ, PPQ, 0.9),
    note(26, 3 * PPQ, PPQ, 0.85),
  ]);
  pattern = withNotes(pattern, lead.id, [
    note(64, 3 * (PPQ / 2), PPQ / 2, 0.5),
    note(67, 2 * PPQ + PPQ / 2, PPQ / 2, 0.45),
    note(69, 3 * PPQ, PPQ / 2, 0.5),
    note(64, 3 * PPQ + PPQ / 2, PPQ / 2, 0.42),
  ]);

  doc.tracks = [drums, bass, lead];
  doc.patterns = [pattern];
  doc.scenes = [scene("Dembow", pattern.id)];
  doc.arrangement = { clips: [clip(doc.scenes[0].id, 0, 4)] };
  doc.macros = performanceMacros(drums.id, bass.id, lead.id);
  return finish(doc);
}

/* ---------------- local factories ---------------- */

function createDrumTrack() {
  // Imported lazily via templates helpers at call time (hoisted circulars).
  return createDrumTrackModel("Drums");
}
function createBass() {
  return createInstrumentTrackModel("808", 1);
}
function createKeys() {
  return createInstrumentTrackModel("analog", 1);
}


