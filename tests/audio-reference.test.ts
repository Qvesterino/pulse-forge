import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyzeAudioReference, featuresToSliders } from "../src/intent/audio-reference";
import { estimateKey, estimateTempo } from "../src/ai/audio-tempo-key";
import { projectEmbedding } from "../src/ai/symbolic/pca-projection";
import {
  resetSemanticConditioning,
  semanticConditioning,
  setAudioReferenceConditioning,
} from "../src/intent/semantic-conditioning";
import type { AudioLabel } from "../src/ai/audio/audio-types";
import type { EmbedFn } from "../src/intent/semantic-conditioning";

// The semantic WORKER is the real MiniLM runtime — stub the embed call so the
// text-bridge conditioning is numerically checkable.
vi.mock("../src/ai/semantic/semantic-client", () => ({
  semanticMode: vi.fn(() => "on" as const),
  semanticAvailable: vi.fn(async () => true),
  embedTexts: vi.fn(async () => null),
  resetSemanticClient: vi.fn(),
}));

import { embedTexts } from "../src/ai/semantic/semantic-client";

const embedTextsMock = vi.mocked(embedTexts);

/** Deterministic pseudo-embedding per text (FNV-chained), L2-normalized. */
function vectorFor(text: string): Float32Array {
  const out = new Float32Array(384);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  for (let index = 0; index < 384; index++) {
    hash = Math.imul(hash ^ (index + 1), 16777619);
    out[index] = ((hash >>> 0) / 0xffffffff) * 2 - 1;
  }
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < 384; index++) out[index] /= norm;
  return out;
}

/** Quiet sine at ~100 Hz — calm, bass-heavy features. */
function quietBassPcm(): Float32Array {
  const pcm = new Float32Array(16000);
  for (let index = 0; index < pcm.length; index++) pcm[index] = 0.1 * Math.sin((2 * Math.PI * 100 * index) / 16000);
  return pcm;
}

const embed: EmbedFn = (texts) => Promise.resolve(texts.map(vectorFor));

beforeEach(() => {
  localStorage.clear();
  resetSemanticConditioning();
  embedTextsMock.mockReset();
  embedTextsMock.mockResolvedValue(null);
  setAudioReferenceConditioning(null);
});

describe("audio reference — analysis", () => {
  it("maps AST labels to the canonical genre and builds the patch", async () => {
    const labels: AudioLabel[] = [
      { label: "Techno", score: 0.82 },
      { label: "Drum machine", score: 0.7 },
      { label: "Kick", score: 0.6 },
    ];
    const classify = async () => labels;
    const result = await analyzeAudioReference(quietBassPcm(), { classify, embed });
    expect(result).not.toBeNull();
    expect(result?.genre).toBe("techno");
    expect(result?.patch.genre).toBe("techno");
    expect(result?.summary).toContain("techno");
    expect(result?.labels).toHaveLength(3);
  });

  it("builds a text-bridge conditioning vector in the corpus space", async () => {
    const classify = async (): Promise<AudioLabel[]> => [
      { label: "Techno", score: 0.9 },
      { label: "Synth", score: 0.5 },
    ];
    const result = await analyzeAudioReference(quietBassPcm(), { classify, embed });
    expect(result?.conditioningText).toContain("Techno");
    // exact same arithmetic as the PCA module: project the label-text embedding
    expect(result?.conditioning).toEqual(projectEmbedding(vectorFor("Techno Synth")));
  });

  it("unavailable AST degrades to a features-only patch (no genre, no conditioning)", async () => {
    const classify = async (): Promise<AudioLabel[] | null> => null;
    const result = await analyzeAudioReference(quietBassPcm(), { classify, embed });
    expect(result).not.toBeNull();
    expect(result?.genre).toBeNull();
    expect(result?.conditioning).toBeNull();
    expect(result?.patch.energy).toBeGreaterThan(0);
  });

  it("features drive the sliders: loud+compressed is energetic, quiet sine is calm", () => {
    const calm = featuresToSliders({ rms: 0.05, peak: 0.3, crestFactor: 8, zeroCrossingRate: 0.02, lowBandRatio: 0.6 });
    expect(calm.energy).toBeLessThan(0.5);
    expect(calm.mood).toBe("chill");
    const punchy = featuresToSliders({
      rms: 0.25,
      peak: 0.9,
      crestFactor: 3.5,
      zeroCrossingRate: 0.1,
      lowBandRatio: 0.5,
    });
    expect(punchy.energy).toBeGreaterThan(0.7);
    expect(punchy.mood).toBe("aggressive");
  });
});

