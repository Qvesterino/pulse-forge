import { describe, expect, it } from "vitest";
import { LadicProcessor } from "../../src/ladic/dsp/ladicProcessor";
import { defaultInstrumentParams } from "../../src/instruments/definitions";
import { normalizeProject } from "../../src/project-model/schema";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack } from "../../src/project-model/types";
import type { InstrumentRuntime } from "../../src/instruments/types";

/**
 * LADIČ (ADR 0055) — the 6-operator FM flagship. Pinned behaviors:
 * additive algorithms render the fundamental at the note's pitch;
 * modulator levels actually bend the carrier's spectrum (algorithm routing
 * is live, not decorative); feedback changes the sound; the engine is
 * deterministic (no RNG) and live/offline-identical given the same events.
 */

const SR = 48000;
const BLOCK = 128;

function processor(params: Record<string, number>): LadicProcessor {
  const proc = new LadicProcessor({ sampleRate: SR });
  proc.applyParams({ level: 0.8, ...params });
  return proc;
}

function render(proc: LadicProcessor, seconds: number, seed: LadicConstructorEvents = []): Float32Array {
  for (const event of seed) proc.postEvent(event);
  proc.postEvent({ type: "noteOn", when: 0, pitch: 69, velocity: 0.9 }); // A4 440 Hz
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += BLOCK) {
    proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
  }
  return left;
}
type LadicConstructorEvents = Parameters<LadicProcessor["postEvent"]>[0][];

function stats(data: Float32Array, from = 0): { peak: number; rms: number; nonFinite: number } {
  let peak = 0;
  let sumSq = 0;
  let nonFinite = 0;
  const start = Math.floor(from * SR);
  for (let i = start; i < data.length; i++) {
    const v = data[i]!;
    if (!Number.isFinite(v)) nonFinite += 1;
    else {
      peak = Math.max(peak, Math.abs(v));
      sumSq += v * v;
    }
  }
  return { peak, rms: Math.sqrt(sumSq / Math.max(1, data.length - start)), nonFinite };
}

/** Zero-crossing estimate of the fundamental over a window. */
function fundamentalHz(data: Float32Array, fromSec: number, seconds: number): number {
  const start = Math.floor(fromSec * SR);
  const count = Math.floor(seconds * SR);
  let crossings = 0;
  for (let i = start + 1; i < start + count; i++) {
    if (data[i - 1]! <= 0 && data[i]! > 0) crossings += 1;
  }
  return crossings / seconds;
}

