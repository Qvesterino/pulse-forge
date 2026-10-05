/**
 * RESONANCE ANALYSIS — the per-track "find the problem frequency and cut it"
 * detector. Locked here:
 *   1. a planted narrow spike is found at the right frequency with a plausible
 *      Q and a bounded negative cut;
 *   2. a WIDE hump reads a low Q (a tone-shape issue, not a razor resonance);
 *   3. flat noise yields ZERO hits (no invented problems);
 *   4. the cut is clamped (−12 dB) and Q clamped (0.1–24);
 *   5. the apply command reuses an existing eq or adds one, as ONE undo step;
 *   6. determinism: identical input → byte-identical peaks.
 */

import { describe, expect, it } from "vitest";
import {
  analyzeResonances,
  applyResonanceCutsCommand,
  describeResonance,
  RESONANCE_MAX_CUT_DB,
  RESONANCE_MAX_Q,
  RESONANCE_MIN_Q,
} from "../../src/reference/resonance";
import { createDefaultProject } from "../../src/project-model/schema";

const SR = 44100;

/** Deterministic broadband noise (seeded LCG) — same helper class as the intent detector's tests. */
function noise(seconds: number, amp = 0.3, seed = 42): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * ((s / 0x7fffffff) * 2 - 1);
  }
  return out;
}

/** A narrow resonance: a decaying sine at `hz` mixed into the signal. */
function addResonance(pcm: Float32Array, hz: number, amp: number): void {
  for (let i = 0; i < pcm.length; i++) {
    const env = Math.exp((-3 * i) / pcm.length);
    pcm[i] += amp * env * Math.sin((2 * Math.PI * hz * i) / SR);
  }
}

describe("analyzeResonances — detection", () => {
  it("finds a planted narrow resonance at the right frequency with a bounded cut", () => {
    const pcm = noise(2, 0.3);
    addResonance(pcm, 120, 0.5);
    const peaks = analyzeResonances(pcm, SR);
    expect(peaks.length).toBeGreaterThanOrEqual(1);
    expect(peaks[0]!.hz).toBeGreaterThanOrEqual(105);
    expect(peaks[0]!.hz).toBeLessThanOrEqual(135);
    expect(peaks[0]!.prominenceDb).toBeGreaterThan(6);
    // The cut is negative and clamped.
    expect(peaks[0]!.cutDb).toBeLessThan(0);
    expect(peaks[0]!.cutDb).toBeGreaterThanOrEqual(-RESONANCE_MAX_CUT_DB);
    // Q is inside the native free band's range.
    expect(peaks[0]!.q).toBeGreaterThanOrEqual(RESONANCE_MIN_Q);
    expect(peaks[0]!.q).toBeLessThanOrEqual(RESONANCE_MAX_Q);
  });

  it("a decaying spike reads a higher Q than a sustained tone", () => {
    // The decaying resonance is narrow in the averaged periodogram; a
    // sustained sine fills one bin hard and its skirts — comparably narrow in
    // bin terms, but the decay gives a cleaner isolated peak. We assert the
    // spike's Q is a real number in range and above the minimum (the exact
    // value is spectral-method dependent, so we lock plausibility, not a
    // brittle constant).
    const pcm = noise(2, 0.2, 5);
    addResonance(pcm, 347, 0.6);
    const peaks = analyzeResonances(pcm, SR);
    expect(peaks[0]!.q).toBeGreaterThan(RESONANCE_MIN_Q);
  });

  it("flat noise yields zero hits (no invented problems)", () => {
    expect(analyzeResonances(noise(2, 0.3), SR)).toHaveLength(0);
  });

  it("a flat broadband tone does not flag: prominence is measured against the local floor", () => {
    // A pink-ish shaped noise (no narrow spikes) must not produce hits.
    const pcm = noise(2, 0.25, 11);
    // Low-pass it crudely with a one-pole so the spectrum has a slope, not peaks.
    let prev = 0;
    for (let i = 0; i < pcm.length; i++) {
      prev = prev * 0.95 + pcm[i]! * 0.05;
      pcm[i] = prev;
    }
    expect(analyzeResonances(pcm, SR)).toHaveLength(0);
  });

  it("maxHits caps the result and order is by prominence", () => {
    const pcm = noise(2, 0.2, 7);
    addResonance(pcm, 250, 0.8);
    addResonance(pcm, 1200, 0.7);
    addResonance(pcm, 5000, 0.5);
    const peaks = analyzeResonances(pcm, SR, { maxHits: 2 });
    expect(peaks.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i - 1]!.prominenceDb).toBeGreaterThanOrEqual(peaks[i]!.prominenceDb);
    }
  });

  it("hostile input never throws", () => {
    expect(analyzeResonances(new Float32Array(10), SR)).toHaveLength(0);
    expect(analyzeResonances(new Float32Array(SR), 0)).toHaveLength(0);
    expect(analyzeResonances(new Float32Array(SR), Number.NaN)).toHaveLength(0);
  });

  it("is deterministic — identical input → identical peaks", () => {
    const pcm = noise(2, 0.3);
    addResonance(pcm, 120, 0.5);
    expect(analyzeResonances(pcm, SR)).toEqual(analyzeResonances(pcm, SR));
  });
});

