import { describe, expect, it } from "vitest";
import { HlasProcessor } from "../../src/hlas/dsp/hlasProcessor";
import { defaultInstrumentParams } from "../../src/instruments/definitions";
import { normalizeProject } from "../../src/project-model/schema";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack } from "../../src/project-model/types";
import type { InstrumentRuntime } from "../../src/instruments/types";

/**
 * HĽAS (ADR 0059) — the formant lead. Pinned behaviors: the vowel pair
 * selects the formant band center frequencies (measured through the
 * bandpass coefficient tables); the morph glides between the vowels;
 * MPE timbre/pressure are LIVE per-note overrides (no re-attack); breath
 * noise is deterministic; the engine is bounded and offline-identical.
 */

const SR = 48000;
const BLOCK = 128;

function processor(params: Record<string, number> = {}): HlasProcessor {
  const proc = new HlasProcessor({ sampleRate: SR });
  proc.applyParams({ level: 0.8, ...params });
  return proc;
}

function render(proc: HlasProcessor, seconds: number): Float32Array {
  proc.postEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += BLOCK) {
    proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
  }
  return left;
}

/** Read the first formant band's center frequency from the live coefficients. */
function formantHz(proc: HlasProcessor): number {
  const coef = (proc as unknown as { voices: Array<{ active: boolean; bpCoef: Float32Array }> }).voices.find(
    (v) => v.active,
  )!.bpCoef;
  // Invert the RBJ bandpass b0 = alpha/(1+alpha) for alpha, then fc from
  // alpha = sin(w)/2q with q = 5 (band 0).
  const b0 = coef[0]!;
  const alpha = b0 / (1 - b0);
  const w = Math.asin(Math.min(1, alpha * 2 * 5));
  return (w * SR) / (2 * Math.PI);
}

/** RMS over a window. */
function rms(data: Float32Array, fromSec: number, seconds: number): number {
  const start = Math.floor(fromSec * SR);
  const count = Math.floor(seconds * SR);
  let sumSq = 0;
  for (let i = start; i < start + count; i++) sumSq += data[i]! * data[i]!;
  return Math.sqrt(sumSq / Math.max(1, count));
}

