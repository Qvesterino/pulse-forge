import { describe, expect, it } from "vitest";
import { StrkProcessor } from "../src/strk/dsp/strkProcessor";
import { CinkProcessor } from "../src/cink/dsp/cinkProcessor";
import { defaultInstrumentParams } from "../src/instruments/definitions";
import { normalizeProject } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { InstrumentTrack } from "../src/project-model/types";
import type { InstrumentRuntime } from "../src/instruments/types";

/**
 * ŠTRK & CINK (ADR 0060) — the snare and hat designers. Pinned: one-shot
 * voice death (a designer must free its voice for the next hit), pitch
 * tracking (TUNE moves the body), determinism (seeded LCG noise), offline
 * parity, finite/bounded renders at extremes, and kind healing.
 */

const SR = 48000;
const BLOCK = 128;

function renderStrk(params: Record<string, number>, pitch: number, seconds = 0.5): Float32Array {
  const proc = new StrkProcessor({ sampleRate: SR });
  proc.applyParams({ level: 0.8, ...params });
  proc.postEvent({ type: "noteOn", when: 0, pitch, velocity: 0.9 });
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += BLOCK) {
    proc.process(left.subarray(frame, frame + BLOCK), new Float32Array(BLOCK), frame);
  }
  return left;
}

function renderCink(params: Record<string, number>, pitch: number, seconds = 0.5): Float32Array {
  const proc = new CinkProcessor({ sampleRate: SR });
  proc.applyParams({ level: 0.8, ...params });
  proc.postEvent({ type: "noteOn", when: 0, pitch, velocity: 0.9 });
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += BLOCK) {
    proc.process(left.subarray(frame, frame + BLOCK), new Float32Array(BLOCK), frame);
  }
  return left;
}

function rms(data: Float32Array, fromSec: number, seconds: number): number {
  const start = Math.floor(fromSec * SR);
  const count = Math.floor(seconds * SR);
  let sumSq = 0;
  for (let i = start; i < start + count; i++) sumSq += data[i]! * data[i]!;
  return Math.sqrt(sumSq / Math.max(1, count));
}

describe("ŠTRK snare designer (ADR 0060)", () => {
  it("is deterministic — the seeded wire noise renders byte-identical", () => {
    const a = renderStrk({ wireLevel: 0.8, snappy: 0.7 }, 60);
    const b = renderStrk({ wireLevel: 0.8, snappy: 0.7 }, 60);
    expect([...a]).toEqual([...b]);
  });

  it("the hit dies: a one-shot renders silent past its decay envelope", () => {
    const out = renderStrk({}, 60, 2.0);
    expect(rms(out, 1.0, 0.5)).toBeLessThan(0.001);
  });

  it("TUNE moves the body pitch (a +12 st body rings near double the cycles)", () => {
    const low = renderStrk({ tune: -12, bodyLevel: 1, wireLevel: 0, snapLevel: 0 }, 60, 0.3);
    const high = renderStrk({ tune: 12, bodyLevel: 1, wireLevel: 0, snapLevel: 0 }, 60, 0.3);
    const cycles = (data: Float32Array) => {
      let crossings = 0;
      for (let i = 1; i < data.length; i++) if (data[i - 1]! <= 0 && data[i]! > 0) crossings += 1;
      return crossings;
    };
    expect(cycles(high)).toBeGreaterThan(cycles(low) * 1.5);
  });

  it("is finite and bounded at the extremes", () => {
    const out = renderStrk(
      { snapLevel: 1, bodyLevel: 1, wireLevel: 1, snappy: 1, drive: 1, level: 1.5, bodyDecay: 1.2, wireDecay: 1 },
      60,
      0.8,
    );
    let peak = 0;
    let nonFinite = 0;
    for (const v of out) {
      if (!Number.isFinite(v)) nonFinite += 1;
      else peak = Math.max(peak, Math.abs(v));
    }
    expect(nonFinite).toBe(0);
    expect(peak).toBeLessThanOrEqual(1.6); // tanh drive bounds the bus
    expect(peak).toBeGreaterThan(0.1);
  });

  it("offline parity: queue-fed and constructor-seeded events render identically", () => {
    const build = (seeded: boolean) => {
      const proc = new StrkProcessor({
        sampleRate: SR,
        events: seeded
          ? undefined
          : [
              { type: "noteOn", when: 0, pitch: 62, velocity: 0.9 },
              { type: "noteOn", when: 0.15, pitch: 62, velocity: 0.7 },
            ],
      });
      proc.applyParams({ level: 0.8, wireLevel: 0.8 });
      if (seeded) {
        proc.postEvent({ type: "noteOn", when: 0, pitch: 62, velocity: 0.9 });
        proc.postEvent({ type: "noteOn", when: 0.15, pitch: 62, velocity: 0.7 });
      }
      const frames = Math.ceil(0.4 * SR);
      const left = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += BLOCK) {
        proc.process(left.subarray(frame, frame + BLOCK), new Float32Array(BLOCK), frame);
      }
      return [...left];
    };
    expect(build(true)).toEqual(build(false));
  });
});

