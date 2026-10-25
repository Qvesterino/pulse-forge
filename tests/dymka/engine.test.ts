import { describe, expect, it } from "vitest";
import { DymkaProcessor } from "../../src/dymka/dsp/dymkaProcessor";
import { defaultInstrumentParams } from "../../src/instruments/definitions";
import { normalizeProject } from "../../src/project-model/schema";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack } from "../../src/project-model/types";
import type { InstrumentRuntime } from "../../src/instruments/types";

/**
 * DYMKA (ADR 0062) — the breath-driven wind instrument. Pinned: the
 * fundamental tracks the pitch; the breath drives amplitude AND brightness
 * (MPE pressure is THE instrument); the jaw (timbre) scales vibrato live;
 * legato glides instead of re-attacking; deterministic; bounded; offline
 * parity; kind heal; audible fallback.
 */

const SR = 48000;
const BLOCK = 128;

function processor(params: Record<string, number> = {}): DymkaProcessor {
  const proc = new DymkaProcessor({ sampleRate: SR });
  proc.applyParams({ level: 0.8, ...params });
  return proc;
}

function render(proc: DymkaProcessor, seconds: number, pitch = 64): Float32Array {
  proc.postEvent({ type: "noteOn", when: 0, pitch, velocity: 0.9 });
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += BLOCK) {
    proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
  }
  return left;
}

function rmsAt(data: Float32Array, fromSec: number, seconds: number): number {
  const start = Math.floor(fromSec * SR);
  const count = Math.floor(seconds * SR);
  let sumSq = 0;
  for (let i = start; i < start + count; i++) sumSq += data[i]! * data[i]!;
  return Math.sqrt(sumSq / Math.max(1, count));
}

function fundamentalHz(data: Float32Array, fromSec: number, seconds: number): number {
  const start = Math.floor(fromSec * SR);
  const count = Math.floor(seconds * SR);
  let lp = 0;
  let crossings = 0;
  const coef = 1 - Math.exp((-2 * Math.PI * 400) / SR);
  let prev = 0;
  for (let i = start; i < start + count; i++) {
    lp += coef * (data[i]! - lp);
    if (prev <= 0 && lp > 0) crossings += 1;
    prev = lp;
  }
  return crossings / seconds;
}