describe("audio reference conditioning override", () => {
  it("installed reference REPLACES the text projection as the conditioning base", async () => {
    localStorage.setItem("pf:embedding-conditioned", "on");
    embedTextsMock.mockImplementation((texts: string[]) => Promise.resolve(texts.map(vectorFor)));
    setAudioReferenceConditioning(projectEmbedding(vectorFor("the wav sounds like this")));
    const conditioning = await semanticConditioning("totally different words", embedTextsMock);
    expect(conditioning).toEqual(projectEmbedding(vectorFor("the wav sounds like this")));
    // clearing returns to text-driven conditioning
    setAudioReferenceConditioning(null);
    resetSemanticConditioning();
    const backToText = await semanticConditioning("totally different words", embedTextsMock);
    expect(backToText).toEqual(projectEmbedding(vectorFor("totally different words")));
  });
});

describe("audio reference — tempo + key estimation", () => {
  /** Click track: impulses at a fixed period — the machine-gun tempo test. */
  function clickTrack(bpm: number, seconds = 8): Float32Array {
    const sampleRate = 16000;
    const pcm = new Float32Array(sampleRate * seconds);
    const period = Math.round((60 / bpm) * sampleRate);
    for (let start = 0; start + 40 < pcm.length; start += period) {
      for (let index = 0; index < 40; index++) pcm[start + index] = 1 - index / 40;
    }
    return pcm;
  }

  it("estimates tempo from a click track within tolerance", () => {
    const tempo = estimateTempo(clickTrack(128), 16000);
    expect(tempo).not.toBeNull();
    expect(tempo?.bpm).toBeGreaterThanOrEqual(124);
    expect(tempo?.bpm).toBeLessThanOrEqual(132);
    // 90 BPM folds correctly too (half/double ambiguity resolved)
    const slow = estimateTempo(clickTrack(90), 16000);
    expect(slow?.bpm).toBeGreaterThanOrEqual(86);
    expect(slow?.bpm).toBeLessThanOrEqual(94);
  });

  it("refuses to guess on sparse/short signals", () => {
    expect(estimateTempo(new Float32Array(1600), 16000)).toBeNull(); // 0.1 s
    const silence = new Float32Array(16000 * 8);
    expect(estimateTempo(silence, 16000)).toBeNull(); // no onsets at all
  });

  it("detects the root pitch class via Goertzel chroma", () => {
    const sampleRate = 16000;
    const pcm = new Float32Array(sampleRate * 3);
    for (let index = 0; index < pcm.length; index++) {
      pcm[index] = 0.3 * Math.sin((2 * Math.PI * 261.63 * index) / sampleRate); // C4
    }
    const key = estimateKey(pcm, sampleRate);
    expect(key).not.toBeNull();
    expect(key?.key.startsWith("C")).toBe(true);
  });

  it("tempo and key flow into the reference patch", async () => {
    const classify = async (): Promise<AudioLabel[]> => [{ label: "Techno", score: 0.9 }];
    const result = await analyzeAudioReference(clickTrackForReference(128), {
      classify: async () => [{ label: "Techno", score: 0.9 }],
      embed,
    });
    void classify;
    expect(result?.tempo?.bpm).toBeGreaterThanOrEqual(124);
    expect(result?.patch.bpmRange?.[0]).toBeGreaterThanOrEqual(122);
    expect(result?.summary).toMatch(/BPM/);
  });
});

function clickTrackForReference(bpm: number): Float32Array {
  const sampleRate = 16000;
  const pcm = new Float32Array(sampleRate * 8);
  const period = Math.round((60 / bpm) * sampleRate);
  for (let start = 0; start + 40 < pcm.length; start += period) {
    for (let index = 0; index < 40; index++) pcm[start + index] = 1 - index / 40;
  }
  return pcm;
}
