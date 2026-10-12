import { describe, expect, it } from "vitest";
import { estimateHumMidi, voiceifyHum } from "../src/vocal/voiceify";

/**
 * HUM→VOICE (W3) — the user's own hum tuned and assembled into a lead.
 * Locked with synthetic hums: the pitch estimate lands on the known tone,
 * the output carries the TARGET pitches (autocorrelation on the render),
 * note timing maps ticks → samples, and silent input is honest-empty.
 */

const SR = 44100;

/**
 * A harmonic hum at hz, `seconds` long, softly faded in/out. A real hum is
 * never a pure sine — the harmonics are what make the autocorrelation's
 * true-period peak dominate its sub-period neighbors.
 */
function sineHum(hz: number, seconds: number): Float32Array {
  const length = Math.floor(seconds * SR);
  const audio = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / length;
    const edge = Math.min(1, Math.min(t, 1 - t) * 10);
    const phase = (2 * Math.PI * hz * i) / SR;
    audio[i] = (0.5 * Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase)) * edge;
  }
  return audio;
}

describe("estimateHumMidi", () => {
  it("lands on the known tone (A3 hum → MIDI 57 ±0.5)", () => {
    const midi = estimateHumMidi(sineHum(220, 2), SR);
    expect(midi).not.toBeNull();
    expect(Math.abs(midi! - 57)).toBeLessThan(0.5);
  });

  it("silent audio is honest-null", () => {
    expect(estimateHumMidi(new Float32Array(SR), SR)).toBeNull();
    expect(estimateHumMidi(new Float32Array(100), SR)).toBeNull();
  });
});

describe("voiceifyHum", () => {
  it("the tuned lead carries the TARGET pitch, not the hum's (A3 hum → A4 lead)", () => {
    const hum = sineHum(220, 2); // A3
    const out = voiceifyHum(
      hum,
      SR,
      [{ midi: 69, startTicks: 0, durationTicks: 480 }], // A4
      { bpm: 120, ppq: 480 },
    );
    expect(out.length).toBeCloseTo(0.5 * SR, -2);
    // The naive lerp resampler leaves interpolation images up high — the
    // pitch the EAR reads is the zero-crossing fundamental.
    const from = Math.floor(out.length * 0.3);
    const to = Math.floor(out.length * 0.7);
    let zc = 0;
    for (let i = from + 1; i < to; i++) if (out[i - 1] < 0 !== out[i] < 0) zc += 1;
    const hz = zc / 2 / ((to - from) / SR);
    expect(Math.abs(hz - 440), `target 440 Hz, measured ${hz.toFixed(1)}`).toBeLessThan(15);
  });

  it("note timing maps ticks → samples (two notes, one silent gap)", () => {
    const hum = sineHum(220, 2);
    // 120 BPM, PPQ 480: one tick = 1/960 s. Note 1 at tick 0 (quarter), note
    // 2 at tick 960 (beat 2) — the gap between them must be silent.
    const out = voiceifyHum(
      hum,
      SR,
      [
        { midi: 69, startTicks: 0, durationTicks: 480 },
        { midi: 71, startTicks: 960, durationTicks: 480 },
      ],
      { bpm: 120, ppq: 480 },
    );
    // The gap spans note 1's end (0.5 s) to note 2's start (1.0 s) — its
    // MIDDLE must be silent, and note 2 carries content again.
    const gapMiddle = Math.floor(0.75 * SR);
    let gapPeak = 0;
    for (let i = gapMiddle - 2000; i <= gapMiddle + 2000; i++) gapPeak = Math.max(gapPeak, Math.abs(out[i]));
    expect(gapPeak, "the tick gap stays silent").toBeLessThan(0.01);
    let note2Peak = 0;
    for (let i = Math.floor(1.02 * SR); i < Math.floor(1.4 * SR); i++) {
      note2Peak = Math.max(note2Peak, Math.abs(out[i]));
    }
    expect(note2Peak).toBeGreaterThan(0.05);
  });

  it("is honest-empty on no notes or a silent hum", () => {
    const hum = sineHum(220, 1);
    expect(voiceifyHum(hum, SR, [], { bpm: 120 })).toHaveLength(0);
    expect(
      voiceifyHum(new Float32Array(SR), SR, [{ midi: 69, startTicks: 0, durationTicks: 480 }], { bpm: 120 }),
    ).toHaveLength(0);
  });

  it("is deterministic — same input, same render", () => {
    const hum = sineHum(220, 1);
    const notes = [
      { midi: 69, startTicks: 0, durationTicks: 480 },
      { midi: 71, startTicks: 480, durationTicks: 480 },
    ];
    const a = voiceifyHum(hum, SR, notes, { bpm: 120 });
    const b = voiceifyHum(hum, SR, notes, { bpm: 120 });
    expect(b).toEqual(a);
  });
});