describe("CINK hat designer (ADR 0060)", () => {
  it("is deterministic — the phase-scatter renders byte-identical", () => {
    const a = renderCink({ metalSpread: 0.3 }, 60);
    const b = renderCink({ metalSpread: 0.3 }, 60);
    expect([...a]).toEqual([...b]);
  });

  it("DECAY spans closed to open: the long decay is still audible at 0.4 s", () => {
    const closed = renderCink({ decay: 0.06 }, 60, 0.6);
    const open = renderCink({ decay: 1.0 }, 60, 0.6);
    const closedTail = rms(closed, 0.3, 0.15);
    const openTail = rms(open, 0.3, 0.15);
    expect(closedTail).toBeLessThan(0.001);
    expect(openTail).toBeGreaterThan(closedTail * 20);
  });

  it("is finite and bounded at the extremes", () => {
    const out = renderCink(
      { tune: 12, decay: 1.2, chirp: 1, metalSpread: 1, pulseMix: 1, drive: 1, level: 1.5 },
      60,
      0.8,
    );
    let peak = 0;
    let nonFinite = 0;
    for (const v of out) {
      if (!Number.isFinite(v)) nonFinite += 1;
      else peak = Math.max(peak, Math.abs(v));
    }
    expect(nonFinite).toBe(0);
    expect(peak).toBeLessThanOrEqual(1.5);
  });

  it("offline parity: queue-fed and constructor-seeded events render identically", () => {
    const build = (seeded: boolean) => {
      const proc = new CinkProcessor({
        sampleRate: SR,
        events: seeded
          ? undefined
          : [
              { type: "noteOn", when: 0, pitch: 60, velocity: 0.9 },
              { type: "noteOn", when: 0.12, pitch: 65, velocity: 0.8 },
            ],
      });
      proc.applyParams({ level: 0.8, metalSpread: 0.25 });
      if (seeded) {
        proc.postEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
        proc.postEvent({ type: "noteOn", when: 0.12, pitch: 65, velocity: 0.8 });
      }
      const frames = Math.ceil(0.3 * SR);
      const left = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += BLOCK) {
        proc.process(left.subarray(frame, frame + BLOCK), new Float32Array(BLOCK), frame);
      }
      return [...left];
    };
    expect(build(true)).toEqual(build(false));
  });
});

describe("ŠTRK & CINK kind integration (ADR 0060)", () => {
  it("the default patches exist and normalizeProject keeps both tracks", () => {
    const strk = defaultInstrumentParams("strk");
    const cink = defaultInstrumentParams("cink");
    expect(strk.snappy).toBe(0.6);
    expect(cink.decay).toBe(0.4);
    const doc = createProjectFromTemplate("house");
    const base = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument");
    if (!base) throw new Error("no instrument track in template");
    doc.tracks.push({ ...base, id: "strk-it", instrument: "strk" }, { ...base, id: "cink-it", instrument: "cink" });
    const healed = normalizeProject(doc);
    expect((healed.tracks.find((t) => t.id === "strk-it") as InstrumentTrack).instrument).toBe("strk");
    expect((healed.tracks.find((t) => t.id === "cink-it") as InstrumentTrack).instrument).toBe("cink");
  });

  it("both fallback runtimes are audible paths that never throw", async () => {
    const { createStrkFallbackRuntime } = await import("../src/instruments/strkFallback");
    const { createCinkFallbackRuntime } = await import("../src/instruments/cinkFallback");
    const chain = () => ({
      connect(target: unknown) {
        void target;
        return chain();
      },
      disconnect() {},
    });
    const ctx = {
      currentTime: 0,
      createGain: () => ({
        gain: {
          value: 1,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
          setTargetAtTime() {},
          cancelScheduledValues() {},
        },
        ...chain(),
      }),
      createBiquadFilter: () => ({
        type: "bandpass",
        frequency: { ...chain(), setValueAtTime() {} } as unknown as AudioParam,
        Q: { value: 1 },
        connect: chain,
        disconnect() {},
      }),
      createOscillator: () => ({
        type: "sawtooth",
        frequency: { ...chain(), setValueAtTime() {} } as unknown as AudioParam,
        connect: chain,
        start() {},
        stop() {},
      }),
    } as unknown as BaseAudioContext;
    const track = { id: "fb", kind: "instrument", instrument: "strk", params: {} } as unknown as InstrumentTrack;
    expect(() => {
      const s = createStrkFallbackRuntime(ctx, track);
      const r = s as Required<Pick<InstrumentRuntime, "noteOn" | "noteOff" | "panic" | "dispose">> & InstrumentRuntime;
      r.noteOn(60, 0.9, 0, 0.3);
      r.noteOff(60, 0.2);
      r.panic();
      r.dispose();
    }).not.toThrow();
    expect(() => {
      const c = createCinkFallbackRuntime(ctx, track);
      const r = c as Required<Pick<InstrumentRuntime, "noteOn" | "noteOff" | "panic" | "dispose">> & InstrumentRuntime;
      r.noteOn(60, 0.9, 0, 0.3);
      r.panic();
      r.dispose();
    }).not.toThrow();
  });
});
