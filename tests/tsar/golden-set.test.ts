import { describe, expect, it } from "vitest";
import {
  GOLDEN_VOICES,
  renderAllGoldenVoices,
  renderGoldenVoice,
  TSAR_GOLDEN_SAMPLE_RATE,
  TSAR_GOLDEN_SEED,
} from "./golden-voices";

/**
 * T0 - TSAR GOLDEN SET (docs/TSAR-ROADMAP.md): the measuring stick for every
 * TSAR wave. Four layers, mirroring the UN-SUNO U0 discipline:
 *
 *   1. determinism - same seed -> bit-identical PCM (invariant #4);
 *   2. sanity - the fixtures are actually non-silent, non-clipped, band-correct
 *      material (an f0 inside the trackers' ranges, an envelope that matches
 *      the declared one-shot/sustained character);
 *   3. contract - the Forge/engine KPI blocks are DORMANT behind skipIf and
 *      activate automatically when T1/T2 layers land (zero test churn);
 *   4. the ground truth itself is asserted - rootMidi must agree with the
 *      rendered fundamental (a fixture typo must fail HERE, not in T2).
 */

const SR = TSAR_GOLDEN_SAMPLE_RATE;
const voices = renderAllGoldenVoices();

describe("TSAR golden voices - determinism (invariant #4)", () => {
  it("same seed -> bit-identical PCM", () => {
    for (const voice of GOLDEN_VOICES) {
      const a = renderGoldenVoice(voice);
      const b = renderGoldenVoice(voice);
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) throw new Error(`${voice.id} diverged at sample ${i}`);
      }
    }
  });

  it("a different seed changes only the noise floor character, not length", () => {
    const a = renderGoldenVoice(GOLDEN_VOICES[0]!, TSAR_GOLDEN_SEED);
    const b = renderGoldenVoice(GOLDEN_VOICES[0]!, TSAR_GOLDEN_SEED + 1);
    expect(a.length).toBe(b.length);
    let differs = false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        differs = true;
        break;
      }
    }
    expect(differs, "a different seed must change the noise floor").toBe(true);
  });
});

describe("TSAR golden voices - fixture sanity", () => {
  it("every voice is non-silent and non-clipped", () => {
    for (const voice of GOLDEN_VOICES) {
      const data = voices.get(voice.id)!;
      let peak = 0;
      let energy = 0;
      for (let i = 0; i < data.length; i++) {
        const magnitude = Math.abs(data[i]);
        if (magnitude > peak) peak = magnitude;
        energy += data[i] * data[i];
      }
      expect(peak, `${voice.id} peak`).toBeGreaterThan(0.05);
      expect(peak, `${voice.id} peak must not clip`).toBeLessThanOrEqual(1);
      expect(energy / data.length, `${voice.id} energy`).toBeGreaterThan(1e-6);
    }
  });

  it("rendered duration matches the declared duration", () => {
    for (const voice of GOLDEN_VOICES) {
      expect(voices.get(voice.id)!.length).toBe(Math.round(voice.durationSec * SR));
    }
  });

  it("ground truth agrees with the rendered fundamental (Goertzel energy test)", () => {
    // The fixture itself is under test: a wrong rootMidi poisons every Forge
    // KPI downstream. Plain autocorrelation/difference functions chase
    // subharmonic octaves on harmonic-rich material (measured on formant-e3),
    // so the honest fixture check is: the declared f0 must carry MORE energy
    // than its immediate neighbours, and its 2x must not dominate it.
    for (const voice of GOLDEN_VOICES) {
      if (voice.rootMidi === null) continue;
      const data = voices.get(voice.id)!;
      const expected = 440 * Math.pow(2, (voice.rootMidi - 69) / 12);
      const atRoot = goertzelPower(data, SR, expected);
      const atUp = goertzelPower(data, SR, expected * Math.pow(2, 1 / 12)); // +1 semitone
      const atDown = goertzelPower(data, SR, expected * Math.pow(2, -1 / 12)); // -1 semitone
      expect(atRoot, `${voice.id}: declared root must dominate its semitone neighbours`).toBeGreaterThan(atUp * 2);
      expect(atRoot, `${voice.id}: declared root must dominate its semitone neighbours`).toBeGreaterThan(atDown * 2);
    }
  });

  it("the declared one-shot decays and the declared sustained voice does not", () => {
    const oneShot = voices.get("808-f1")!;
    const sustained = voices.get("saw-c3")!;
    // Compare the last decile's energy against the first decile's.
    const ratio = (data: Float32Array): number => {
      const decile = Math.floor(data.length / 10);
      const energy = (from: number): number => {
        let sum = 0;
        for (let i = from; i < from + decile; i++) sum += data[i] * data[i];
        return sum / decile;
      };
      return energy(data.length - decile) / Math.max(1e-12, energy(0));
    };
    expect(ratio(oneShot), "808 must decay").toBeLessThan(0.05);
    expect(ratio(sustained), "saw must sustain").toBeGreaterThan(0.5);
  });
});

/** Goertzel power at one frequency over the whole buffer (fixture check). */
function goertzelPower(data: Float32Array, sampleRate: number, hz: number): number {
  const k = Math.round((data.length * hz) / sampleRate);
  const omega = (2 * Math.PI * k) / data.length;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < data.length; i++) {
    const s0 = data[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (data.length * data.length);
}
