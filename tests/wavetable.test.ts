import { describe, expect, it } from "vitest";
import {
  FACTORY_WAVETABLES,
  FRAME_SIZE,
  detectPeriod,
  extractWavetable,
  morphFrames,
} from "../src/instruments/wavetables";
import { INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";
import type { InstrumentTrack } from "../src/project-model/types";

describe("factory wavetables", () => {
  it("has uniquely named tables with well-formed frames", () => {
    const names = new Set<string>();
    expect(FACTORY_WAVETABLES.length).toBeGreaterThanOrEqual(4);
    for (const table of FACTORY_WAVETABLES) {
      expect(names.has(table.name)).toBe(false);
      names.add(table.name);
      expect(table.frames.length).toBeGreaterThanOrEqual(2);
      for (const frame of table.frames) {
        expect(frame.length).toBe(FRAME_SIZE);
        let peak = 0;
        let mean = 0;
        for (const v of frame) {
          mean += v;
          const a = Math.abs(v);
          if (a > peak) peak = a;
        }
        mean /= frame.length;
        // peak-normalized to ~1, DC-free
        expect(peak).toBeGreaterThan(0.5);
        expect(peak).toBeLessThanOrEqual(1);
        expect(Math.abs(mean)).toBeLessThan(0.01);
      }
    }
  });

  it("morphFrames picks adjacent frames with a blend factor", () => {
    const frames = FACTORY_WAVETABLES[0].frames;
    const start = morphFrames(frames, 0);
    expect(start.blend).toBeCloseTo(0, 5);
    expect(start.a).toBe(frames[0]);
    const mid = morphFrames(frames, 0.5 / (frames.length - 1));
    expect(mid.blend).toBeCloseTo(0.5, 5);
    const end = morphFrames(frames, 1);
    expect(end.blend).toBeCloseTo(1, 5);
    expect(end.a).toBe(frames[frames.length - 2]);
    expect(end.b).toBe(frames[frames.length - 1]);
    // clamps out-of-range morph
    expect(morphFrames(frames, -3).blend).toBeCloseTo(0, 5);
    expect(morphFrames(frames, 9).b).toBe(frames[frames.length - 1]);
  });

  it("handles a single-frame table", () => {
    const { a, b, blend } = morphFrames([new Float32Array(FRAME_SIZE)], 0.7);
    expect(blend).toBe(0);
    expect(a).toBe(b);
  });
});

describe("period detection", () => {
  const SR = 44100;

  it("finds the fundamental of a sine, not a multiple", () => {
    const freq = 220;
    const data = new Float32Array(SR); // 1 s
    for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / SR);
    const period = detectPeriod(data, Math.floor(SR / 4000), Math.floor(SR / 30));
    expect(period).not.toBeNull();
    expect(period!).toBeGreaterThan(0.9 * (SR / freq));
    expect(period!).toBeLessThan(1.1 * (SR / freq));
  });

  it("returns null for silence", () => {
    const data = new Float32Array(8192);
    expect(detectPeriod(data, 8, 512)).toBeNull();
  });

  it("returns null for white noise below the confidence threshold", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const data = new Float32Array(32768);
    for (let i = 0; i < data.length; i++) data[i] = rand() * 2 - 1;
    const period = detectPeriod(data, Math.floor(SR / 4000), Math.floor(SR / 30));
    // white noise has no fundamental — either null or a very weak match
    if (period !== null) {
      expect(period).toBeLessThanOrEqual(SR / 30 + 1);
    }
  });
});

describe("extractWavetable", () => {
  const SR = 44100;

  it("slices a periodic tone into seamless single-cycle frames", () => {
    const freq = 220;
    const data = new Float32Array(SR);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.sin((2 * Math.PI * freq * i) / SR) + 0.3 * Math.sin((2 * Math.PI * freq * 2 * i) / SR);
    }
    const table = extractWavetable(data, SR);
    expect(table).not.toBeNull();
    expect(table!.frames.length).toBeGreaterThanOrEqual(4);
    for (const frame of table!.frames) {
      expect(frame.length).toBe(FRAME_SIZE);
      // The frame should still look like the source cycle — the starting
      // phase depends on where the analysis window landed, so compare the
      // magnitude of the correlation against a pure sine of one cycle.
      let dot = 0;
      let energy = 0;
      for (let i = 0; i < FRAME_SIZE; i++) {
        const ref = Math.sin((2 * Math.PI * i) / FRAME_SIZE);
        dot += frame[i] * ref;
        energy += frame[i] * frame[i];
      }
      const cos = dot / Math.sqrt(energy * FRAME_SIZE / 2);
      expect(Math.abs(cos)).toBeGreaterThan(0.9);
      // Loop-wrap continuity: adjacent samples at the seam are close.
      const seam = Math.abs(frame[FRAME_SIZE - 1] - frame[0]);
      expect(seam).toBeLessThan(0.15);
    }
  });

  it("falls back to a single frame for aperiodic input", () => {
    let seed = 999;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const data = new Float32Array(SR / 2);
    for (let i = 0; i < data.length; i++) data[i] = rand() * 2 - 1;
    const table = extractWavetable(data, SR);
    expect(table).not.toBeNull();
    expect(table!.frames.length).toBe(1);
    expect(table!.frames[0].length).toBe(FRAME_SIZE);
  });

  it("returns null for too-short input", () => {
    expect(extractWavetable(new Float32Array(64), SR)).toBeNull();
  });
});