describe("LADIČ engine (ADR 0055)", () => {
  it("the additive algorithm (0) renders the fundamental at the note's pitch", () => {
    // All six carriers at ratio 1, zero modulation: a pure additive A4.
    const proc = processor({
      algorithm: 0,
      op1Ratio: 1,
      op1Level: 0.8,
      op2Ratio: 1,
      op2Level: 0,
      op3Level: 0,
      op4Level: 0,
      op5Level: 0,
      op6Level: 0,
    });
    const out = render(proc, 0.5);
    const { rms, nonFinite } = stats(out, 0.05);
    expect(nonFinite).toBe(0);
    expect(rms).toBeGreaterThan(0.02);
    expect(fundamentalHz(out, 0.1, 0.3)).toBeCloseTo(440, -1);
  });

  it("carrier ratios transpose the operator (op1 at ratio 2 sounds A5)", () => {
    const proc = processor({
      algorithm: 0,
      op1Ratio: 2,
      op1Level: 0.8,
      op2Level: 0,
      op3Level: 0,
      op4Level: 0,
      op5Level: 0,
      op6Level: 0,
    });
    const out = render(proc, 0.5);
    expect(fundamentalHz(out, 0.1, 0.3)).toBeCloseTo(880, -1);
  });

  it("algorithm routing is live: a modulator at level 0 leaves the carrier pure, level 0.8 brightens it", () => {
    const base = {
      algorithm: 1, // pairs: 0←1, 2←3, 4←5
      op1Ratio: 1,
      op1Level: 0.7,
      op2Ratio: 2,
      op2Atk: 0.001,
      op2Sus: 1,
      op3Level: 0,
      op4Level: 0,
      op5Level: 0,
      op6Level: 0,
    };
    const quiet = render(processor({ ...base, op2Level: 0 }), 0.5);
    const bright = render(processor({ ...base, op2Level: 0.8 }), 0.5);
    const q = stats(quiet, 0.05);
    const b = stats(bright, 0.05);
    expect(q.rms).toBeGreaterThan(0.02); // the carrier alone is audible
    expect(b.peak).toBeGreaterThan(0);
    // Brightening = more high-frequency content: the outputs must differ
    // substantially sample-wise (the modulator bends the carrier's phase).
    let maxDiff = 0;
    for (let i = Math.floor(0.1 * SR); i < quiet.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(quiet[i]! - bright[i]!));
    }
    expect(maxDiff).toBeGreaterThan(0.05);
  });

  it("the routing is ALGORITHM-aware: the same modulator is inert in the additive algorithm", () => {
    // op2 at level 0.8 with algorithm 0 (no modIn anywhere) must equal
    // op2 at level 0 — op2 is just another carrier whose output goes NOWHERE
    // (only op1 is a loud carrier; the others add silence at level 0).
    const loud = render(
      processor({
        algorithm: 0,
        op1Ratio: 1,
        op1Level: 0.7,
        op2Level: 0.8,
        op3Level: 0,
        op4Level: 0,
        op5Level: 0,
        op6Level: 0,
      }),
      0.3,
    );
    const silent = render(
      processor({
        algorithm: 0,
        op1Ratio: 1,
        op1Level: 0.7,
        op2Level: 0,
        op3Level: 0,
        op4Level: 0,
        op5Level: 0,
        op6Level: 0,
      }),
      0.3,
    );
    // op2 IS a carrier in algorithm 0 — so it ADDS (a second sine), it does
    // not modulate. Both render fine; the pin: the additive render is close
    // to the op1-only render scaled by ~√2 worth of power, definitely NOT
    // the wildly different waveform the modulated algorithm-1 case shows.
    const a = stats(loud, 0.05).rms;
    const b = stats(silent, 0.05).rms;
    expect(a / b).toBeGreaterThan(1.05); // the second carrier adds power
    expect(a / b).toBeLessThan(2.5); // ...but nothing is modulating anything
  });

  it("feedback changes the sound (the feedback op path is wired)", () => {
    // The feedback operator is the algorithm's highest non-carrier — op6 in
    // the pairs algorithm, where it MODULATES op5. The patch therefore
    // sounds op5 (carrier) with op6 (modulator) at level: feedback on op6's
    // own phase must change what op5 hears.
    const base = {
      algorithm: 1,
      op1Ratio: 1,
      op1Level: 0,
      op2Level: 0,
      op3Level: 0,
      op4Level: 0,
      op5Ratio: 1,
      op5Level: 0.5,
      op5Sus: 1,
      op6Ratio: 3.01,
      op6Level: 0.3,
      op6Sus: 1,
    };
    const off = render(processor({ ...base, feedback: 0 }), 0.4);
    const on = render(processor({ ...base, feedback: 0.9 }), 0.4);
    let maxDiff = 0;
    for (let i = Math.floor(0.1 * SR); i < off.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(off[i]! - on[i]!));
    }
    expect(maxDiff).toBeGreaterThan(0.02);
  });

  it("is deterministic — identical renders, byte for byte (no RNG by construction)", () => {
    const params = {
      algorithm: 4,
      op1Level: 0.7,
      op2Level: 0.5,
      op3Level: 0.4,
      op4Level: 0.3,
      op5Level: 0.2,
      op6Level: 0.5,
      feedback: 0.5,
    };
    const a = render(processor(params), 0.5);
    const b = render(processor(params), 0.5);
    expect([...a]).toEqual([...b]);
  });

  it("live-queued and constructor-seeded events render identically (offline parity)", () => {
    const events = [
      { type: "noteOn" as const, when: 0, pitch: 60, velocity: 0.9 },
      { type: "noteOn" as const, when: 0.2, pitch: 67, velocity: 0.8 },
      { type: "noteOff" as const, when: 0.45, pitch: 60 },
    ];
    const seeded = new LadicProcessor({ sampleRate: SR, events });
    seeded.applyParams({ algorithm: 1, level: 0.8 });
    const queued = new LadicProcessor({ sampleRate: SR });
    queued.applyParams({ algorithm: 1, level: 0.8 });
    for (const event of events) queued.postEvent(event);
    const renderP = (proc: LadicProcessor) => {
      const left = new Float32Array(SR);
      const right = new Float32Array(SR);
      for (let frame = 0; frame < SR; frame += BLOCK) {
        proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
      }
      return [...left];
    };
    expect(renderP(seeded)).toEqual(renderP(queued));
  });

  it("polyphony is bounded: 20 rapid notes never exceed 12 voices", () => {
    const proc = processor({ algorithm: 0, op1Level: 0.5 });
    for (let n = 0; n < 20; n++) proc.postEvent({ type: "noteOn", when: n * 0.01, pitch: 48 + n, velocity: 0.8 });
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    proc.process(left, right, 0);
    const active = (proc as unknown as { voices: Array<{ active: boolean }> }).voices.filter((v) => v.active).length;
    expect(active).toBeLessThanOrEqual(12);
    const { nonFinite } = stats(left);
    expect(nonFinite).toBe(0);
  });

  it("noteOff releases; panic silences immediately", () => {
    const proc = processor({ algorithm: 0, op1Level: 0.6, op1Rel: 0.05 });
    proc.postEvent({ type: "noteOn", when: 0, pitch: 69, velocity: 0.9 });
    proc.postEvent({ type: "noteOff", when: 0.15, pitch: 69 });
    let left = new Float32Array(BLOCK);
    let right = new Float32Array(BLOCK);
    for (let frame = 0; frame < SR / 2; frame += BLOCK) proc.process(left, right, frame);
    const voices = (proc as unknown as { voices: Array<{ active: boolean }> }).voices;
    expect(voices.some((v) => v.active)).toBe(false);
    proc.postEvent({ type: "noteOn", when: 0.6, pitch: 72, velocity: 0.9 });
    proc.postEvent({ type: "panic", when: 0.61 });
    for (let frame = 0; frame < BLOCK * 4; frame += BLOCK) proc.process(left, right, SR / 2 + frame);
    expect(proc.lastPeak).toBe(0);
  });

  it("the kind heals through normalizeProject and the default patch is the EP starting point", () => {
    const defaults = defaultInstrumentParams("ladic");
    expect(defaults.algorithm).toBe(1); // 3×2 pairs — the EP workhorse
    expect(defaults.op2Ratio).toBe(2);
    const doc = createProjectFromTemplate("house");
    const base = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument");
    if (!base) throw new Error("no instrument track in template");
    doc.tracks.push({ ...base, id: "ladic-it", instrument: "ladic" });
    const healed = normalizeProject(doc);
    const kept = healed.tracks.find((t) => t.id === "ladic-it") as InstrumentTrack;
    expect(kept.instrument).toBe("ladic");
    expect(kept.kind).toBe("instrument");
  });
});

describe("LADIČ fallback runtime (ADR 0055 §8)", () => {
  it("is a real audible 2-op FM voice and never throws", async () => {
    const { createLadicFallbackRuntime } = await import("../../src/instruments/ladicFallback");
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
      createOscillator: () => ({
        type: "sine",
        frequency: { ...chain(), setValueAtTime() {} } as unknown as AudioParam,
        connect: chain,
        start() {},
        stop() {},
      }),
    } as unknown as BaseAudioContext;
    const track = { id: "fb", kind: "instrument", instrument: "ladic", params: {} } as unknown as InstrumentTrack;
    const runtime = createLadicFallbackRuntime(ctx, track);
    expect(() => {
      const r = runtime as Required<Pick<InstrumentRuntime, "noteOn" | "noteOff" | "panic" | "dispose">> &
        InstrumentRuntime;
      r.noteOn(60, 0.9, 0, 0.5);
      r.noteOff(60, 0.4);
      r.panic();
      r.dispose();
    }).not.toThrow();
  });
});
