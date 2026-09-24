import { describe, expect, it } from "vitest";
import { parseKey } from "../src/project-model/scales";
import { buildVocalProfile, extractPhrases, frameRms, perBarEnergy } from "../src/vocal/analyze";

/**
 * V1 VOCAL PROFILE — the engine hears key/tempo/energy/phrases in a take.
 *
 * All fixtures are synthesized (no audio files): sines for key, click
 * trains for tempo, loud/silent bar blocks for phrasing. Silence must
 * resolve to measured:false, never to a hallucinated key.
 */

const SR = 16000;

function sine(freq: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function mix(signals: Float32Array[]): Float32Array {
  const longest = Math.max(...signals.map((s) => s.length));
  const out = new Float32Array(longest);
  for (const s of signals) for (let i = 0; i < s.length; i++) out[i] += s[i];
  let peak = 0.001;
  for (let i = 0; i < out.length; i++) {
    const v = Math.abs(out[i]);
    if (v > peak) peak = v;
  }
  if (peak > 0.95) for (let i = 0; i < out.length; i++) out[i] *= 0.95 / peak;
  return out;
}

function clicks(bpm: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  const period = Math.floor((60 / bpm) * SR);
  for (let i = 0; i < out.length; i += period) out[i] = 1;
  return out;
}

describe("frameRms / perBarEnergy / extractPhrases (pure DSP)", () => {
  it("rms of silence is 0, of a sine is amplitude/sqrt(2)", () => {
    expect(frameRms(new Float32Array(1024), 0, 1024)).toBe(0);
    expect(frameRms(sine(440, 1, 0.5), 0, SR)).toBeCloseTo(0.5 / Math.sqrt(2), 2);
  });

  it("true silence splits, an audible gap bridges", () => {
    // bar 2 is silent (0.05) → split; bar 4 is quiet-but-singing (0.3) → bridge.
    const curve = [0.9, 0.85, 0.05, 0.8, 0.3, 0.9];
    const phrases = extractPhrases(curve);
    expect(phrases).toEqual([
      { startBar: 0, endBar: 1, peakEnergy: 0.9 },
      { startBar: 3, endBar: 5, peakEnergy: 0.9 },
    ]);
  });

  it("per-bar energy normalizes by the take maximum", () => {
    const loud = sine(440, 4, 0.5);
    const quiet = sine(440, 4, 0.1);
    const take = new Float32Array(8 * SR);
    take.set(loud, 0);
    take.set(quiet, 4 * SR);
    // 120 bpm → 2 s bars → [loud, loud, quiet, quiet]
    const curve = perBarEnergy(take, SR, 120, 4);
    expect(curve[0]).toBeCloseTo(1, 2);
    expect(curve[1]).toBeCloseTo(1, 2);
    expect(curve[2]).toBeCloseTo(0.2, 1);
    expect(curve[3]).toBeCloseTo(0.2, 1);
  });
});

describe("buildVocalProfile (key / tempo / honesty gates)", () => {
  it("hears A in a 440 Hz sine (root confident, mode honestly ambiguous)", () => {
    const profile = buildVocalProfile({ pcm: sine(440, 3), sampleRate: SR, bpm: 120 });
    expect(profile.measured).toBe(true);
    expect(profile.keyMeasured).toBe(true);
    const parsed = parseKey(profile.key!);
    expect(parsed).not.toBeNull();
    expect(parsed!.root).toBe(9); // A
  });

  it("hears C Major in a triad drone", () => {
    const drone = mix([sine(261.63, 4, 0.3), sine(329.63, 4, 0.3), sine(392.0, 4, 0.3)]);
    const profile = buildVocalProfile({ pcm: drone, sampleRate: SR, bpm: 120 });
    expect(profile.keyMeasured).toBe(true);
    expect(profile.key).toBe("C Major");
  });

  it("hears ~120 BPM in a click train (estimator resolution ±2 on clean material)", () => {
    const profile = buildVocalProfile({ pcm: clicks(120, 8), sampleRate: SR, bpm: 120 });
    expect(profile.tempoMeasured).toBe(true);
    expect(Math.abs(profile.tempoBpm! - 120)).toBeLessThanOrEqual(2);
  });

  it("a steady sine carries no tempo (honest null, not a guess)", () => {
    const profile = buildVocalProfile({ pcm: sine(440, 8), sampleRate: SR, bpm: 120 });
    expect(profile.measured).toBe(true); // it IS signal…
    expect(profile.keyMeasured).toBe(true); // …with a key…
    expect(profile.tempoMeasured).toBe(false); // …but no pulse
    expect(profile.tempoBpm).toBeNull();
  });

  it("silence resolves to measured:false (never a hallucinated key)", () => {
    const profile = buildVocalProfile({ pcm: new Float32Array(2 * SR), sampleRate: SR, bpm: 120 });
    expect(profile.measured).toBe(false);
    expect(profile.keyMeasured).toBe(false);
    expect(profile.key).toBeNull();
    expect(profile.tempoMeasured).toBe(false);
    expect(profile.phrases).toEqual([]);
  });

  it("finds phrases across loud/silent bar blocks", () => {
    // 120 bpm → 2 s bars: sing 4, rest 2, sing 4 (20 s).
    const sing = mix([sine(440, 8, 0.4), sine(554.37, 8, 0.3)]);
    const take = new Float32Array(20 * SR);
    take.set(sing.subarray(0, 8 * SR), 0);
    take.set(sing.subarray(0, 8 * SR), 12 * SR);
    const profile = buildVocalProfile({ pcm: take, sampleRate: SR, bpm: 120 });
    expect(profile.measured).toBe(true);
    expect(profile.bars).toBe(10);
    expect(profile.phrases.length).toBe(2);
    expect(profile.phrases[0].startBar).toBe(0);
    expect(profile.phrases[0].endBar).toBe(3);
    expect(profile.phrases[1].startBar).toBe(6);
    expect(profile.phrases[1].endBar).toBe(9);
    expect(profile.silenceRatio).toBeCloseTo(0.2, 1);
  });

  it("is deterministic: same take twice → identical profile incl. hash", () => {
    const drone = mix([sine(261.63, 4, 0.3), sine(329.63, 4, 0.3)]);
    const input = { pcm: drone, sampleRate: SR, bpm: 120 };
    const a = buildVocalProfile(input);
    const b = buildVocalProfile(input);
    expect(b).toEqual(a);
    expect(a.profileHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("different content → different hash", () => {
    const a = buildVocalProfile({ pcm: sine(440, 3), sampleRate: SR, bpm: 120 });
    const b = buildVocalProfile({ pcm: sine(494, 3), sampleRate: SR, bpm: 120 });
    expect(a.profileHash).not.toBe(b.profileHash);
  });
});
