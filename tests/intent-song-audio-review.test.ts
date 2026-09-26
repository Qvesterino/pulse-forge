import { describe, expect, it } from "vitest";
import { reviewSongAudio } from "../src/intent/song-audio-review";

function fakeBuffer(channels: Float32Array[], sampleRate = 44_100): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate,
    getChannelData: (index: number) => channels[index]!,
  } as unknown as AudioBuffer;
}

describe("whole-song render review", () => {
  it("measures the audition buffer without flagging a healthy signal", () => {
    const review = reviewSongAudio(
      fakeBuffer([new Float32Array(44_100).fill(0.5), new Float32Array(44_100).fill(0.5)]),
    );

    expect(review.durationSeconds).toBe(1);
    expect(review.peakDbfs).toBe(-6);
    expect(review.rmsDbfs).toBe(-6);
    expect(review.crestFactor).toBe(1);
    expect(review.nonFiniteSamples).toBe(0);
    expect(review.findings).toEqual([]);
  });

  it("reports non-finite and near-full-scale evidence without corrupting the input", () => {
    const left = new Float32Array([Number.NaN, 1]);
    const review = reviewSongAudio(fakeBuffer([left, new Float32Array([0, 0])], 2));

    expect(review.peakDbfs).toBe(0);
    expect(review.nonFiniteSamples).toBe(1);
    expect(review.findings.map((finding) => finding.code)).toEqual(["non-finite-samples", "near-full-scale"]);
    expect(left[0]).toBeNaN();
  });

  it("flags a near-silent song so missing signal is visible before USE", () => {
    const review = reviewSongAudio(fakeBuffer([new Float32Array(256).fill(0.0001)]));

    expect(review.findings.map((finding) => finding.code)).toEqual(["near-silence"]);
    expect(review.rmsDbfs).toBeLessThan(-70);
  });
});

// ── Fáza 5: per-section meters + evidence-based revival suggestions ────────

import { analyzeSongSections, suggestSectionRevivals } from "../src/intent/song-audio-review";

function sectionedBuffer(segments: number[], amplitude: number, sampleRate = 44_100): AudioBuffer {
  const total = segments.reduce((sum, seconds) => sum + Math.round(seconds * sampleRate), 0);
  const data = new Float32Array(total);
  let cursor = 0;
  for (const seconds of segments) {
    const frames = Math.round(seconds * sampleRate);
    data.fill(amplitude, cursor, cursor + frames);
    cursor += frames;
  }
  return fakeBuffer([data]);
}

const FORM = [
  { role: "intro", bars: 4 },
  { role: "verse", bars: 8 },
  { role: "drop", bars: 8 },
  { role: "break", bars: 4 },
  { role: "chorus", bars: 8 },
];

describe("per-section meters", () => {
  it("segments the buffer by bar boundaries at the song BPM", () => {
    // 128 BPM → 1.875 s per bar. intro 4 bars, verse/drop/chorus 8, break 4.
    const buffer = sectionedBuffer([7.5, 15, 15, 7.5, 15], 0.5);
    const meters = analyzeSongSections(buffer, FORM, 128);
    expect(meters.map((meter) => meter.role)).toEqual(["intro", "verse", "drop", "break", "chorus"]);
    expect(meters[0].seconds).toBeCloseTo(7.5, 1);
    expect(meters[1].rmsDbfs).toBeCloseTo(-6, 0);
    expect(meters[1].startSecond).toBeCloseTo(7.5, 0);
  });

  it("returns nothing without a usable clock or form", () => {
    const buffer = sectionedBuffer([1], 0.5);
    expect(analyzeSongSections(buffer, FORM, 0)).toEqual([]);
    expect(analyzeSongSections(buffer, [], 128)).toEqual([]);
  });
});

describe("evidence-based revival suggestions", () => {
  it("flags a loud-carrying section far below the song's own reference", () => {
    // chorus sits 12 dB under the verse/drop reference — measurable evidence.
    const total = 60 * 44_100;
    const data = new Float32Array(total);
    data.fill(0.5, 0, Math.round(45 * 44_100));
    data.fill(0.125, Math.round(45 * 44_100));
    const meters = analyzeSongSections(fakeBuffer([data]), FORM, 128);
    const suggestions = suggestSectionRevivals(meters);
    expect(suggestions.map((suggestion) => suggestion.role)).toEqual(["chorus"]);
    expect(suggestions[0].attribute).toBe("energy");
    expect(suggestions[0].delta).toBeGreaterThan(0);
    expect(suggestions[0].reason).toContain("ticho");
  });

  it("never suggests on breathing sections (break/intro) and stays silent on balanced songs", () => {
    // Break/intro at near-silence while drop/verse/chorus are balanced → no suggestion.
    const total = 60 * 44_100;
    const data = new Float32Array(total);
    data.fill(0.0001, 0, Math.round(7.5 * 44_100)); // intro quiet
    data.fill(0.5, Math.round(7.5 * 44_100), Math.round(45 * 44_100)); // verse+drop loud
    data.fill(0.0001, Math.round(45 * 44_100), Math.round(52.5 * 44_100)); // break quiet
    data.fill(0.5, Math.round(52.5 * 44_100)); // chorus loud
    const meters = analyzeSongSections(fakeBuffer([data]), FORM, 128);
    expect(suggestSectionRevivals(meters)).toEqual([]);
  });

  it("needs at least two loud-carrying sections to have a reference at all", () => {
    const meters = analyzeSongSections(sectionedBuffer([15], 0.5), [{ role: "drop", bars: 8 }], 128);
    expect(suggestSectionRevivals(meters)).toEqual([]);
  });
});
