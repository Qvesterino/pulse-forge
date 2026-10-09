import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_PRESETS } from "../src/presets/factory";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { BUILDERS, DURATIONS } from "../src/sample-library/factory";
import { CURATED_SAMPLES } from "../src/sample-library/curated";
import {
  FACTORY_808_VELOCITY,
  FACTORY_ACID_VELOCITY,
  FACTORY_PLUCK_VELOCITY,
  FACTORY_SUB_VELOCITY,
} from "../src/sample-library/velocity-layers";
import type { InstrumentPreset, PresetGenre } from "../src/presets/types";
import type { InstrumentTrack, ProjectDocument, SampleLayer } from "../src/project-model/types";
import { applyInstrumentPreset } from "../src/commands/instrument";
import { createInstrumentTrack } from "../src/commands/commands";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";

/**
 * VELOCITY-DYNAMICS PRESETS (2026-10-09) — the first FACTORY_PRESETS that
 * carry `velocityLayers`. Until this wave the multi-sample surface was
 * pack-only (Salamander piano, VSCO2): the eager factory bank shipped 600+
 * single-sample presets while sample-library/velocity-layers.ts sat with
 * ready-made dynamics sets nothing selected. Each dynamics preset layers
 * zone voices of the SAME recorded root, so a played dynamic range changes
 * TIMBRE per band without ever stepping pitch — the melodic counterpart of
 * the drum-side DYNAMIC sets that already ride DrumPad.layers.
 *
 * Locked here: the data contract (disjoint full-range windows, real bank
 * voices), the MEASURED shared-root invariant (zones decoded from the
 * curated WAVs must agree on one fundamental — the pitch-stepping hazard
 * that keeps the kick velocity kit unwired must never reach a preset), the
 * command contract (apply/undo/idempotence via applyInstrumentPreset) and
 * the runtime selection (velocity actually switches the timbre).
 */

const DYNAMICS: Array<{
  presetId: string;
  name: string;
  genre: PresetGenre;
  layers: SampleLayer[];
  /** MIDI root every zone voice is recorded at. */
  root: number;
  /** The recorded fundamental in Hz (the builder's documented pitch). */
  anchorHz: number;
  midSampleId: string;
}> = [
  {
    presetId: "factory.sampler.trap.808dynamics",
    name: "808 Dynamics",
    genre: "trap",
    layers: FACTORY_808_VELOCITY,
    root: 26,
    anchorHz: 36.71, // D1
    midSampleId: "factory.bass.808.medium",
  },
  {
    presetId: "factory.sampler.dnb.subdynamics",
    name: "Sub Dynamics",
    genre: "dnb",
    layers: FACTORY_SUB_VELOCITY,
    root: 29,
    anchorHz: 43.65, // F1
    midSampleId: "factory.bass.subsine",
  },
  {
    presetId: "factory.sampler.techno.aciddynamics",
    name: "Acid Dynamics",
    genre: "techno",
    layers: FACTORY_ACID_VELOCITY,
    root: 36,
    anchorHz: 65.41, // C2
    midSampleId: "factory.bass.acid.slow",
  },
  {
    presetId: "factory.sampler.house.pluckdynamics",
    name: "Pluck Dynamics",
    genre: "house",
    layers: FACTORY_PLUCK_VELOCITY,
    root: 69,
    anchorHz: 440, // A4
    midSampleId: "factory.lead.pluck.dark",
  },
];

const SR = 44100;

