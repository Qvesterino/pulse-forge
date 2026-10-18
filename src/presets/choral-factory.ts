/**
 * CHORÁL factory presets (ADR 0054 follow-up wave — the first factory bank).
 *
 * Four hand-curated harmony presets on the factory tonal carriers (the
 * sustained synth samples are ideal grain sources; their anchors are
 * documented at their synth functions in src/sample-library/factory.ts —
 * choirpad A3/220 Hz, cello C2/65.41 Hz, darkstrings C4, erhu D4/293.66 Hz
 * — and every preset pins srcRoot to that anchor, which is what keeps the
 * grain resampling IN TUNE).
 *
 * EAGER (imported into `FACTORY_PRESETS`) like the KOPA bank; the preset
 * loudness harness measures them with everything else.
 */

import type { InstrumentPreset, PresetGenre, PresetMood } from "./types";

interface ChoralPresetSpec {
  key: string;
  name: string;
  genre: PresetGenre;
  mood: PresetMood[];
  tags: string[];
  sampleId: string;
  params: Record<string, number>;
}

const SPECS: ChoralPresetSpec[] = [
  {
    key: "aah-choir",
    name: "Aah Choir",
    genre: "ambient",
    mood: ["atmosphere", "warm"],
    tags: ["choir", "vocal", "harmony", "pad"],
    sampleId: "factory.tonal.choirpad",
    params: {
      srcRoot: 57, // the choirpad's A3 anchor
      stackMode: 3,
      stackLevel: 0.65,
      stackDetune: 8,
      grainSize: 90,
      grainDensity: 24,
      grainJitter: 0.15,
      attack: 0.12,
      release: 1.2,
      tone: -0.1,
      formant: 1,
      // 0.7 measured -11.2 LUFS — the normalization wanted past -18 dB of
      // trim (a pinned clamp hit). The stack of three grain streams at this
      // level is simply hot; 0.45 sits the preset inside its family.
      level: 0.45,
    },
  },
  {
    key: "cello-ensemble",
    name: "Cello Ensemble",
    genre: "score",
    mood: ["deep", "dark"],
    tags: ["cello", "strings", "low", "harmony"],
    sampleId: "factory.tonal.cello",
    params: {
      srcRoot: 36, // the cello's C2 anchor
      stackMode: 3,
      stackLevel: 0.5,
      stackDetune: 5,
      grainSize: 70,
      grainDensity: 20,
      grainJitter: 0.1,
      attack: 0.09,
      release: 0.9,
      tone: -0.25,
      formant: 0.9,
      level: 0.65,
    },
  },
  {
    key: "menace-fifths",
    name: "Menace Fifths",
    genre: "drill",
    mood: ["dark", "aggressive"],
    tags: ["strings", "fifths", "drill", "harmony"],
    sampleId: "factory.tonal.darkstrings",
    params: {
      srcRoot: 60, // the darkstrings' C4 anchor
      stackMode: 2, // FIFTHS — the drill menace bed
      stackLevel: 0.55,
      stackDetune: 12,
      grainSize: 65,
      grainDensity: 22,
      grainJitter: 0.2,
      attack: 0.06,
      release: 0.8,
      tone: -0.2,
      formant: 0.9,
      level: 0.6,
    },
  },
  {
    key: "erhu-line",
    name: "Erhu Line",
    genre: "score",
    mood: ["warm", "clean"],
    tags: ["erhu", "lead", "sustain", "solo"],
    sampleId: "factory.tonal.erhu",
    params: {
      srcRoot: 62, // the erhu's D4 anchor
      stackMode: 0, // OFF — the sustaining instrument without the stack
      grainSize: 85,
      grainDensity: 26,
      grainJitter: 0.12,
      attack: 0.05,
      release: 0.7,
      tone: 0.1,
      formant: 1.1,
      level: 0.7,
    },
  },
];

/** All CHORÁL factory presets (deterministic order). */
export const CHORAL_FACTORY_PRESETS: InstrumentPreset[] = SPECS.map((spec) => ({
  id: `factory.choral.${spec.key}`,
  name: spec.name,
  instrument: "choral",
  genre: spec.genre,
  mood: spec.mood,
  tags: spec.tags,
  sampleId: spec.sampleId,
  params: { ...spec.params },
}));
