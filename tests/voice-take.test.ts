import { describe, expect, it } from "vitest";
import { analyzeVoiceTake, measurePercussiveness } from "../src/intent/voice-take";
import type { PitchFrame } from "../src/audio-workers/pitch-tracker";

const RATE = 16000;

/** A soft-attack hummed line: 220 Hz notes of 0.45 s with 100 ms ramps and small gaps. */
function humPcm(seconds = 8): Float32Array {
  const pcm = new Float32Array(RATE * seconds);
  const noteSec = 0.5;
  const noteFrames = Math.floor(noteSec * RATE);
  const ramp = Math.floor(0.1 * RATE);
  for (let noteStart = 0; noteStart + noteFrames < pcm.length; noteStart += Math.floor(noteSec * RATE)) {
    for (let index = 0; index < noteFrames; index++) {
      const envelope = index < ramp ? index / ramp : index > noteFrames - ramp ? (noteFrames - index) / ramp : 1;
      pcm[noteStart + index] = 0.4 * envelope * Math.sin((2 * Math.PI * 220 * index) / RATE);
    }
  }
  return pcm;
}

/** Sharp percussive taps: 15 ms noise bursts with instant attack every 0.25 s. */
function tapsPcm(seconds = 8): Float32Array {
  const pcm = new Float32Array(RATE * seconds);
  const tapLength = Math.floor(0.015 * RATE);
  const interval = Math.floor(0.25 * RATE);
  let seed = 12345;
  for (let tapStart = 0; tapStart + tapLength < pcm.length; tapStart += interval) {
    for (let index = 0; index < tapLength; index++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      pcm[tapStart + index] = 0.8 * (index / tapLength) * ((seed / 0x7fffffff) * 2 - 1);
    }
  }
  return pcm;
}

function mixedPcm(): Float32Array {
  const hum = humPcm();
  const taps = tapsPcm();
  const mixed = new Float32Array(hum.length);
  for (let index = 0; index < mixed.length; index++) mixed[index] = hum[index]! + 0.9 * taps[index]!;
  return mixed;
}

/** Clean pitched frames for the melodic lane — a CHANGING phrase (a single
 * sustained tone would segment into one note, which is below the verdict's
 * melody floor by design). */
function humFrames(): PitchFrame[] {
  const melody = [57, 60, 64, 65];
  const frames: PitchFrame[] = [];
  const noteSec = 0.5;
  const frameSec = 0.02;
  for (let note = 0; note * noteSec < 7.5; note += 1) {
    for (let t = 0; t < noteSec; t += frameSec) {
      frames.push({ timeSec: note * noteSec + t, midi: melody[note % melody.length]!, clarity: 0.9, rms: 0.2 });
    }
  }
  return frames;
}

describe("measurePercussiveness", () => {
  it("hums sustain, taps are impulsive bursts", () => {
    const hum = measurePercussiveness(humPcm(), RATE);
    expect(hum.sustainRatio).toBeGreaterThan(0.5);
    expect(hum.sharpFrames).toBeLessThanOrEqual(2);
    const taps = measurePercussiveness(tapsPcm(), RATE);
    expect(taps.sharpFrames).toBeGreaterThanOrEqual(16);
    expect(taps.sustainRatio).toBeLessThan(0.4);
  });

  it("silence measures nothing", () => {
    const quiet = measurePercussiveness(new Float32Array(RATE), RATE);
    expect(quiet.strongFrames).toBe(0);
  });
});

describe("analyzeVoiceTake", () => {
  it("a hummed melody is melodic — its own onsets do NOT become drums", async () => {
    const analysis = await analyzeVoiceTake(humPcm(), RATE, {
      bpm: 120,
      track: async () => humFrames(),
    });
    expect(analysis.verdict).toBe("melodic");
    expect(analysis.melody?.noteCount).toBeGreaterThanOrEqual(3);
    expect(analysis.summary).toMatch(/melódia/);
    expect(analysis.summary).not.toMatch(/rytmus/);
  });

  it("beatbox-style taps are percussive — no melody claim", async () => {
    const analysis = await analyzeVoiceTake(tapsPcm(), RATE, {
      bpm: 120,
      track: async () => [],
    });
    expect(analysis.verdict).toBe("percussive");
    expect(analysis.groove).not.toBeNull();
    expect(analysis.groove?.hits.length).toBeGreaterThanOrEqual(4);
    expect(analysis.summary).toMatch(/rytmus/);
  });

  it("hum over taps is BOTH lanes in one take", async () => {
    const analysis = await analyzeVoiceTake(mixedPcm(), RATE, {
      bpm: 120,
      track: async () => humFrames(),
    });
    expect(analysis.verdict).toBe("both");
    expect(analysis.melody?.noteCount).toBeGreaterThanOrEqual(3);
    expect(analysis.groove?.hits.length).toBeGreaterThanOrEqual(4);
  });

  it("silence is empty, never a verdict lie", async () => {
    const analysis = await analyzeVoiceTake(new Float32Array(RATE * 2), RATE, {
      bpm: 120,
      track: async () => [],
    });
    expect(analysis.verdict).toBe("empty");
  });

  it("is deterministic for the same take", async () => {
    const a = await analyzeVoiceTake(mixedPcm(), RATE, { bpm: 120, track: async () => humFrames() });
    const b = await analyzeVoiceTake(mixedPcm(), RATE, { bpm: 120, track: async () => humFrames() });
    expect(b.verdict).toBe(a.verdict);
    expect(b.summary).toBe(a.summary);
    expect(b.sharpRatio).toBeCloseTo(a.sharpRatio, 10);
  });
});
