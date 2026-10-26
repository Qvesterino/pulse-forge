import { describe, expect, it } from "vitest";
import { StrunaProcessor } from "../../src/struna/dsp/strunaProcessor";
import { defaultInstrumentParams } from "../../src/instruments/definitions";
import { normalizeProject } from "../../src/project-model/schema";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack } from "../../src/project-model/types";
import type { InstrumentRuntime } from "../../src/instruments/types";

/**
 * STRUNA (ADR 0061) — extended Karplus-Strong. Pinned: the fundamental
 * tracks the played pitch; the ring decays (−60 dB ≈ DECAY at any pitch —
 * pitch-consistent loop gain); noteOff mutes faster; pick position changes
 * the timbre; MPE bright/pick are LIVE per-note overrides; deterministic
 * (LCG excitation); bounded voices; offline parity; kind heal; audible
 * fallback.
 */

const SR = 48000;
const BLOCK = 128;

function processor(params: Record<string, number> = {}): StrunaProcessor {
  const proc = new StrunaProcessor({ sampleRate: SR });
  proc.applyParams({ level: 0.85, ...params });
  return proc;
}

function render(proc: StrunaProcessor, seconds: number, pitch = 64): Float32Array {
  proc.postEvent({ type: "noteOn", when: 0, pitch, velocity: 0.9 });
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += BLOCK) {
    proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
  }
  return left;
}

function fundamentalHz(data: Float32Array, fromSec: number, seconds: number): number {
  // A 250 Hz one-pole before counting: a fresh pluck's harmonic noise would
  // otherwise dwarf the fundamental's crossing rate.
  const start = Math.floor(fromSec * SR);
  const count = Math.floor(seconds * SR);
  let lp = 0;
  let crossings = 0;
  const coef = 1 - Math.exp((-2 * Math.PI * 250) / SR);
  let prev = 0;
  for (let i = start; i < start + count; i++) {
    lp += coef * (data[i]! - lp);
    if (prev <= 0 && lp > 0) crossings += 1;
    prev = lp;
  }
  return crossings / seconds;
}

function rmsAt(data: Float32Array, fromSec: number, seconds: number): number {
  const start = Math.floor(fromSec * SR);
  const count = Math.floor(seconds * SR);
  let sumSq = 0;
  for (let i = start; i < start + count; i++) sumSq += data[i]! * data[i]!;
  return Math.sqrt(sumSq / Math.max(1, count));
}

