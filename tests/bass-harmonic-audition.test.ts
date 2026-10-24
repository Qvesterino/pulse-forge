import { beforeAll, describe, expect, it } from "vitest";
import { bassHarmonicParams } from "../src/effects/definitions";
import { createBassHarmonicNode } from "../src/audio-worklets/bass-harmonic-node";

/**
 * GROW (bassHarmonic) — the MONITOR-ONLY audition (wave 1 of the flagship
 * roadmap, ADR 0034 addendum 15).
 *
 * The audition answers one question honestly: "did the harmonic layer help,
 * or does it just sound louder?". So it must hold three properties, and each
 * one is measured here on the REAL processor (the worklet module is imported
 * and driven exactly like the audio thread drives it):
 *
 *   1. The auditioned path is LEVEL-MATCHED to the processed path. Without
 *      the match, "the effect sounds better" is "the effect is louder".
 *   2. The auditioned path is the RIGHT path: DRY is the input alone (no
 *      generated harmonic leaks in), HARMONICS is the generated branch alone
 *      (the dry fundamental does not leak in).
 *   3. At silence — or while the tracker holds nothing — there is NO false
 *      benefit: the match falls back to unity and the telemetry says the
 *      compared path carries no signal, so the panel cannot claim a gain.
 *
 * The switch itself is a 10 ms crossfade: a hard cut between two
 * level-matched paths is a click, and a click makes a listening test useless.
 * The click guard measures the sample-to-sample slew at the transition
 * against the signal's OWN slew in steady state.
 *
 * The last block pins the BARRIER: the audition is not a project parameter.
 * The document has no field for it, and the node wrapper refuses the id on
 * the project sync path — so a hand-edited or migrated document can never
 * push an audition into a render.
 */

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  posted: unknown[] = [];
  postMessage(message: unknown) {
    this.posted.push(message && typeof message === "object" ? { ...(message as Record<string, unknown>) } : message);
  }
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}
const registered = new Map<string, any>();
beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: new () => any) => {
    registered.set(name, cls);
  };
  await import("../src/audio-worklets/bass-harmonic-processor.js");
});

const SR = 48000;
const BLOCK = 128;

/** Deterministic noise — a fixed LCG, never Math.random (the tests must be reproducible). */
function noiseAt(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function paramsOf(cls: any, overrides: Record<string, number> = {}): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const d of cls.parameterDescriptors as { name: string; defaultValue: number }[]) {
    out[d.name] = Float32Array.from([overrides[d.name] ?? d.defaultValue]);
  }
  return out;
}

interface RenderResult {
  out: Float32Array;
  proc: any;
  frames: Record<string, unknown>[];
}

/** Render `seconds` of a mono signal through the real processor. */
function render(
  overrides: Record<string, number>,
  seconds: number,
  input: (i: number) => number,
  options?: { switchAtSec?: number; switchTo?: number },
): RenderResult {
  const cls = registered.get("bass-harmonic-processor");
  const params = paramsOf(cls, overrides);
  const proc = new cls();
  const total = Math.ceil(seconds * SR);
  const outAll = new Float32Array(total);
  for (let offset = 0; offset < total; offset += BLOCK) {
    const len = Math.min(BLOCK, total - offset);
    if (options?.switchAtSec !== undefined && offset >= options.switchAtSec * SR) {
      params.audition[0] = options.switchTo ?? 1;
    }
    const inputs = [[Float32Array.from({ length: len }, (_, i) => input(offset + i))]];
    const out = [new Float32Array(len), new Float32Array(len)];
    proc.process(inputs, [out], params);
    outAll.set(out[0]!.subarray(0, len), offset);
  }
  return { out: outAll, proc, frames: (proc.port as FakePort).posted };
}

/** RMS over a window (seconds). */
function rms(signal: Float32Array, fromSec: number, toSec: number): number {
  const from = Math.max(0, Math.floor(fromSec * SR));
  const to = Math.min(signal.length, Math.floor(toSec * SR));
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += signal[i]! * signal[i]!;
  return Math.sqrt(sum / (to - from));
}

/** The largest sample-to-sample step inside a window — a click is a step. */
function maxSlew(signal: Float32Array, fromSec: number, toSec: number): number {
  const from = Math.max(1, Math.floor(fromSec * SR));
  const to = Math.min(signal.length, Math.floor(toSec * SR));
  let max = 0;
  for (let i = from; i < to; i++) max = Math.max(max, Math.abs(signal[i]! - signal[i - 1]!));
  return max;
}