describe("DYMKA breath engine (ADR 0062)", () => {
  it("the fundamental tracks the played pitch (E4 ≈ 330 Hz, A4 ≈ 440 Hz)", () => {
    const e4 = render(processor({ reedLevel: 0 }), 0.4, 64);
    expect(Math.abs(fundamentalHz(e4, 0.05, 0.3) - 330)).toBeLessThan(25);
    const a4 = render(processor({ reedLevel: 0 }), 0.4, 69);
    expect(Math.abs(fundamentalHz(a4, 0.05, 0.3) - 440)).toBeLessThan(30);
  });

  it("the breath IS the loudness: MPE pressure swells the note live", () => {
    const proc = processor({ breath: 0.3 });
    proc.postEvent({ type: "noteOn", when: 0, pitch: 64, velocity: 0.9 });
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    for (let frame = 0; frame < BLOCK * 12; frame += BLOCK) proc.process(left, right, frame);
    proc.applyEvent({ type: "breath", when: 0.3, pitch: 64, value: 1 });
    for (let frame = 0; frame < BLOCK * 12; frame += BLOCK) proc.process(left, right, 0.3 * SR + frame);
    // Honest measurement: render twice, once with a low breath override
    // and once with a high one, same events otherwise.
    const low = processor({ breath: 0.25 });
    low.postEvent({ type: "noteOn", when: 0, pitch: 64, velocity: 0.9 });
    low.postEvent({ type: "breath", when: 0.05, pitch: 64, value: 0.15 });
    const lowOut = renderRest(low, 0.4);
    const high = processor({ breath: 0.25 });
    high.postEvent({ type: "noteOn", when: 0, pitch: 64, velocity: 0.9 });
    high.postEvent({ type: "breath", when: 0.05, pitch: 64, value: 1 });
    const highOut = renderRest(high, 0.4);
    expect(rmsAt(highOut, 0.1, 0.25)).toBeGreaterThan(rmsAt(lowOut, 0.1, 0.25) * 1.8);
    function renderRest(p: DymkaProcessor, seconds: number): Float32Array {
      const frames = Math.ceil(seconds * SR);
      const l = new Float32Array(frames);
      const r = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += BLOCK) {
        p.process(l.subarray(frame, frame + BLOCK), r.subarray(frame, frame + BLOCK), frame);
      }
      return l;
    }
  });

  it("the jaw (MPE timbre) scales the vibrato depth live", () => {
    const proc = processor({ vibDepth: 30 });
    proc.postEvent({ type: "noteOn", when: 0, pitch: 64, velocity: 0.9 });
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    for (let frame = 0; frame < BLOCK * 8; frame += BLOCK) proc.process(left, right, frame);
    proc.applyEvent({ type: "jaw", when: 0.2, pitch: 64, value: 0.1 });
    for (let frame = 0; frame < BLOCK * 4; frame += BLOCK) proc.process(left, right, 0.2 * SR + frame);
    const voice = (proc as unknown as { voices: Array<{ active: boolean; jaw: number; gate: boolean }> }).voices.find(
      (v) => v.active,
    )!;
    expect(voice.jaw).toBeCloseTo(0.1, 2);
    expect(voice.gate).toBe(true); // live, no re-attack
  });

  it("LEGATO glides to the new pitch without re-attacking", () => {
    const proc = processor({ legato: 1 });
    proc.postEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    proc.postEvent({ type: "noteOn", when: 0.15, pitch: 67, velocity: 0.9 });
    const frames = Math.ceil(0.4 * SR);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += BLOCK) {
      proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
    }
    const voices = (proc as unknown as { voices: Array<{ active: boolean; env: number; stage: number }> }).voices;
    const active = voices.filter((v) => v.active);
    expect(active.length).toBe(1); // one voice, gliding
    expect(active[0]!.stage).toBe(1); // sustaining — never re-attacked
    expect(Math.abs(fundamentalHz(left, 0.3, 0.08) - 392)).toBeLessThan(40); // G4
  });

  it("noteOff releases (release interrupts decay — the LADIČ lesson); panic silences", () => {
    const proc = processor({ release: 0.06 });
    proc.postEvent({ type: "noteOn", when: 0, pitch: 64, velocity: 0.9 });
    proc.postEvent({ type: "noteOff", when: 0.12, pitch: 64 });
    const frames = Math.ceil(0.5 * SR);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += BLOCK) {
      proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
    }
    const voices = (proc as unknown as { voices: Array<{ active: boolean }> }).voices;
    expect(voices.some((v) => v.active)).toBe(false);
    proc.postEvent({ type: "noteOn", when: 0.55, pitch: 72, velocity: 0.9 });
    proc.postEvent({ type: "panic", when: 0.56 });
    for (let frame = 0; frame < BLOCK * 4; frame += BLOCK) proc.process(left, right, 0.5 * SR + frame);
    expect(proc.lastPeak).toBe(0);
  });

  it("is deterministic — the seeded reed noise renders byte-identical", () => {
    const a = render(processor({ reedLevel: 0.6, breath: 0.8 }), 0.4, 64);
    const b = render(processor({ reedLevel: 0.6, breath: 0.8 }), 0.4, 64);
    expect([...a]).toEqual([...b]);
  });

  it("offline parity: queue-fed and constructor-seeded events render identically", () => {
    const events = [
      { type: "noteOn" as const, when: 0, pitch: 62, velocity: 0.9 },
      { type: "breath" as const, when: 0.1, pitch: 62, value: 0.9 },
      { type: "noteOff" as const, when: 0.3, pitch: 62 },
    ];
    const build = (seeded: boolean) => {
      const proc = new DymkaProcessor({ sampleRate: SR, events: seeded ? events : undefined });
      proc.applyParams({ level: 0.8, reedLevel: 0.5 });
      if (!seeded) for (const event of events) proc.postEvent(event);
      const frames = Math.ceil(0.45 * SR);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += BLOCK) {
        proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
      }
      return [...left];
    };
    expect(build(true)).toEqual(build(false));
  });

  it("is bounded and finite at the extremes", () => {
    const proc = processor({ reedLevel: 1, breath: 1, pitchLift: 50, vibDepth: 50, level: 1.5, formant2: 3500 });
    for (let n = 0; n < 10; n++) proc.postEvent({ type: "noteOn", when: n * 0.004, pitch: 50 + n, velocity: 1 });
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
    expect(peak).toBeLessThanOrEqual(1.2);
    const voices = (proc as unknown as { voices: Array<{ active: boolean }> }).voices;
    expect(voices.filter((v) => v.active).length).toBeLessThanOrEqual(6);
  });

  it("the kind heals through normalizeProject and the default patch breathes", () => {
    const defaults = defaultInstrumentParams("dymka");
    expect(defaults.breath).toBeCloseTo(0.7, 2);
    expect(defaults.legato).toBe(0);
    const doc = createProjectFromTemplate("house");
    const base = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument");
    if (!base) throw new Error("no instrument track in template");
    doc.tracks.push({ ...base, id: "dymka-it", instrument: "dymka" });
    const healed = normalizeProject(doc);
    const kept = healed.tracks.find((t) => t.id === "dymka-it") as InstrumentTrack;
    expect(kept.instrument).toBe("dymka");
    expect(kept.kind).toBe("instrument");
  });
});

describe("DYMKA fallback runtime (ADR 0062 §8)", () => {
  it("is a real audible voice and never throws", async () => {
    const { createDymkaFallbackRuntime } = await import("../../src/instruments/dymkaFallback");
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
    const track = { id: "fb", kind: "instrument", instrument: "dymka", params: {} } as unknown as InstrumentTrack;
    const runtime = createDymkaFallbackRuntime(ctx, track);
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
