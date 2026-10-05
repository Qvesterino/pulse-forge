import { describe, expect, it } from "vitest";
import { applyLowPass, detectBassNotes } from "../../src/reference/analysis/bass";
import { trackPitch } from "../../src/audio-workers/pitch-tracker";

/**
 * U2 unit layer — the bass lane on CLEAN material (no kick): here the
 * transcription must be near-perfect, and these tests pin that. The
 * kick-contaminated genre KPI floors live in golden-set.test.ts with the
 * documented U2.5 follow-up.
 */

const SR = 44100;

/** Sustained sine bass notes (fundamental + 2nd harmonic, like the synth). */
function bassPcm(notes: { startSec: number; durationSec: number; midi: number }[], seconds: number): Float32Array {
  const pcm = new Float32Array(Math.ceil(SR * seconds));
  for (const note of notes) {
    const start = Math.round(note.startSec * SR);
    const length = Math.round(note.durationSec * SR);
    const f0 = 440 * Math.pow(2, (note.midi - 69) / 12);
    for (let i = 0; i < length && start + i < pcm.length; i++) {
      pcm[start + i] += 0.4 * Math.sin((2 * Math.PI * f0 * i) / SR) + 0.16 * Math.sin((4 * Math.PI * f0 * i) / SR);
    }
  }
  return pcm;
}

describe("detectBassNotes — clean material contract", () => {
  it("two separated C2 notes → both found, right pitch, near-zero timing error", () => {
    const pcm = bassPcm(
      [
        { startSec: 0.0, durationSec: 0.4, midi: 36 },
        { startSec: 1.0, durationSec: 0.4, midi: 36 },
      ],
      2.5,
    );
    const detection = detectBassNotes(pcm, SR, { bpm: 120 });
    expect(detection).not.toBeNull();
    expect(detection!.notes.length).toBe(2);
    expect(detection!.notes[0].midi).toBe(36);
    expect(detection!.notes[1].midi).toBe(36);
    expect(detection!.notes[0].startSec).toBeLessThan(0.1);
    expect(detection!.notes[1].startSec).toBeGreaterThan(0.9);
    expect(detection!.notes[1].startSec).toBeLessThan(1.1);
    expect(detection!.notes[0].confidence).toBeGreaterThan(0.5);
    expect(detection!.coverage).toBeGreaterThan(0.3);
  });

  it("pitch change breaks the run — C2 then G2 → two notes", () => {
    const pcm = bassPcm(
      [
        { startSec: 0.0, durationSec: 0.5, midi: 36 },
        { startSec: 0.5, durationSec: 0.5, midi: 43 },
      ],
      2,
    );
    const detection = detectBassNotes(pcm, SR, { bpm: 120 });
    expect(detection!.notes.length).toBe(2);
    expect(detection!.notes[0].midi).toBe(36);
    expect(detection!.notes[1].midi).toBe(43);
  });

  it("808 sub-bass register (F#1 = 46 Hz) is tracked", () => {
    const pcm = bassPcm([{ startSec: 0.0, durationSec: 0.8, midi: 30 }], 2);
    const detection = detectBassNotes(pcm, SR, { bpm: 140 });
    expect(detection!.notes.length).toBeGreaterThanOrEqual(1);
    expect(detection!.notes[0].midi).toBe(30);
  });

  it("silence → honest empty, never invented", () => {
    const detection = detectBassNotes(new Float32Array(SR * 3), SR, { bpm: 120 });
    expect(detection).not.toBeNull();
    expect(detection!.notes).toEqual([]);
    expect(detection!.coverage).toBe(0);
  });

  it("determinism: same signal → identical notes", () => {
    const pcm = bassPcm([{ startSec: 0.1, durationSec: 0.6, midi: 33 }], 2);
    const a = detectBassNotes(pcm, SR, { bpm: 120 });
    const b = detectBassNotes(pcm, SR, { bpm: 120 });
    expect(a).toEqual(b);
  });

  it("opt-in scale snap pulls off-scale pitches to the nearest degree", () => {
    // C#2 (49 Hz, off-scale in C major) → snaps to C2 or D2, never stays C#.
    const pcm = bassPcm([{ startSec: 0.0, durationSec: 0.8, midi: 37 }], 2);
    const detection = detectBassNotes(pcm, SR, { bpm: 120, snapToScale: { tonicPc: 0, mode: "major" } });
    expect(detection!.notes[0].midi).not.toBe(37);
    expect([36, 38]).toContain(detection!.notes[0].midi);
  });
});

describe("low-level primitives", () => {
  it("trackPitch honors fminHz/fmaxHz options (bass window)", () => {
    const pcm = bassPcm([{ startSec: 0.0, durationSec: 0.8, midi: 30 }], 2); // F#1 = 46 Hz
    // Default range (70+) cannot see 46 Hz; the bass range must.
    const defaultFrames = trackPitch(pcm, SR).filter((f) => f.midi > 0);
    const bassFrames = trackPitch(pcm, SR, { fminHz: 40, fmaxHz: 250, hopMs: 20 }).filter((f) => f.midi > 0);
    expect(bassFrames.length).toBeGreaterThan(0);
    const median = (xs: number[]): number => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    expect(Math.round(median(bassFrames.map((f) => f.midi)))).toBe(30);
    void defaultFrames;
  });
  it("applyLowPass attenuates highs, keeps the fundamental", () => {
    const pcm = new Float32Array(SR);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = 0.5 * Math.sin((2 * Math.PI * 65.4 * i) / SR) + 0.5 * Math.sin((2 * Math.PI * 2000 * i) / SR);
    }
    const filtered = applyLowPass(pcm, SR, 300);
    const bandPower = (data: Float32Array, hz: number): number => {
      let s1 = 0;
      let s2 = 0;
      const k = (2 * Math.PI * hz) / SR;
      const coeff = 2 * Math.cos(k);
      for (let i = 0; i < data.length; i++) {
        const s0 = data[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
    };
    const lowBefore = bandPower(pcm, 65.4);
    const lowAfter = bandPower(filtered, 65.4);
    const highBefore = bandPower(pcm, 2000);
    const highAfter = bandPower(filtered, 2000);
    expect(lowAfter / lowBefore).toBeGreaterThan(0.8); // fundamental survives
    expect(highAfter / highBefore).toBeLessThan(0.1); // 2 kHz gone
  });
});
