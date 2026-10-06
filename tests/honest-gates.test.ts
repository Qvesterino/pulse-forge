import { describe, expect, it } from "vitest";
import { estimateKey, estimateTempo } from "../src/ai/audio-tempo-key";
import { computeOnsetEnvelopes, ONSET_CREST_FLOOR, onsetEnvelopeCrest } from "../src/reference/dsp/spectralFlux";
import { analyzeRhythm } from "../src/reference/analysis/rhythm";
import { analyzeSectionMix } from "../src/analysis/sectionMixDoctor";
import { levelMatchGainsDb } from "../src/analysis/levelMatch";
import { planVocalComp } from "../src/vocal/comping";
import type { VocalProfile } from "../src/vocal/types";

/**
 * HONEST-GATE SWEEP (2026-10-06) — the confidence-metric audit found two
 * estimators promoting stationary input into confident phantom readings:
 *
 *   - analyzeRhythm (F1 lane) reported "86 BPM @ 0.585, no warning" on a
 *     bare sine and "126 BPM @ 0.640" on pink noise — its confidence mix is
 *     dominated by the self-normalized candidate score;
 *   - estimateKey fabricated a key on any noise color (chroma flat, margin
 *     meaningless — real boombap scores margin 0.025, pink noise 0.235).
 *
 * These specs pin the ABSOLUTE floors that make the null paths honest.
 * Every threshold is measured, not guessed — values in the probe comments.
 */

const SR = 22050;

function sine(freq: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function noise(seconds: number, amplitude = 0.3): Float32Array {
  let s = 12345;
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amplitude * ((s / 0x7fffffff) * 2 - 1);
  }
  return out;
}

function pinkNoise(seconds: number, amplitude = 0.3): Float32Array {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let s = 987654321;
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const white = s / 0x3fffffff - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    out[i] = amplitude * Math.max(-1, Math.min(1, (b0 + b1 + b2 + white * 0.1848) * 0.3));
  }
  return out;
}

function clickTrack(bpm: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  const period = Math.floor((60 / bpm) * SR);
  for (let i = 0; i < out.length; i += period) {
    for (let j = 0; j < 40 && i + j < out.length; j++) out[i + j] = 0.9 * (1 - j / 40);
  }
  return out;
}

const RHYTHM_INPUT = {
  sampleRate: SR,
  fftSize: 2048,
  hopSize: 512,
  tempoMin: 50,
  tempoMax: 220,
} as const;

describe("onsetEnvelopeCrest (the shared honesty floor)", () => {
  it("is 0 on empty and all-zero envelopes, positive on real wobble", () => {
    expect(onsetEnvelopeCrest(new Float32Array(0))).toBe(0);
    expect(onsetEnvelopeCrest(new Float32Array(64))).toBe(0);
    const env = new Float32Array(100);
    for (let i = 0; i < 100; i++) env[i] = 1 + (i % 2);
    expect(onsetEnvelopeCrest(env)).toBeCloseTo(4 / 3, 5);
  });

  it("keeps the measured separation: stationary ≤ 6, rhythmic ≥ 36, floor 8", () => {
    // Raw combined flux envelopes, hop 256 @ 22050 (the 10-06 probe numbers).
    const crestOf = (pcm: Float32Array) => onsetEnvelopeCrest(computeOnsetEnvelopes(pcm, SR, 2048, 256).combined);
    expect(crestOf(sine(440, 8))).toBeLessThan(6);
    expect(crestOf(noise(8))).toBeLessThan(6);
    expect(crestOf(pinkNoise(8))).toBeLessThan(6);
    // A click train clears the floor by ≥ 4×.
    expect(crestOf(clickTrack(120, 8))).toBeGreaterThan(4 * ONSET_CREST_FLOOR);
  });
});

describe("analyzeRhythm — stationary input stays null (docstring contract)", () => {
  it("a sustained sine has no tempo: null BPM + warning, never a phantom pulse", () => {
    const r = analyzeRhythm({ signal: sine(440, 8), durationSeconds: 8, ...RHYTHM_INPUT });
    expect(r.bpm).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.warning).toMatch(/insufficient rhythmic information/i);
  });

  it("noise of any color has no tempo", () => {
    for (const [name, pcm] of [
      ["white", noise(8)],
      ["pink", pinkNoise(8)],
    ] as const) {
      const r = analyzeRhythm({ signal: pcm, durationSeconds: 8, ...RHYTHM_INPUT });
      expect(r.bpm, `${name} noise invented a tempo`).toBeNull();
    }
  });

  it("rhythmic material still reads: a 120 BPM click track lands within 1 BPM", () => {
    const r = analyzeRhythm({ signal: clickTrack(120, 8), durationSeconds: 8, ...RHYTHM_INPUT });
    expect(r.bpm).not.toBeNull();
    expect(Math.abs(r.bpm! - 120)).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThan(0.55);
  });
});

