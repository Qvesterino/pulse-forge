import { describe, it, expect } from "vitest";
import { extractAudioFeatures } from "../src/ai/audio-features";
import { scoreAudioFit, audioTargetFor } from "../src/intent/audio-feedback";
import { routeIntentText } from "../src/intent/route";
import { testDoc } from "./fixtures/doc";

function sineData(amplitude: number, frequency: number, seconds: number, sampleRate = 44100): Float32Array {
  const length = Math.ceil(seconds * sampleRate);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return data;
}

function noiseData(amplitude: number, seconds: number, sampleRate = 44100): Float32Array {
  const length = Math.ceil(seconds * sampleRate);
  const data = new Float32Array(length);
  let seed = 12345;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = amplitude * ((seed / 0x7fffffff) * 2 - 1);
  }
  return data;
}

describe("audio feature extraction (T4/D1 v3)", () => {
  it("loud signal has higher RMS than quiet signal", () => {
    const loud = extractAudioFeatures(sineData(1000, 0.8, 1), 44100);
    const quiet = extractAudioFeatures(sineData(1000, 0.1, 1), 44100);
    expect(loud.rms).toBeGreaterThan(quiet.rms);
    expect(loud.peak).toBeGreaterThan(quiet.peak);
  });

  it("noise has higher ZCR than a low sine wave", () => {
    const noise = extractAudioFeatures(noiseData(0.5, 1), 44100);
    const lowSine = extractAudioFeatures(sineData(100, 0.5, 1), 44100);
    expect(noise.zeroCrossingRate).toBeGreaterThan(lowSine.zeroCrossingRate);
  });

  it("low-frequency signal has higher bass ratio", () => {
    const lowSine = extractAudioFeatures(sineData(0.5, 60, 1), 44100);
    const highSine = extractAudioFeatures(sineData(0.5, 4000, 1), 44100);
    expect(lowSine.lowBandRatio).toBeGreaterThan(highSine.lowBandRatio);
  });

  it("compressed signal has lower crest factor than dynamic signal", () => {
    // compressed: constant amplitude
    const compressed = extractAudioFeatures(sineData(440, 0.8, 1), 44100);
    // dynamic: mixed quiet and loud segments
    const quietPart = sineData(440, 0.1, 0.5);
    const loudPart = sineData(440, 0.9, 0.5);
    const dynamic = new Float32Array(quietPart.length + loudPart.length);
    dynamic.set(quietPart, 0);
    dynamic.set(loudPart, quietPart.length);
    const dynFeatures = extractAudioFeatures(dynamic, 44100);
    expect(compressed.crestFactor).toBeLessThan(dynFeatures.crestFactor);
  });

  it("silence produces zero features", () => {
    const silence = extractAudioFeatures(new Float32Array(44100), 44100);
    expect(silence.rms).toBe(0);
    expect(silence.peak).toBe(0);
  });
});

describe("genre audio targets", () => {
  it("every genre has a target profile", () => {
    for (const genre of ["house", "techno", "trap", "ambient"]) {
      const target = audioTargetFor(genre);
      expect(target.rmsRange).toBeDefined();
      expect(target.crestRange).toBeDefined();
      expect(target.zcrRange).toBeDefined();
      expect(target.bassRange).toBeDefined();
    }
  });

  it("trap expects higher bass ratio than ambient", () => {
    const trap = audioTargetFor("trap");
    const ambient = audioTargetFor("ambient");
    expect(trap.bassRange[0]).toBeGreaterThanOrEqual(ambient.bassRange[0]);
  });
});

describe("audio fit scoring", () => {
  it("signal inside the target range scores high", () => {
    const features = { rms: 0.15, peak: 0.8, crestFactor: 5, zeroCrossingRate: 0.05, lowBandRatio: 0.35 };
    const target = audioTargetFor("house");
    const score = scoreAudioFit(features, target);
    expect(score).toBeGreaterThan(0.5);
  });

  it("signal far outside the target scores low", () => {
    // very quiet, very bright, no bass — bad for house
    const features = { rms: 0.001, peak: 0.01, crestFactor: 1.1, zeroCrossingRate: 0.4, lowBandRatio: 0.01 };
    const target = audioTargetFor("house");
    const score = scoreAudioFit(features, target);
    expect(score).toBeLessThan(0.4);
  });
});

describe("router: loudness and effect intent (D1 v2c+v2a)", () => {
  it("loudness route fires for 'make it louder'", () => {
    const route = routeIntentText("make it louder", testDoc());
    expect(route.kind).toBe("loudness");
  });

  it("targeted effect route fires for 'more delay on the lead'", () => {
    const route = routeIntentText("more delay on the lead", testDoc());
    expect(route.kind).toBe("effectIntent");
  });

  it("pattern route still fires for generation text", () => {
    const route = routeIntentText("dark techno at 140", testDoc());
    expect(route.kind).toBe("pattern");
  });
});