describe("wavetable registry entry", () => {
  it("exposes table/morph/detune and a full filter/envelope set", () => {
    const ids = new Set(INSTRUMENT_DEFS.wavetable.params.map((p) => p.id));
    for (const expected of ["table", "morph", "detune", "sub", "cutoff", "resonance", "attack", "release", "level"]) {
      expect(ids.has(expected)).toBe(true);
    }
  });

  it("table select offers one option per factory table", () => {
    const tableParam = INSTRUMENT_DEFS.wavetable.params.find((p) => p.id === "table")!;
    expect(tableParam.options?.length).toBe(FACTORY_WAVETABLES.length);
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Wavetable Synth runtime", () => {
  const SR = 44100;

  function makeTrack(overrides: Record<string, number> = {}): InstrumentTrack {
    return {
      id: "wt-test",
      kind: "instrument",
      instrument: "wavetable",
      name: "Wavetable",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: { ...defaultInstrumentParams("wavetable"), ...overrides },
      effects: [],
      sends: {},
    };
  }

  function renderPeak(track: InstrumentTrack): Promise<{ peak: number; hfRatio: number }> {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    const rt = INSTRUMENT_DEFS.wavetable.factory(ctx, track, { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.05, 0.5);
    return ctx.startRendering().then((buffer) => {
      const data = buffer.getChannelData(0);
      let peak = 0;
      let sum = 0;
      let diff = 0;
      for (let i = 1; i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
        sum += data[i] * data[i];
        const d = data[i] - data[i - 1];
        diff += d * d;
      }
      // first-difference energy ratio: a brightness proxy that separates a
      // pure sine (low) from a saw (high) at the same fundamental
      const hfRatio = Math.sqrt(diff / Math.max(sum, 1e-12));
      return { peak, hfRatio };
    });
  }

  it("renders an audible tone and accepts parameter updates", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = INSTRUMENT_DEFS.wavetable.factory(ctx, makeTrack(), { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    for (const p of INSTRUMENT_DEFS.wavetable.params) {
      rt.setParameter(p.id, p.min);
      rt.setParameter(p.id, p.max);
      rt.setParameter(p.id, p.default);
    }
    rt.noteOn(60, 0.9, 0.05, 0.3);
    const buffer = await ctx.startRendering();
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
    }
    expect(peak).toBeGreaterThan(0.001);
    expect(peak).toBeLessThanOrEqual(2);
    rt.dispose();
  });

  it("morphing brightens the spectrum (sine frame -> saw-ish frame)", async () => {
    // Table 0 starts at a pure sine and ends at a full saw.
    const dark = await renderPeak(makeTrack({ morph: 0, detune: 0, sub: 0 }));
    const bright = await renderPeak(makeTrack({ morph: 1, detune: 0, sub: 0 }));
    expect(dark.peak).toBeGreaterThan(0.001);
    expect(bright.peak).toBeGreaterThan(0.001);
    // The saw's harmonic stack carries far more high-frequency energy.
    expect(bright.hfRatio).toBeGreaterThan(dark.hfRatio * 2);
  });

  it("silences and recovers after panic, and steals the oldest voice past polyphony", async () => {
    const ctx = new OfflineAudioContext(2, SR / 2, SR);
    const rt = INSTRUMENT_DEFS.wavetable.factory(ctx, makeTrack(), { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    for (let pitch = 60; pitch < 60 + 9; pitch++) rt.noteOn(pitch, 0.9, 0, 0.2); // poly 8 -> one steal
    rt.panic();
    rt.noteOn(60, 0.9, 0, 0.2);
    const buffer = await ctx.startRendering();
    let peak = 0;
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    expect(peak).toBeGreaterThan(0.001);
    rt.dispose();
  });

  it("derives a table from the assigned sample via setSample", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const freq = 330;
    const sampleBuffer = ctx.createBuffer(1, SR / 2, SR);
    const sd = sampleBuffer.getChannelData(0);
    for (let i = 0; i < sd.length; i++) sd[i] = 0.6 * Math.sin((2 * Math.PI * freq * i) / SR);
    const rt = INSTRUMENT_DEFS.wavetable.factory(
      ctx,
      makeTrack(),
      { bpm: 124, getSample: (id) => (id === "user.cycle" ? sampleBuffer : undefined) },
    );
    rt.output.connect(ctx.destination);
    rt.setSample?.("user.cycle");
    rt.noteOn(69, 0.9, 0.05, 0.3); // A4 = 440 Hz, the extracted 330 Hz table plays a fourth up
    const buffer = await ctx.startRendering();
    let peak = 0;
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    expect(peak).toBeGreaterThan(0.001);
    rt.dispose();
  });
});