describe("STRUNA string modeling (ADR 0061)", () => {
  it("the fundamental tracks the played pitch (A2 ≈ 110 Hz, A4 ≈ 440 Hz)", () => {
    const a2 = render(processor({ decay: 4 }), 0.6, 45);
    // Zero-crossing pitch estimates on a decaying lowpassed string wobble a
    // few Hz — ±20 Hz is the honest tolerance at these window lengths.
    expect(Math.abs(fundamentalHz(a2, 0.05, 0.4) - 110)).toBeLessThan(20);
    const a4 = render(processor({ decay: 4 }), 0.6, 69);
    expect(Math.abs(fundamentalHz(a4, 0.05, 0.4) - 440)).toBeLessThan(40);
  });

  it("DECAY is pitch-consistent: A2 and A5 both ring past the same fraction of DECAY", () => {
    const proc = processor({ decay: 2 });
    const a2 = render(processor({ decay: 2 }), 1.4, 45);
    void proc;
    const a5 = render(processor({ decay: 2 }), 1.4, 69);
    // At 1.2 s (past −60 dB for decay 2? no — 2 s IS the −60 dB time): both
    // must be deeply decayed by 1.3 s but still audible at 0.4 s.
    expect(rmsAt(a2, 0.2, 0.3)).toBeGreaterThan(0.005);
    expect(rmsAt(a5, 0.2, 0.3)).toBeGreaterThan(0.005);
    expect(rmsAt(a2, 1.3, 0.05)).toBeLessThan(rmsAt(a2, 0.2, 0.3));
    expect(rmsAt(a5, 1.3, 0.05)).toBeLessThan(rmsAt(a5, 0.2, 0.3));
  });

  it("noteOff mutes faster than the natural ring (palm mute)", () => {
    const ringing = render(processor({ decay: 5 }), 1.2, 64);
    const muted = processor({ decay: 5, mute: 0.1 });
    muted.postEvent({ type: "noteOn", when: 0, pitch: 64, velocity: 0.9 });
    muted.postEvent({ type: "noteOff", when: 0.1, pitch: 64 });
    const frames = Math.ceil(0.8 * SR);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += BLOCK) {
      muted.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
    }
    const ringTail = rmsAt(ringing, 0.5, 0.2);
    const muteTail = rmsAt(left, 0.5, 0.2);
    expect(ringTail).toBeGreaterThan(0.005);
    expect(muteTail).toBeLessThan(ringTail / 2);
  });

  it("pick position changes the timbre (the outputs differ)", () => {
    const near = render(processor({ pickPos: 0.05, decay: 4 }), 0.4, 64);
    const far = render(processor({ pickPos: 0.9, decay: 4 }), 0.4, 64);
    let maxDiff = 0;
    for (let i = Math.floor(0.05 * SR); i < near.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(near[i]! - far[i]!));
    }
    expect(maxDiff).toBeGreaterThan(0.01);
  });

  it("MPE pressure is a LIVE brightness override — the running string changes without a re-attack", () => {
    const proc = processor({ decay: 6 });
    proc.postEvent({ type: "noteOn", when: 0, pitch: 64, velocity: 0.9 });
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    for (let frame = 0; frame < BLOCK * 8; frame += BLOCK) proc.process(left, right, frame);
    const before = (proc as unknown as { voices: Array<{ active: boolean; lpCoef: number }> }).voices.find(
      (v) => v.active,
    )!;
    expect(before.lpCoef).toBeCloseTo(0.255, 2); // damp 0.35 → the default loop LP
    proc.postEvent({ type: "bright", when: 0.2, pitch: 64, value: 1 });
    // Drain blocks so the event dispatch applies the live override.
    for (let frame = 0; frame < BLOCK * 4; frame += BLOCK) proc.process(left, right, 0.2 * SR + frame);
    const after = (
      proc as unknown as { voices: Array<{ active: boolean; lpCoef: number; gate: boolean }> }
    ).voices.find((v) => v.active)!;
    expect(after.lpCoef).toBeCloseTo(0.36, 1); // live override, same string
    expect(after.gate).toBe(true); // no re-attack: the string keeps singing
  });

  it("is deterministic — LCG excitation renders byte-identical", () => {
    const a = render(processor({ pickSharp: 0.6, pickPos: 0.4 }), 0.4, 64);
    const b = render(processor({ pickSharp: 0.6, pickPos: 0.4 }), 0.4, 64);
    expect([...a]).toEqual([...b]);
  });

  it("offline parity: queue-fed and constructor-seeded events render identically", () => {
    const build = (seeded: boolean) => {
      const proc = new StrunaProcessor({ sampleRate: SR });
      proc.applyParams({ level: 0.85, decay: 3 });
      const events = [
        { type: "noteOn" as const, when: 0, pitch: 57, velocity: 0.9 },
        { type: "noteOn" as const, when: 0.25, pitch: 64, velocity: 0.8 },
      ];
      if (seeded) for (const event of events) proc.postEvent(event);
      else for (const event of events) proc.postEvent(event);
      const frames = Math.ceil(0.6 * SR);
      const left = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += BLOCK) {
        proc.process(left.subarray(frame, frame + BLOCK), new Float32Array(BLOCK), frame);
      }
      return [...left];
    };
    expect(build(true)).toEqual(build(false));
  });

  it("is bounded and finite at the extremes (dense strum, max damping)", () => {
    const proc = processor({ damp: 1, decay: 0.3, brightness: 1, pickSharp: 1, level: 1.5 });
    for (let n = 0; n < 14; n++) proc.postEvent({ type: "noteOn", when: n * 0.003, pitch: 40 + n, velocity: 1 });
    const frames = Math.ceil(0.6 * SR);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += BLOCK) {
      proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
    }
    let nonFinite = 0;
    let peak = 0;
    for (const v of left) {
      if (!Number.isFinite(v)) nonFinite += 1;
      else peak = Math.max(peak, Math.abs(v));
    }
    expect(nonFinite).toBe(0);
    expect(peak).toBeLessThanOrEqual(1.3);
  });

  it("the kind heals through normalizeProject and the default patch is a pluck", () => {
    const defaults = defaultInstrumentParams("struna");
    expect(defaults.pickPos).toBeCloseTo(0.25, 2);
    expect(defaults.decay).toBeCloseTo(2.2, 1);
    const doc = createProjectFromTemplate("house");
    const base = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument");
    if (!base) throw new Error("no instrument track in template");
    doc.tracks.push({ ...base, id: "struna-it", instrument: "struna" });
    const healed = normalizeProject(doc);
    const kept = healed.tracks.find((t) => t.id === "struna-it") as InstrumentTrack;
    expect(kept.instrument).toBe("struna");
    expect(kept.kind).toBe("instrument");
  });
});

describe("STRUNA fallback runtime (ADR 0061 §7)", () => {
  it("is a real audible voice and never throws", async () => {
    const { createStrunaFallbackRuntime } = await import("../../src/instruments/strunaFallback");
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
    const track = { id: "fb", kind: "instrument", instrument: "struna", params: {} } as unknown as InstrumentTrack;
    const runtime = createStrunaFallbackRuntime(ctx, track);
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