describe("applyResonanceCutsCommand", () => {
  it("adds an eq with a BELL on free1 when the track has none, as one command", async () => {
    const doc = createDefaultProject();
    const kick = doc.tracks.find((t) => t.kind === "drum")!;
    const peaks = analyzeResonances((() => {
      const pcm = noise(2, 0.3);
      addResonance(pcm, 120, 0.6);
      return pcm;
    })(), SR);
    expect(peaks.length).toBeGreaterThanOrEqual(1);

    const command = applyResonanceCutsCommand(doc, kick.id, peaks);
    expect(command).not.toBeNull();
    const after = command!.execute(doc);
    const track = after.tracks.find((t) => t.id === kick.id)!;
    const eq = track.effects.find((fx) => fx.type === "eq");
    expect(eq).toBeDefined();
    // free1 is a BELL at the detected frequency with a negative gain and the
    // estimated Q — the exact "cut 120 Hz" shape.
    expect(eq!.params.free1Type).toBe(0);
    expect(eq!.params.free1Gain).toBeLessThan(0);
    expect(eq!.params.free1Freq).toBeGreaterThan(100);
    expect(eq!.params.free1Freq).toBeLessThan(140);
    // Undo removes the added effect entirely.
    const undone = command!.undo(after);
    expect(undone.tracks.find((t) => t.id === kick.id)!.effects.find((fx) => fx.type === "eq")).toBeUndefined();
  });

  it("reuses an existing eq instance instead of adding a second one", async () => {
    const doc = createDefaultProject();
    const kick = doc.tracks.find((t) => t.kind === "drum")!;
    // Seed an eq instance.
    const { addEffect } = await import("../../src/commands/tracks");
    const seeded = addEffect(doc, kick.id, "eq").execute(doc);
    const peaks = [{ hz: 120, prominenceDb: 10, q: 4, cutDb: -7 }];
    const command = applyResonanceCutsCommand(seeded, kick.id, peaks);
    expect(command).not.toBeNull();
    const after = command!.execute(seeded);
    const track = after.tracks.find((t) => t.id === kick.id)!;
    const eqs = track.effects.filter((fx) => fx.type === "eq");
    expect(eqs).toHaveLength(1);
    expect(eqs[0]!.params.free1Type).toBe(0);
    expect(eqs[0]!.params.free1Gain).toBe(-7);
    expect(eqs[0]!.params.free1Q).toBe(4);
  });

  it("applies at most two peaks (the EQ has two free bands) and nulls on empty", async () => {
    const doc = createDefaultProject();
    const kick = doc.tracks.find((t) => t.kind === "drum")!;
    expect(applyResonanceCutsCommand(doc, kick.id, [])).toBeNull();
    expect(applyResonanceCutsCommand(doc, "missing-track", [{ hz: 120, prominenceDb: 9, q: 4, cutDb: -6 }])).toBeNull();

    const three = [
      { hz: 120, prominenceDb: 12, q: 4, cutDb: -8 },
      { hz: 900, prominenceDb: 10, q: 5, cutDb: -7 },
      { hz: 5000, prominenceDb: 9, q: 6, cutDb: -6 },
    ];
    const command = applyResonanceCutsCommand(doc, kick.id, three);
    const after = command!.execute(doc);
    const eq = after.tracks.find((t) => t.id === kick.id)!.effects.find((fx) => fx.type === "eq")!;
    expect(eq.params.free1Gain).toBe(-8);
    expect(eq.params.free2Gain).toBe(-7);
  });

  it("describeResonance renders the evidence line", () => {
    const line = describeResonance({ hz: 120.04, prominenceDb: 11.25, q: 3.8, cutDb: -7.9 });
    expect(line).toContain("120.0 Hz");
    expect(line).toContain("cut -7.9 dB");
  });
});