/** Goertzel magnitude at `hz` over a window (seconds). */
function goertzel(signal: Float32Array, hz: number, fromSec: number, toSec: number): number {
  const from = Math.max(0, Math.floor(fromSec * SR));
  const to = Math.min(signal.length, Math.floor(toSec * SR));
  const n = to - from;
  if (n <= 0) return 0;
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / SR);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = signal[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

const db = (ratio: number) => 20 * Math.log10(Math.max(1e-12, ratio));

/** The last telemetry frame the processor posted (null when it posted none). */
function lastFrame(res: RenderResult): Record<string, unknown> | null {
  return (res.frames.at(-1) as Record<string, unknown> | undefined) ?? null;
}

// A representative 808 bass: the fundamental with a little 2nd/3rd content.
const bassTone = (i: number) =>
  0.5 * Math.sin((2 * Math.PI * 55 * i) / SR) +
  0.12 * Math.sin((2 * Math.PI * 110 * i) / SR) +
  0.05 * Math.sin((2 * Math.PI * 330 * i) / SR);

// The processed settings a user would actually listen with.
const LISTEN = { drive: 0.9, mix: 0.6, focusHz: 90, harmonics: 0.5, subAnchor: 0.7, lowCut: 45 };

describe("GROW audition — the level-matched A/B", () => {
  it("DRY plays the input alone, at the processed path's level", () => {
    const normal = render(LISTEN, 3, bassTone);
    const dry = render({ ...LISTEN, audition: 1 }, 3, bassTone);

    // (1) LEVEL MATCH: the dry audition sits at the processed path's level.
    const rmsNormal = rms(normal.out, 2, 3);
    const rmsDry = rms(dry.out, 2, 3);
    expect(db(rmsDry / rmsNormal), "the dry audition is not level-matched to the processed path").toBeLessThan(
      1,
    );
    expect(Math.abs(db(rmsDry / rmsNormal))).toBeLessThan(1);

    // (2) IDENTITY: the dry path IS the input, scaled — no generated harmonic
    // leaks in. The best-fit gain explains the whole signal.
    const from = Math.floor(2 * SR);
    const to = Math.floor(3 * SR);
    let num = 0;
    let den = 0;
    for (let i = from; i < to; i++) {
      const x = bassTone(i);
      num += x * dry.out[i]!;
      den += x * x;
    }
    const gain = num / den;
    expect(gain, "the dry path does not look like the input at all").toBeGreaterThan(0.5);
    let residual = 0;
    for (let i = from; i < to; i++) {
      const r = dry.out[i]! - gain * bassTone(i);
      residual += r * r;
    }
    expect(Math.sqrt(residual / (to - from)) / rmsDry, "something else leaked into the dry path").toBeLessThan(0.02);
  });

  it("HARMONICS plays the generated branch alone, at the processed path's level", () => {
    const normal = render(LISTEN, 3, bassTone);
    const harm = render({ ...LISTEN, audition: 2 }, 3, bassTone);

    // (1) LEVEL MATCH — the generated stack alone is lifted to the processed
    // path's level, so the comparison is about timbre.
    const rmsNormal = rms(normal.out, 2, 3);
    const rmsHarm = rms(harm.out, 2, 3);
    expect(Math.abs(db(rmsHarm / rmsNormal)), "the harmonic audition is not level-matched").toBeLessThan(1);

    // (2) THE RIGHT PATH: the dry fundamental is gone, the generated 2nd
    // harmonic is there. A harmonic-rich input would fool a level-only check,
    // so this reads the spectrum.
    const fundNormal = goertzel(normal.out, 55, 2, 3);
    const fundHarm = goertzel(harm.out, 55, 2, 3);
    const secondHarm = goertzel(harm.out, 110, 2, 3);
    expect(fundHarm / fundNormal, "the dry fundamental leaked into the harmonic path").toBeLessThan(0.2);
    expect(secondHarm, "the generated 2nd harmonic is missing").toBeGreaterThan(fundHarm * 3);
  });

  it("at silence there is no false benefit — the match falls back to unity", () => {
    const silent = render({ ...LISTEN, audition: 1 }, 0.8, () => 0);
    expect(rms(silent.out, 0.3, 0.8)).toBeLessThan(1e-6);
    const frame = lastFrame(silent);
    expect(frame).not.toBeNull();
    // The telemetry says the compared path carries no signal, so the panel
    // cannot report a gain it did not measure.
    expect(Number(frame!.audDb)).toBeLessThanOrEqual(-60);
  });

  it("an untrackable input leaves the harmonic branch empty — no false benefit", () => {
    const noisy = render({ ...LISTEN, audition: 2 }, 1.2, (i) => 0.25 * noiseAt(i));
    const frame = lastFrame(noisy);
    expect(frame).not.toBeNull();
    expect(Number(frame!.audDb), "the panel would claim a gain on an untrackable input").toBeLessThanOrEqual(-60);
  });

  it("the switch is a crossfade, not a cut — no click at the transition", () => {
    const steady = render(LISTEN, 2.2, bassTone);
    const switched = render(LISTEN, 2.2, bassTone, { switchAtSec: 1, switchTo: 1 });

    // The signal's OWN slew in steady state — the yardstick. A click is a
    // step far larger than what the waveform itself does.
    const steadySlew = maxSlew(steady.out, 1.3, 2.1);
    expect(steadySlew).toBeGreaterThan(0);
    // The transition window: the crossfade plus the two paths' own slew.
    const switchSlew = maxSlew(switched.out, 0.99, 1.02);
    expect(switchSlew, "the audition switch clicks").toBeLessThan(steadySlew * 5);
  });

  it("the telemetry reports the mode and the match so the panel can be honest", () => {
    const dry = render({ ...LISTEN, audition: 1 }, 1.2, bassTone);
    const frame = lastFrame(dry)!;
    expect(Number(frame.audition)).toBe(1);
    // The applied match gain (dB) and the source's level relative to the
    // processed path — the panel needs both to say MATCHED vs MATCH LIMIT.
    expect(Number.isFinite(Number(frame.matchDb))).toBe(true);
    expect(Number.isFinite(Number(frame.audDb))).toBe(true);
    // Unclamped, the gain cancels the level difference exactly: the source
    // sat X dB from the reference, and the match moved it X dB back.
    expect(Math.abs(Number(frame.matchDb) + Number(frame.audDb))).toBeLessThan(0.5);
    // The clamp bounds: the match never dives more than 12 dB nor lifts more
    // than 18 dB.
    expect(Number(frame.matchDb)).toBeGreaterThan(-12.1);
    expect(Number(frame.matchDb)).toBeLessThan(18.1);
  });
});

describe("GROW audition — the barrier to project state", () => {
  it("is not a project parameter — the catalog cannot offer it", () => {
    expect(bassHarmonicParams.some((param) => param.id === "audition")).toBe(false);
  });

  it("the node wrapper refuses the id on the project sync path", () => {
    // A hand-edited or migrated document could carry `audition: 2` in
    // fx.params. The engine's bulk sync would then write it to the worklet
    // and an export would render the generated branch alone. The wrapper
    // refuses the id, so only the engine's runtime path can set it.
    class FakeWorkletNode {
      static instances: FakeWorkletNode[] = [];
      port = new FakePort();
      onprocessorerror: (() => void) | null = null;
      options: unknown;
      values: Record<string, number> = {};
      constructor(_ctx: unknown, _name: string, options: unknown) {
        this.options = options;
        for (const d of registered.get("bass-harmonic-processor").parameterDescriptors as {
          name: string;
          defaultValue: number;
        }[]) {
          this.values[d.name] = d.defaultValue;
        }
        FakeWorkletNode.instances.push(this);
      }
      get parameters() {
        return {
          get: (id: string) =>
            this.values[id] === undefined
              ? undefined
              : {
                  get value() {
                    return FakeWorkletNode.instances.at(-1)!.values[id]!;
                  },
                  set value(v: number) {
                    FakeWorkletNode.instances.at(-1)!.values[id] = v;
                  },
                  setValueAtTime: (v: number) => {
                    FakeWorkletNode.instances.at(-1)!.values[id] = v;
                  },
                },
        };
      }
      connect() {}
      disconnect() {}
    }
    (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
    const ctx = {
      createGain: () => ({ gain: { value: 1 }, connect: () => {}, disconnect: () => {} }),
      currentTime: 0,
      sampleRate: SR,
    } as unknown as BaseAudioContext;

    const runtime = createBassHarmonicNode(ctx, { params: { drive: 0.5 } });
    const node = FakeWorkletNode.instances.at(-1)!;

    // The project sync path: refused.
    runtime.setParameter("audition", 2);
    expect(node.values.audition).toBe(0);
    runtime.setParameterAt?.("audition", 1, 0);
    expect(node.values.audition).toBe(0);

    // The engine's runtime path: allowed.
    runtime.setAudition?.(2);
    expect(node.values.audition).toBe(2);
    runtime.setAudition?.(1);
    expect(node.values.audition).toBe(1);
    runtime.dispose();
  });
});
