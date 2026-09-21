import { describe, it, expect } from "vitest";
import {
  downmixToMono,
  resampleLinear,
  queryToLabelStems,
  searchAudioSamples,
  buildAudioIndex,
  prepareForClassification,
  AUDIO_SAMPLE_RATE,
} from "../src/sample-library/audio-index";
import type { AudioSampleIndex, AudioIndexEntry } from "../src/sample-library/audio-index";

/** Minimal AudioBuffer shape for the pure helpers (jsdom has none). */
function fakeBuffer(channels: number, length: number, sampleRate: number, fill: (i: number, ch: number) => number): AudioBuffer {
  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const arr = new Float32Array(length);
    for (let i = 0; i < length; i++) arr[i] = fill(i, ch);
    data.push(arr);
  }
  return {
    numberOfChannels: channels,
    sampleRate,
    length,
    getChannelData: (ch: number) => data[ch],
    duration: length / sampleRate,
  } as unknown as AudioBuffer;
}

describe("audio prep (T4)", () => {
  it("downmix averages channels", () => {
    const buffer = fakeBuffer(2, 4, 44100, (_i, ch) => (ch === 0 ? 1 : 0.5));
    const mono = downmixToMono(buffer);
    expect(mono.length).toBe(4);
    expect(mono[0]).toBeCloseTo(0.75);
  });

  it("linear resampler: length and DC signal preservation", () => {
    const data = Float32Array.from({ length: 44100 }, (_i) => 0.7);
    const out = resampleLinear(data, 44100, AUDIO_SAMPLE_RATE);
    expect(out.length).toBe(Math.floor(44100 / (44100 / AUDIO_SAMPLE_RATE)));
    expect(out[10]).toBeCloseTo(0.7, 5);
    expect(out[out.length - 1]).toBeCloseTo(0.7, 5);
  });

  it("prepareForClassification returns 16 kHz mono", () => {
    const buffer = fakeBuffer(2, 44100, 44100, (i) => (i % 2 === 0 ? 0.5 : -0.5));
    const out = prepareForClassification(buffer);
    expect(out.length).toBe(AUDIO_SAMPLE_RATE);
  });
});

describe("query → AudioSet label stems", () => {
  it("maps beat-maker vocabulary", () => {
    expect(queryToLabelStems("808")).toEqual(["bass drum", "synthetic bass", "bass guitar"]);
    expect(queryToLabelStems("sharp hi-hat")).toContain("hi-hat");
    expect(queryToLabelStems("soft clap")).toContain("clap");
    expect(queryToLabelStems("pomalé tmy")).toEqual([]); // no drum vocabulary
  });

  it("SK vocabulary maps to the same stems", () => {
    expect(queryToLabelStems("bici")).toContain("drum");
    expect(queryToLabelStems("bubny")).toContain("drum");
    expect(queryToLabelStems("tmy")).toEqual([]); // honest: not in the map yet
  });
});

describe("audio index search", () => {
  const entry = (assetId: string, labels: [string, number][]): AudioIndexEntry => ({
    assetId,
    name: assetId,
    labels: labels.map(([label, score]) => ({ label, score })),
  });
  const index: AudioSampleIndex = {
    modelId: "test",
    builtAt: 0,
    entries: [
      entry("factory.kick.deep", [["Kick", 0.9], ["Bass drum", 0.4]]),
      entry("factory.hat.closed", [["Hi-hat", 0.85]]),
      entry("user.mystery", [["Synthetic bass", 0.6], ["Sustain", 0.3]]),
    ],
  };

  it("ranks by matched label score (best first)", () => {
    const results = searchAudioSamples("808", index);
    // mystery's "Synthetic bass" (0.6) outscores kick's "Bass drum" (0.4)
    expect(results[0].assetId).toBe("user.mystery");
    expect(results[1].assetId).toBe("factory.kick.deep");
    const ids = results.map((result) => result.assetId);
    expect(ids).toContain("factory.kick.deep");
    expect(ids).toContain("user.mystery");
  });

  it("name-substring bonus lifts descriptive names", () => {
    const results = searchAudioSamples("hihat", index);
    expect(results[0].assetId).toBe("factory.hat.closed");
    expect(results[0].score).toBeGreaterThan(0.8);
  });

  it("no matching stems → no results (a search result is always a reason)", () => {
    expect(searchAudioSamples("quarterly taxes", index)).toEqual([]);
  });

  it("empty query stems → no results", () => {
    expect(searchAudioSamples("beautiful sunset", index)).toEqual([]);
  });
});

describe("buildAudioIndex (injected classifier)", () => {
  it("classifies every asset and skips classifier failures", async () => {
    const bank = {
      entries: () => [
        ["factory.kick.deep", fakeBuffer(1, 16000, 16000, () => 0.5)],
        ["user.mystery", fakeBuffer(1, 16000, 16000, () => 0.2)],
      ],
    } as unknown as import("../src/sample-library/factory").SampleBank;
    const classify = async (audio: Float32Array) => {
      if (audio[0] > 0.4) {
        return [{ label: "Kick", score: 0.9 }];
      }
      return null; // classifier failure on this asset
    };
    const progress: number[] = [];
    const index = await buildAudioIndex(bank, classify, (done) => progress.push(done));
    expect(index).not.toBeNull();
    expect(index!.entries.length).toBe(1); // the failed asset is skipped
    expect(index!.entries[0].assetId).toBe("factory.kick.deep");
    expect(progress).toEqual([1, 2]);
  });
});

import { bankSignature, cacheAudioIndex, loadCachedAudioIndex } from "../src/sample-library/audio-index";

describe("audio index localStorage cache", () => {
  const makeBank = (ids: string[]) => ({
    entries: () => ids.map((id) => [id, {} as AudioBuffer]),
  }) as unknown as import("../src/sample-library/factory").SampleBank;

  const makeIndex = () => ({
    modelId: "test", builtAt: 1, entries: [
      { assetId: "a", name: "a", labels: [{ label: "Kick", score: 0.9 }] },
    ],
  });

  it("caches and loads with matching bank signature", () => {
    const bank = makeBank(["a", "b", "c"]);
    const index = makeIndex();
    cacheAudioIndex(index, bank);
    const loaded = loadCachedAudioIndex(bank);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries.length).toBe(1);
  });

  it("invalidates when the bank changes", () => {
    const bank1 = makeBank(["a", "b", "c"]);
    cacheAudioIndex(makeIndex(), bank1);
    const bank2 = makeBank(["x", "y", "z"]);
    expect(loadCachedAudioIndex(bank2)).toBeNull();
  });

  it("bankSignature is deterministic and order-independent", () => {
    const s1 = bankSignature(makeBank(["c", "a", "b"]));
    const s2 = bankSignature(makeBank(["a", "b", "c"]));
    expect(s1).toBe(s2);
  });
});
