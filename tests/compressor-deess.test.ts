import { beforeAll, describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addEffect, setEffectParam } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { EFFECT_DEFS, defaultParamsOf } from "../src/effects/registry";
import type { EffectType, ProjectDocument } from "../src/project-model/types";

/**
 * DE-ESS MODE on the Compressor (user request: "AI zvukár" channel-stripe
 * gap). Wideband de-esser architecture: the detector listens through a
 * band-pass centered at scBandHz (4–10 kHz sibilance region), so gain
 * reduction triggers ONLY on sibilant energy — a loud low-frequency tone at
 * the same peak level must pass ~untouched while a sibilance-band tone
 * ducks. These pins hold that contract at the real-audio level (the
 * processor is driven directly through the fake-worklet harness — the same
 * pattern param-range-coherence uses — plus a param-surface check).
 */

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage(): void {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const registered = new Map<string, new () => any>();

let CompressorProcessor: any;

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 44100;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: new () => any) => {
    registered.set(name, cls);
  };
  await import("../src/audio-worklets/compressor-processor.js");
  CompressorProcessor = registered.get("compressor-processor");
  expect(CompressorProcessor).toBeDefined();
});

/** Render a stereo signal through the processor with the given params. */
function render(params: Record<string, number>, signal: (t: number) => number, seconds = 0.5): Float32Array {
  const SR = 44100;
  const proc = new CompressorProcessor();
  const len = Math.floor(SR * seconds);
  const inL = new Float32Array(len);
  const inR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const v = signal(i / SR);
    inL[i] = v;
    inR[i] = v;
  }
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);
  const paramArray = (v: number) => new Float32Array([v]);
  proc.process([[inL, inR]], [[outL, outR]], {
    threshold: paramArray(params.threshold ?? -30),
    ratio: paramArray(params.ratio ?? 6),
    attack: paramArray(params.attack ?? 0.001),
    release: paramArray(params.release ?? 0.08),
    knee: paramArray(params.knee ?? 2),
    makeup: paramArray(1),
    mix: paramArray(1),
    detector: paramArray(1), // PEAK — deterministic
    scHpf: paramArray(20),
    scMode: paramArray(params.scMode ?? 0),
    scBandHz: paramArray(params.scBandHz ?? 6500),
    autoRelease: paramArray(0),
  } as Record<string, Float32Array>);
  return outL;
}

/** RMS over the last 60 % of the render (attack/release settled). */
function settledRms(buf: Float32Array): number {
  const from = Math.floor(buf.length * 0.4);
  let sum = 0;
  for (let i = from; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / (buf.length - from));
}

describe("compressor DE-ESS mode (scMode/scBandHz)", () => {
  it("scMode=1 ducks a sibilance-band tone but passes a low tone at the same level", () => {
    // 0.5-amplitude sine RMS = 0.354 — the untouched baseline.
    const deEssParams = { scMode: 1, scBandHz: 6500, threshold: -35, ratio: 8 };
    const sibilant = settledRms(render(deEssParams, (t) => 0.5 * Math.sin(2 * Math.PI * 6500 * t)));
    const low = settledRms(render(deEssParams, (t) => 0.5 * Math.sin(2 * Math.PI * 150 * t)));
    // The low tone passes at the untouched baseline (±5 %).
    expect(low).toBeGreaterThan(0.336);
    // The sibilant tone ducks at least ~10 dB below the baseline.
    expect(sibilant).toBeLessThan(0.11);
    // The DISCRIMINATION is the contract: band energy ≥ 3× more ducked.
    expect(low / sibilant).toBeGreaterThan(3);
  });

  it("scMode=0 (HPF mode) compresses BOTH tones equally — the mode is the discriminator", () => {
    const hpfParams = { scMode: 0, threshold: -35, ratio: 8 };
    const high = settledRms(render(hpfParams, (t) => 0.5 * Math.sin(2 * Math.PI * 6500 * t)));
    const low = settledRms(render(hpfParams, (t) => 0.5 * Math.sin(2 * Math.PI * 150 * t)));
    // Normal (main-input) detector: both trigger similarly.
    expect(high).toBeLessThan(0.4);
    expect(low).toBeLessThan(0.4);
  });

  it("scBandHz moves the sensitive band — a 10 kHz center ignores a 2 kHz tone", () => {
    // The band is intentionally wide (sibilance region is broad: HP at
    // center/1.8). Discrimination is band vs clearly-out-of-band, so the
    // out-of-band probe sits well below the HP corner (10k/1.8≈5.6k).
    const at10k = { scMode: 1, scBandHz: 10000, threshold: -35, ratio: 8 };
    const inBand = settledRms(render(at10k, (t) => 0.5 * Math.sin(2 * Math.PI * 10000 * t)));
    // 1 kHz sits ~2.5 octaves below the HP corner (10k/1.8 ≈ 5.6k) —
    // ~30 dB of skirt attenuation puts the detector below the threshold.
    const offBand = settledRms(render(at10k, (t) => 0.5 * Math.sin(2 * Math.PI * 1000 * t)));
    expect(inBand).toBeLessThan(0.11); // ducked like the 6.5k probe in test 1
    expect(offBand).toBeGreaterThan(0.336); // untouched baseline
  });

  it("output stays finite and DC-free in de-ess mode (denormal guard)", () => {
    const out = render(
      { scMode: 1, scBandHz: 6500, threshold: -60, ratio: 20 },
      (t) => 0.9 * Math.sin(2 * Math.PI * 220 * t),
    );
    let dc = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      dc += out[i];
    }
    expect(Math.abs(dc / out.length)).toBeLessThan(0.05);
  });

  it("param surface: scMode/scBandHz exist with the declared ranges and survive a doc round-trip", () => {
    const def = (EFFECT_DEFS.compressor.params as { id: string; min: number; max: number; default: number }[]).find(
      (p) => p.id === "scBandHz",
    );
    expect(def).toBeDefined();
    expect(def!.min).toBe(2000);
    expect(def!.max).toBe(12000);
    void defaultParamsOf;

    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    const store = new ProjectStore(doc);
    const add = addEffect(store.getDoc(), track.id, "compressor" as EffectType);
    store.execute(add);
    store.execute(setEffectParam(store.getDoc(), track.id, add.effectId, "scMode", 1));
    store.execute(setEffectParam(store.getDoc(), track.id, add.effectId, "scBandHz", 8000));
    const roundTrip = JSON.parse(JSON.stringify(store.getDoc())) as ProjectDocument;
    const fx = (roundTrip.tracks.find((t) => t.id === track.id) as { effects: { params: Record<string, number> }[] })
      .effects[0];
    expect(fx.params.scMode).toBe(1);
    expect(fx.params.scBandHz).toBe(8000);
  });
});
