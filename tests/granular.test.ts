import { describe, expect, it } from "vitest";
import { INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";
import type { InstrumentTrack } from "../src/project-model/types";

describe("granular registry entry", () => {
  it("exposes the full grain parameter set", () => {
    const ids = new Set(INSTRUMENT_DEFS.granular.params.map((p) => p.id));
    for (const expected of [
      "position",
      "size",
      "rate",
      "jitter",
      "scan",
      "spread",
      "pitch",
      "pRand",
      "reverse",
      "tone",
      "shape",
      "attack",
      "release",
      "gain",
    ]) {
      expect(ids.has(expected)).toBe(true);
    }
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Granular Synth runtime", () => {
  const SR = 44100;

  function makeTrack(overrides: Record<string, number> = {}): InstrumentTrack {
    return {
      id: "gran-test",
      kind: "instrument",
      instrument: "granular",
      name: "Granular",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "user.grains",
      params: { ...defaultInstrumentParams("granular"), ...overrides },
      effects: [],
      sends: {},
    };
  }

  function makeSourceBuffer(ctx: BaseAudioContext): AudioBuffer {
    const buffer = ctx.createBuffer(1, SR, SR);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.2 * Math.sin((2 * Math.PI * 660 * i) / SR);
    }
    return buffer;
  }

  function makeRuntime(ctx: BaseAudioContext, track: InstrumentTrack) {
    const source = makeSourceBuffer(ctx);
    return INSTRUMENT_DEFS.granular.factory(ctx, track, {
      bpm: 124,
      getSample: (id) => (id === "user.grains" ? source : undefined),
    });
  }

  function peakOf(data: Float32Array, from = 0, to = data.length): number {
    let peak = 0;
    for (let i = from; i < to; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    return peak;
  }

  it("renders an audible grain cloud that starts at `when`", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = makeRuntime(ctx, makeTrack());
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.25, 0.4);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    // silence before the scheduled start…
    expect(peakOf(data, 0, Math.floor(0.2 * SR))).toBeLessThan(1e-4);
    // …and signal after it
    expect(peakOf(data, Math.floor(0.25 * SR), Math.floor(0.65 * SR))).toBeGreaterThan(0.001);
    rt.dispose();
  });

  it("is deterministic — two identical renders match within float jitter", async () => {
    const render = async () => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const rt = makeRuntime(ctx, makeTrack({ jitter: 0.5, spread: 0.8, reverse: 0.5 }));
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 0.4);
      rt.noteOn(64, 0.8, 0.1, 0.3);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return Array.from(buffer.getChannelData(0));
    };
    const a = await render();
    const b = await render();
    expect(a.length).toBe(b.length);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    // Random grain placement would diverge by orders of magnitude; ULP-level
    // rendering differences between otherwise identical graphs are tolerated.
    expect(maxDiff).toBeLessThan(1e-4);
  });

  it("noteOff cuts the tail", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = makeRuntime(ctx, makeTrack({ release: 0.01, rate: 30 }));
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.05, 1.0); // grains scheduled across a full second
    rt.noteOff?.(60, 0.4);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    expect(peakOf(data, Math.floor(0.6 * SR))).toBeLessThan(0.005);
    rt.dispose();
  });

  it("stays silent without a source sample", async () => {
    const ctx = new OfflineAudioContext(2, SR / 2, SR);
    const rt = INSTRUMENT_DEFS.granular.factory(ctx, makeTrack(), { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.05, 0.3);
    const buffer = await ctx.startRendering();
    expect(peakOf(buffer.getChannelData(0))).toBeLessThan(1e-6);
    rt.dispose();
  });

  it("reverse mode plays the cached reversed buffer (still audible)", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = makeRuntime(ctx, makeTrack({ reverse: 1 }));
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.05, 0.4);
    const buffer = await ctx.startRendering();
    expect(peakOf(buffer.getChannelData(0))).toBeGreaterThan(0.001);
    rt.dispose();
  });

  it("survives panic and polyphony overflow", async () => {
    const ctx = new OfflineAudioContext(2, SR / 2, SR);
    const rt = makeRuntime(ctx, makeTrack());
    rt.output.connect(ctx.destination);
    for (let pitch = 60; pitch < 60 + 8; pitch++) rt.noteOn(pitch, 0.9, 0, 0.2); // poly 6 -> two steals
    rt.panic();
    rt.noteOn(72, 0.9, 0, 0.2);
    const buffer = await ctx.startRendering();
    expect(peakOf(buffer.getChannelData(0))).toBeGreaterThan(0.001);
    rt.dispose();
  });

  it("caps grain count on very long notes without error", async () => {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    const rt = makeRuntime(ctx, makeTrack({ rate: 60 }));
    rt.output.connect(ctx.destination);
    // 16 s note at 60 grains/s = 960 grains > cap 512 — must not throw
    expect(() => rt.noteOn(60, 0.9, 0, 16)).not.toThrow();
    await ctx.startRendering();
    rt.dispose();
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Granular scan + pitch rand runtime", () => {
  const SR = 44100;

  function makeTrack(overrides: Record<string, number> = {}): InstrumentTrack {
    return {
      id: "gran-scan-test",
      kind: "instrument",
      instrument: "granular",
      name: "Granular",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "user.grains",
      params: { ...defaultInstrumentParams("granular"), ...overrides },
      effects: [],
      sends: {},
    };
  }

  function makeRuntime(ctx: BaseAudioContext, track: InstrumentTrack) {
    const source = ctx.createBuffer(1, SR, SR);
    const data = source.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.2 * Math.sin((2 * Math.PI * 660 * i) / SR);
    }
    return INSTRUMENT_DEFS.granular.factory(ctx, track, {
      bpm: 124,
      getSample: (id) => (id === "user.grains" ? source : undefined),
    });
  }

  it("renders an audible cloud with backward scan and pitch spray", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = makeRuntime(ctx, makeTrack({ scan: -0.4, pRand: 3, jitter: 0.3, reverse: 0.3 }));
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.05, 0.6);
    const buffer = await ctx.startRendering();
    let peak = 0;
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    expect(peak).toBeGreaterThan(0.001);
    expect(peak).toBeLessThanOrEqual(2);
    rt.dispose();
  });

  it("is deterministic with scan + pitch rand enabled", async () => {
    const render = async () => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const rt = makeRuntime(ctx, makeTrack({ scan: 0.7, pRand: 5, jitter: 0.5, spread: 0.8, reverse: 0.5 }));
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 0.4);
      rt.noteOn(64, 0.8, 0.1, 0.3);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return Array.from(buffer.getChannelData(0));
    };
    const a = await render();
    const b = await render();
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    expect(maxDiff).toBeLessThan(1e-4);
  });

  it("wraps the scan read head at sample boundaries without clipping the offset", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = makeRuntime(ctx, makeTrack({ scan: 2, jitter: 0, rate: 30 }));
    rt.output.connect(ctx.destination);
    expect(() => rt.noteOn(60, 0.9, 0, 0.5)).not.toThrow();
    const buffer = await ctx.startRendering();
    let peak = 0;
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    expect(peak).toBeGreaterThan(0.001);
    rt.dispose();
  });
});