describe("estimateKey — tonal-evidence floors", () => {
  it("noise gets no key (flat chroma: concentration 1.76–1.90, floor 2)", () => {
    expect(estimateKey(noise(8), SR)).toBeNull();
    expect(estimateKey(pinkNoise(8), SR)).toBeNull();
  });

  it("a bare sine keeps its root (single pitch honestly resolves; mode stays ambiguous)", () => {
    const key = estimateKey(sine(440, 8), SR);
    expect(key).not.toBeNull();
    expect(key!.key.startsWith("A")).toBe(true);
  });

  it("a C4 sine still resolves to C (the vocal-profile honesty contract)", () => {
    const key = estimateKey(sine(261.63, 3, 0.3), SR);
    expect(key).not.toBeNull();
    expect(key!.key.startsWith("C")).toBe(true);
  });
});

describe("estimateTempo — crest gate holds on adversarial input", () => {
  it("stationary tones and noise carry no tempo", () => {
    expect(estimateTempo(sine(440, 8), SR)).toBeNull();
    expect(estimateTempo(pinkNoise(8), SR)).toBeNull();
  });

  it("a click train lands within tolerance", () => {
    const tempo = estimateTempo(clickTrack(120, 8), SR);
    expect(tempo).not.toBeNull();
    expect(Math.abs(tempo!.bpm - 120)).toBeLessThanOrEqual(1);
  });
});

// ── wave 2 (2026-10-06): src/vocal + src/analysis scorers ──────────────────

describe("analyzeSectionMix — DC-free measurement (wave 2)", () => {
  const SECTIONS = [
    { role: "verse", startSec: 0, endSec: 4 },
    { role: "chorus", startSec: 4, endSec: 8 },
  ];

  it("a pure DC offset fabricates NOTHING (the 120 Hz one-pole passes DC completely)", () => {
    const silentWithDc = new Float32Array(8 * SR).fill(0.3);
    expect(analyzeSectionMix([silentWithDc], SR, SECTIONS)).toEqual([]);
  });

  it("DC on real material no longer masquerades as bass density", () => {
    const music = new Float32Array(8 * SR);
    for (let i = 0; i < music.length; i++) {
      const t = i / SR;
      const pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t);
      music[i] = 0.5 * pulse * Math.sin(2 * Math.PI * 60 * t) + 0.3;
    }
    expect(analyzeSectionMix([music], SR, SECTIONS)).toEqual([]);
  });

  it("positive control: a genuinely quiet section is still found (the fix is not a mute)", () => {
    const loud = new Float32Array(4 * SR);
    for (let i = 0; i < loud.length; i++) {
      const t = i / SR;
      loud[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t);
    }
    const quiet = new Float32Array(4 * SR);
    for (let i = 0; i < quiet.length; i++) {
      const t = i / SR;
      quiet[i] = 0.03 * Math.sin(2 * Math.PI * 220 * t);
    }
    const findings = analyzeSectionMix([loud, quiet], SR, SECTIONS);
    expect(findings.some((f) => f.kind === "section-quiet" && f.section === "chorus")).toBe(true);
  });
});

describe("planVocalComp — degenerate take families stay deterministic and honest", () => {
  const SHAPE = [0.8, 0.9, 0.85, 0.7, 0.9, 0.8, 0.75, 0.85];
  const profile = (curve: number[], snrDb: number) =>
    ({
      version: 1,
      measured: true,
      key: "C Major",
      keyMeasured: true,
      keyConfidence: 0.5,
      tempoBpm: 120,
      tempoAltBpm: null,
      tempoConfidence: 0.5,
      tempoMeasured: true,
      energyCurve: curve,
      phrases: [{ startBar: 0, endBar: curve.length - 1, peakEnergy: Math.max(...curve) }],
      silenceRatio: 0,
      snrDb,
      durationSec: curve.length * 2,
      bars: curve.length,
      bpm: 120,
      profileHash: "pin",
    }) as VocalProfile;

  it("five IDENTICAL takes: one segment, earlier take wins the tie (documented spine rule)", () => {
    const plan = planVocalComp(Array.from({ length: 5 }, () => profile(SHAPE, 40)));
    expect(plan).not.toBeNull();
    expect(plan!.segments).toHaveLength(1);
    expect(plan!.winner).toBe(0);
    expect(plan!.perTakeBars).toEqual([8, 0, 0, 0, 0]);
  });

  it("five whisper-quiet takes: the best-SNR take wins deterministically — no fabricated preference", () => {
    const plan = planVocalComp(Array.from({ length: 5 }, (_, i) => profile(SHAPE, 5 + i)));
    expect(plan!.winner).toBe(4);
    expect(plan!.perTakeBars).toEqual([0, 0, 0, 0, 8]);
  });
});

describe("levelMatchGainsDb — honest degradation and the ±12 dB clamp", () => {
  it("unmeasurable sides degrade to matched:false with zero gains", () => {
    expect(levelMatchGainsDb(null, -5).matched).toBe(false);
    expect(levelMatchGainsDb(Number.NaN, -5).matched).toBe(false);
    expect(levelMatchGainsDb(-5, null).gainDbA).toBe(0);
  });

  it("a wild pair clamps symmetrically and SAYS so", () => {
    const m = levelMatchGainsDb(-30, -5);
    expect(m.targetLufs).toBe(-17.5);
    expect(m.gainDbA).toBe(12);
    expect(m.gainDbB).toBe(-12);
    expect(m.note).toContain("clamped at ±12 dB");
  });
});
