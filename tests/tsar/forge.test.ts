import { describe, expect, it } from "vitest";
import { forgePlan } from "../../src/tsar/forge";
import { goldenVoices, GOLDEN_VOICES } from "./golden-voices";

/**
 * T2 — SAMPLE FORGE (docs/TSAR-ROADMAP.md). The KPI contract:
 *  - root detection ≥ 95 % on the synthetic set;
 *  - one-shot vs sustained classification ≥ 90 %;
 *  - honesty: an unpitched source gets `rootMidi: null`, never a guess;
 *  - determinism: the same PCM gives the same plan.
 */

const SR = 44100;

describe("forgePlan — root detection (KPI ≥ 95 %)", () => {
  it("reads the declared root of every pitched golden voice", () => {
    const pitched = GOLDEN_VOICES.filter((voice) => voice.rootMidi !== null);
    let correct = 0;
    const misses: string[] = [];
    for (const voice of pitched) {
      const plan = forgePlan(goldenVoices.get(voice.id)!, SR);
      const expected = voice.rootMidi!; // filtered above
      // Stable voices must be exact (a wrong root poisons every patch).
      // The DRIFTING pad is allowed ±1 semitone: its f0 moves across ±1.5 st
      // BY DESIGN, so no single sample instant is the "true" root and the
      // detector's midpoint read is a legitimate instant reading.
      const tolerance = voice.id === "sustained-pad" ? 1 : 0;
      if (plan.rootMidi !== null && Math.abs(plan.rootMidi - expected) <= tolerance) {
        correct += 1;
      } else {
        misses.push(`${voice.id}: expected ${expected}±${tolerance}, got ${plan.rootMidi}`);
      }
    }
    const accuracy = correct / pitched.length;
    expect(accuracy, `misses: ${misses.join(" | ")}`).toBeGreaterThanOrEqual(0.95);
  });

  it("an unpitched noise source reports rootMidi null with a warning (never a guess)", () => {
    const noise = goldenVoices.get("noise-burst")!;
    const plan = forgePlan(noise, SR);
    expect(plan.rootMidi).toBeNull();
    expect(plan.rootConfidence).toBe(0);
    expect(plan.warnings.join(" ")).toMatch(/set ROOT manually/);
  });

  it("determinism: the same PCM produces the same plan", () => {
    const pcm = goldenVoices.get("saw-c3")!;
    expect(forgePlan(pcm, SR)).toEqual(forgePlan(pcm, SR));
  });
});

describe("forgePlan — one-shot vs sustained (KPI ≥ 90 %)", () => {
  it("classifies the golden set at or above the KPI", () => {
    let correct = 0;
    const misses: string[] = [];
    for (const voice of GOLDEN_VOICES) {
      const plan = forgePlan(goldenVoices.get(voice.id)!, SR);
      const expected = voice.kind === "one-shot";
      const actual = plan.kind === "one-shot";
      if (expected === actual) correct += 1;
      else misses.push(`${voice.id}: expected ${voice.kind}, got ${plan.kind}`);
    }
    const accuracy = correct / GOLDEN_VOICES.length;
    expect(accuracy, `misses: ${misses.join(" | ")}`).toBeGreaterThanOrEqual(0.9);
  });

  it("the 808 decays to one-shot and the pad sustains", () => {
    expect(forgePlan(goldenVoices.get("808-f1")!, SR).kind).toBe("one-shot");
    expect(forgePlan(goldenVoices.get("sustained-pad")!, SR).kind).toBe("sustained");
  });
});

describe("forgePlan — engine routing", () => {
  it("routes short decaying material to the sampler", () => {
    const plan = forgePlan(goldenVoices.get("808-f1")!, SR);
    expect(plan.engine).toBe("sampler");
    expect(plan.loop).toBe(false);
  });

  it("routes stable sustained material to the wavetable", () => {
    const plan = forgePlan(goldenVoices.get("sine-a1")!, SR);
    expect(plan.kind).toBe("sustained");
    expect(plan.engine).toBe("wavetable");
    expect(plan.loop).toBe(true);
  });

  it("routes a long drifting texture to the granular engine", () => {
    // Build a drifting source: a slow glide across a whole tone.
    const seconds = 6;
    const pcm = new Float32Array(seconds * SR);
    for (let i = 0; i < pcm.length; i++) {
      const t = i / SR;
      const f0 = 146.83 * Math.pow(2, (Math.sin(t * 0.7) * 1.2) / 12);
      pcm[i] = 0.5 * Math.sin(2 * Math.PI * f0 * t);
    }
    const plan = forgePlan(pcm, SR);
    expect(plan.kind).toBe("sustained");
    expect(plan.engine).toBe("granular");
  });

  it("every plan explains itself with reasons and never silently guesses", () => {
    for (const voice of GOLDEN_VOICES) {
      const plan = forgePlan(goldenVoices.get(voice.id)!, SR);
      expect(plan.reasons.length, `${voice.id} must carry evidence`).toBeGreaterThan(1);
      if (plan.rootMidi === null) {
        expect(plan.warnings.length, `${voice.id}: a missing root must be warned`).toBeGreaterThan(0);
      }
    }
  });
});

describe("forgePlan — honesty and degenerates", () => {
  it("silence is kind empty with a warning, not a default patch", () => {
    const plan = forgePlan(new Float32Array(SR), SR);
    expect(plan.kind).toBe("empty");
    expect(plan.rootMidi).toBeNull();
    expect(plan.warnings.join(" ")).toMatch(/silent/);
  });

  it("empty input does not throw", () => {
    expect(() => forgePlan(new Float32Array(0), SR)).not.toThrow();
    expect(forgePlan(new Float32Array(0), SR).kind).toBe("empty");
  });

  it("peak normalization is the reciprocal of the measured peak", () => {
    const pcm = goldenVoices.get("saw-c3")!;
    const plan = forgePlan(pcm, SR);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
    expect(plan.peakNormalize).toBeCloseTo(1 / peak, 3);
  });
});