/** Minimal 24-bit decode of one curated WAV (dual-mono by contract). */
function decodeCurated(file: string): Float32Array {
  const buf = readFileSync(path.resolve(__dirname, "..", "public", "samples", file));
  let pos = 12;
  let fmt: { pos: number } | null = null;
  let data: { pos: number; size: number } | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { pos: pos + 8 };
    else if (id === "data") {
      data = { pos: pos + 8, size };
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file}: missing fmt/data`);
  const channels = buf.readUInt16LE(fmt.pos + 2);
  const frames = Math.floor(data.size / 3 / channels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = data.pos + f * channels * 3;
    out[f] = ((buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)) << 8) / 2147483648;
  }
  return out;
}

/** Goertzel magnitude at one frequency over the steady-state window. */
function goertzelMag(x: Float32Array, hz: number, fromSec: number, durSec: number): number {
  const from = Math.floor(fromSec * SR);
  const n = Math.min(Math.floor(durSec * SR), x.length - from);
  const k = (2 * Math.PI * hz) / SR;
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < from + n; i++) {
    const s0 = x[i] + 2 * Math.cos(k) * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(k) * s1 * s2) / n;
}

/**
 * The zone's documented fundamental must be the DOMINANT partial in its
 * band: Goertzel at the anchor vs the strongest competitor anywhere within
 * ±4 semitones (excluding ±60 cents around it — detune pairs ride there).
 * A naive FFT-peak read fails here (resonant filter sweeps and glide+drive
 * voices pull the peak bin off the fundamental — exactly why the bass-pack
 * anchors skip the heavy-harmonic voices), so the assertion is dominance of
 * the authored frequency, not a peak-hunt.
 */
function anchorIsDominant(
  x: Float32Array,
  anchorHz: number,
): { anchor: number; competitor: number; competitorHz: number } {
  const anchor = goertzelMag(x, anchorHz, 0.3, 0.4);
  let competitor = 0;
  let competitorHz = 0;
  for (let hz = anchorHz / Math.pow(2, 4 / 12); hz <= anchorHz * Math.pow(2, 4 / 12); hz += 1.5) {
    const cents = Math.abs(1200 * Math.log2(hz / anchorHz));
    if (cents < 60) continue;
    const m = goertzelMag(x, hz, 0.3, 0.4);
    if (m > competitor) {
      competitor = m;
      competitorHz = hz;
    }
  }
  return { anchor, competitor, competitorHz };
}

function dynamicsPreset(presetId: string): InstrumentPreset {
  const preset = FACTORY_PRESETS.find((p) => p.id === presetId);
  expect(preset, presetId).toBeDefined();
  return preset!;
}

describe("velocity-dynamics presets — data contract", () => {
  it("the four presets exist as sampler entries carrying their layer set", () => {
    for (const spec of DYNAMICS) {
      const preset = dynamicsPreset(spec.presetId);
      expect(preset.instrument, spec.presetId).toBe("sampler");
      expect(preset.name, spec.presetId).toBe(spec.name);
      expect(preset.genre, spec.presetId).toBe(spec.genre);
      expect(preset.velocityLayers, `${spec.presetId} layers`).toBe(spec.layers);
      // The mid zone doubles as the single-sample fallback when a consumer
      // ignores layers.
      expect(preset.sampleId, spec.presetId).toBe(spec.midSampleId);
      expect(preset.params.root, spec.presetId).toBe(spec.root);
    }
  });

  it("every set partitions the full velocity range with touching disjoint windows", () => {
    for (const spec of DYNAMICS) {
      const layers = [...spec.layers].sort((a, b) => a.min - b.min);
      expect(layers[0].min, spec.presetId).toBe(0);
      expect(layers[layers.length - 1].max, spec.presetId).toBe(1);
      for (let i = 0; i < layers.length; i++) {
        expect(layers[i].max, `${spec.presetId} zone ${i}`).toBeGreaterThan(layers[i].min);
        if (i > 0) expect(layers[i].min, `${spec.presetId} seam ${i - 1}`).toBe(layers[i - 1].max);
      }
      // Disjoint windows = one timbre per band (not a hidden round robin).
      expect(new Set(layers.map((l) => l.sampleId)).size, spec.presetId).toBe(layers.length);
    }
  });

  it("every zone voice resolves in the bank contract (no silent zone)", () => {
    for (const spec of DYNAMICS) {
      for (const layer of spec.layers) {
        const id = layer.sampleId as string;
        expect(
          FACTORY_ASSETS.some((a) => a.id === id),
          `${spec.presetId} → ${id} manifest`,
        ).toBe(true);
        expect(typeof BUILDERS[id], `${id} builder`).toBe("function");
        expect(Number.isFinite(DURATIONS[id]) && DURATIONS[id] > 0, `${id} duration`).toBe(true);
        const curated = CURATED_SAMPLES.filter((c) => c.id === id);
        expect(curated, `${id} curated`).toHaveLength(1);
        expect(curated[0].file).toBe(`${id}.wav`);
      }
    }
  });
});

describe("velocity-dynamics presets — measured shared-root invariant", () => {
  it("the documented fundamental dominates each zone (velocity changes timbre, never pitch)", () => {
    for (const spec of DYNAMICS) {
      for (const layer of spec.layers) {
        const x = decodeCurated(`${layer.sampleId}.wav`);
        const { anchor, competitor, competitorHz } = anchorIsDominant(x, spec.anchorHz);
        expect(anchor, `${spec.presetId} zone ${layer.sampleId}: no energy at ${spec.anchorHz} Hz`).toBeGreaterThan(0);
        expect(
          anchor / competitor,
          `${spec.presetId} zone ${layer.sampleId}: anchor ${spec.anchorHz} Hz must dominate its band (competitor ${competitorHz.toFixed(1)} Hz)`,
        ).toBeGreaterThan(1.5);
      }
    }
  });
});

describe("velocity-dynamics presets — command contract", () => {
  function samplerDoc(): { doc: ProjectDocument; trackId: string } {
    let doc = createProjectFromTemplate("empty");
    doc = createInstrumentTrack(doc, "sampler").execute(doc);
    doc = normalizeProject(doc);
    const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "sampler");
    if (!track) throw new Error("no sampler track");
    return { doc, trackId: track.id };
  }

  it("applyInstrumentPreset lands layers + params on the track; undo restores exactly", () => {
    const { doc, trackId } = samplerDoc();
    const before = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId)!;
    const preset = dynamicsPreset("factory.sampler.trap.808dynamics");

    const cmd = applyInstrumentPreset(doc, trackId, preset);
    const applied = cmd.execute(doc);
    const appliedTrack = applied.tracks.find((t): t is InstrumentTrack => t.id === trackId)!;
    expect(appliedTrack.velocityLayers).toBe(FACTORY_808_VELOCITY);
    expect(appliedTrack.sampleId).toBe("factory.bass.808.medium");
    expect(appliedTrack.presetId).toBe("factory.sampler.trap.808dynamics");
    expect(appliedTrack.params.root).toBe(26);

    const undone = cmd.undo(applied);
    const undoneTrack = undone.tracks.find((t): t is InstrumentTrack => t.id === trackId)!;
    expect(undoneTrack.velocityLayers).toBeUndefined();
    expect(undoneTrack.params).toEqual(before.params);
    expect(undoneTrack.sampleId).toBe(before.sampleId);
  });

  it("re-applying the same preset is idempotent (same layers, same params)", () => {
    const { doc, trackId } = samplerDoc();
    const preset = dynamicsPreset("factory.sampler.dnb.subdynamics");
    const once = applyInstrumentPreset(doc, trackId, preset).execute(doc);
    const twice = applyInstrumentPreset(once, trackId, preset).execute(once);
    const onceTrack = once.tracks.find((t): t is InstrumentTrack => t.id === trackId)!;
    const twiceTrack = twice.tracks.find((t): t is InstrumentTrack => t.id === trackId)!;
    expect(twiceTrack).toEqual(onceTrack);
    expect(twiceTrack.velocityLayers).toBe(FACTORY_SUB_VELOCITY);
  });

  it("the layer set survives a JSON migration round-trip", () => {
    const { doc, trackId } = samplerDoc();
    const preset = dynamicsPreset("factory.sampler.techno.aciddynamics");
    const applied = applyInstrumentPreset(doc, trackId, preset).execute(doc);
    const migrated = normalizeProject(JSON.parse(JSON.stringify(applied)) as ProjectDocument);
    const track = migrated.tracks.find((t): t is InstrumentTrack => t.id === trackId)!;
    expect(track.velocityLayers).toEqual(FACTORY_ACID_VELOCITY);
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("velocity-dynamics runtime selection", () => {
  const zcc = (data: Float32Array, from: number, to: number): number => {
    let c = 0;
    for (let i = from + 1; i < to; i++) {
      if (data[i - 1] < 0 !== data[i] < 0) c++;
    }
    return c;
  };

  function layerTrack(preset: InstrumentPreset): InstrumentTrack {
    return {
      id: "vel-dyn-test",
      kind: "instrument",
      instrument: "sampler",
      name: preset.name,
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: preset.sampleId ?? null,
      velocityLayers: preset.velocityLayers,
      params: { ...defaultInstrumentParams("sampler"), ...preset.params },
      effects: [],
      sends: {},
    };
  }

  it("playing the 808 dynamics preset switches timbre with velocity (soft vs hard zone)", async () => {
    const { generateFactoryBank } = await import("../src/sample-library/factory");
    const bank = await generateFactoryBank();
    const preset = dynamicsPreset("factory.sampler.trap.808dynamics");
    const render = async (velocity: number): Promise<number> => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const rt = INSTRUMENT_DEFS.sampler.factory(ctx, layerTrack(preset), {
        bpm: 124,
        getSample: (id) => bank.get(id ?? ""),
      });
      rt.output.connect(ctx.destination);
      rt.noteOn(26, velocity, 0.05, 0.4); // the root — no pitch shift, pure zone selection
      const buffer = await ctx.startRendering();
      rt.dispose();
      return zcc(buffer.getChannelData(0), 0, SR);
    };
    const soft = await render(0.2); // soft zone — clean sine body
    const hard = await render(0.9); // hard zone — driven + click
    const full = await render(1); // inclusive max=1 boundary must reach the hard zone
    expect(soft).toBeGreaterThan(100);
    expect(hard).toBeGreaterThan(soft * 1.4); // drive harmonics = measurably more crossings
    expect(full).toBeGreaterThan(soft * 1.4);
  });
});