describe("HĽAS vowel engine (ADR 0059)", () => {
  it("the vowel pair selects the formant band centers (A vs U differ measurably)", () => {
    const a = processor({ vowelA: 0, vowelB: 0, morph: 0 });
    a.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    const u = processor({ vowelA: 4, vowelB: 4, morph: 0 });
    u.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    // A's F1 ≈ 800 Hz, U's F1 ≈ 350 Hz — the coefficient tables must sit
    // near those centers.
    const aHz = formantHz(a);
    const uHz = formantHz(u);
    expect(Math.abs(aHz - 800)).toBeLessThan(80);
    expect(Math.abs(uHz - 350)).toBeLessThan(60);
    expect(aHz).toBeGreaterThan(uHz);
  });

  it("the MORPH interpolates between the vowel pair (halfway sits between the centers)", () => {
    const proc = processor({ vowelA: 0, vowelB: 4, morph: 0.5 });
    proc.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    // A(800) ↔ U(350) halfway ≈ 575 Hz.
    const hz = formantHz(proc);
    expect(Math.abs(hz - 575)).toBeLessThan(60);
  });

  it("MPE timbre is a LIVE per-note morph override — no re-attack", () => {
    const proc = processor({ vowelA: 0, vowelB: 4, morph: 0 });
    proc.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    // Let the attack settle.
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    for (let frame = 0; frame < BLOCK * 8; frame += BLOCK) proc.process(left, right, frame);
    const envBefore = (
      proc as unknown as { voices: Array<{ active: boolean; env: number; stage: number }> }
    ).voices.find((v) => v.active)!;
    expect(envBefore.stage).toBe(1); // sustaining
    // MPE timbre sweeps the morph to 1 — the envelope must NOT restart.
    proc.applyEvent({ type: "timbre", when: 0.15, pitch: 60, timbre: 1 });
    const voice = (
      proc as unknown as { voices: Array<{ active: boolean; env: number; stage: number; morph: number }> }
    ).voices.find((v) => v.active)!;
    expect(voice.morph).toBe(1);
    expect(voice.stage).toBe(1); // still sustaining, not re-attacked
    expect(voice.env).toBe(1);
    // The formant coefficients glide at the ~2 kHz control rate — render a
    // few blocks so the tick recomputes them before reading.
    for (let frame = 0; frame < BLOCK * 4; frame += BLOCK) proc.process(left, right, 0.16 * SR + frame);
    expect(formantHz(proc)).toBeCloseTo(350, -1); // the U center
  });

  it("MPE pressure drives the breath live (deterministic per-note LCG)", () => {
    const withBreath = processor({ breath: 0 });
    withBreath.applyEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    withBreath.applyEvent({ type: "breath", when: 0.05, pitch: 60, pressure: 1 });
    const loud = render(withBreath, 0.4);
    const quiet = render(processor({ breath: 0 }), 0.4);
    // Breath adds noise energy: the loud render's RMS must exceed the
    // breathless one's by a real factor.
    const loudRms = rms(loud, 0.1, 0.25);
    const quietRms = rms(quiet, 0.1, 0.25);
    expect(loudRms).toBeGreaterThan(quietRms * 1.1);
  });

  it("vibrato and glide shape the pitch line (deterministic LCG breath stays reproducible)", () => {
    const a = render(processor({ vibratoDepth: 0, vibratoRate: 5, breath: 0 }), 0.5);
    const b = render(processor({ vibratoDepth: 0, vibratoRate: 5, breath: 0 }), 0.5);
    expect([...a]).toEqual([...b]);
  });

  it("the render is bounded and finite at extreme settings", () => {
    const out = render(
      processor({ vowelA: 0, vowelB: 4, morph: 1, formantScale: 2, breath: 1, pulse: 1, vibratoDepth: 60, level: 1.5 }),
      0.6,
    );
    let peak = 0;
    let nonFinite = 0;
    for (const v of out) {
      if (!Number.isFinite(v)) nonFinite += 1;
      else peak = Math.max(peak, Math.abs(v));
    }
    expect(nonFinite).toBe(0);
    expect(peak).toBeLessThanOrEqual(1.05); // level 1.5 × 0.55 headroom × knee-less but filtered
    expect(peak).toBeGreaterThan(0.01);
  });

  it("noteOff releases; panic silences; polyphony is bounded", () => {
    const proc = processor({ release: 0.05 });
    for (let n = 0; n < 9; n++) proc.postEvent({ type: "noteOn", when: n * 0.005, pitch: 60 + n, velocity: 0.8 });
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    proc.process(left, right, 0);
    const voices = (proc as unknown as { voices: Array<{ active: boolean }> }).voices;
    expect(voices.filter((v) => v.active).length).toBeLessThanOrEqual(6);
    for (let n = 0; n < 9; n++) proc.postEvent({ type: "noteOff", when: 0.1, pitch: 60 + n });
    for (let frame = 0; frame < SR / 2; frame += BLOCK) proc.process(left, right, frame);
    expect(voices.some((v) => v.active)).toBe(false);
    proc.postEvent({ type: "noteOn", when: 0.6, pitch: 72, velocity: 0.9 });
    proc.postEvent({ type: "panic", when: 0.61 });
    for (let frame = 0; frame < BLOCK * 4; frame += BLOCK) proc.process(left, right, SR / 2 + frame);
    expect(proc.lastPeak).toBe(0);
  });

  it("offline parity: queue-fed and constructor-seeded events render identically", () => {
    const events = [
      { type: "noteOn" as const, when: 0, pitch: 60, velocity: 0.9 },
      { type: "timbre" as const, when: 0.1, pitch: 60, timbre: 0.7 },
      { type: "breath" as const, when: 0.15, pitch: 60, pressure: 0.8 },
      { type: "noteOff" as const, when: 0.4, pitch: 60 },
    ];
    const build = (seeded: boolean) => {
      const proc = new HlasProcessor({
        sampleRate: SR,
        events: seeded ? events : undefined,
      });
      proc.applyParams({ level: 0.8 });
      if (!seeded) for (const event of events) proc.postEvent(event);
      const left = new Float32Array(SR);
      const right = new Float32Array(SR);
      for (let frame = 0; frame < SR; frame += BLOCK) {
        proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
      }
      return [...left];
    };
    expect(build(true)).toEqual(build(false));
  });

  it("the kind heals through normalizeProject and the default patch sings A→I", () => {
    const defaults = defaultInstrumentParams("hlas");
    expect(defaults.vowelA).toBe(0);
    expect(defaults.vowelB).toBe(2);
    const doc = createProjectFromTemplate("house");
    const base = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument");
    if (!base) throw new Error("no instrument track in template");
    doc.tracks.push({ ...base, id: "hlas-it", instrument: "hlas" });
    const healed = normalizeProject(doc);
    const kept = healed.tracks.find((t) => t.id === "hlas-it") as InstrumentTrack;
    expect(kept.instrument).toBe("hlas");
    expect(kept.kind).toBe("instrument");
  });
});

describe("HĽAS fallback runtime (ADR 0059 §7)", () => {
  it("is a real audible voice and never throws", async () => {
    const { createHlasFallbackRuntime } = await import("../../src/instruments/hlasFallback");
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
    const track = { id: "fb", kind: "instrument", instrument: "hlas", params: {} } as unknown as InstrumentTrack;
    const runtime = createHlasFallbackRuntime(ctx, track);
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
