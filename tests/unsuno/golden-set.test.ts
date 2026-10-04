import { describe, expect, it } from "vitest";
import { detectTransients } from "../../src/audio-workers/onset-detector";
import { keyMatch, tempoFoldError } from "../../src/reference/unsuno-metrics";
import { transcribeTrack, type UnsunoTranscription } from "../../src/reference/transcribe";
import {
  GOLDEN_SAMPLE_RATE,
  GOLDEN_SEED,
  goldenTracks,
  renderGoldenTrack,
  stepToSample,
  type GoldenTrack,
} from "./golden-synth";

/**
 * U0 — GOLDEN SET (docs/UN-SUNO-PLAN.md): the measuring stick for every
 * transcription wave. Four layers:
 *
 *   1. determinism — same seed → bit-identical render (invariant #4);
 *   2. sanity — the signal is actually transcribable material (onsets exist,
 *      length matches the bar math, not silence, not clipped);
 *   3. contract — transcribeTrack reports the three missing layers as
 *      implemented:false + warning (honest pending, never invented content);
 *   4. LIVE floors — tempo/key run against the REAL existing estimators
 *      today; the U1/U2/U3 KPI blocks activate automatically the moment a
 *      layer flips to implemented:true (skipIf gating, zero test churn).
 */

const SAMPLE_RATE = GOLDEN_SAMPLE_RATE;
const tracks = goldenTracks();
const rendered = new Map<string, Float32Array>(tracks.map((track) => [track.id, renderGoldenTrack(track)]));
const transcriptions = new Map<string, UnsunoTranscription>(
  tracks.map((track) => [track.id, transcribeTrack(rendered.get(track.id)!, SAMPLE_RATE)]),
);
const expectedDuration = (track: GoldenTrack) => stepToSample(track.bars * 16, track.bpm, SAMPLE_RATE) / SAMPLE_RATE;

describe("golden synth determinism (invariant #4)", () => {
  it("same seed → bit-identical PCM", () => {
    for (const track of tracks) {
      const a = renderGoldenTrack(track);
      const b = renderGoldenTrack(track);
      expect(a.length).toBe(b.length);
      let identical = true;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          identical = false;
          break;
        }
      }
      expect(identical, track.id).toBe(true);
    }
  });
  it("different seed → different signal (noise floor participates)", () => {
    const a = renderGoldenTrack(tracks[0], { seed: GOLDEN_SEED });
    const b = renderGoldenTrack(tracks[0], { seed: GOLDEN_SEED + 1 });
    let diff = 0;
    for (let i = 0; i < a.length; i += 997) if (a[i] !== b[i]) diff += 1;
    expect(diff).toBeGreaterThan(0);
  });
});

describe("golden sanity — the material is transcribable", () => {
  it("every track: right duration, peak ≤ 1, audible", () => {
    for (const track of tracks) {
      const pcm = rendered.get(track.id)!;
      const expected = expectedDuration(track);
      expect(pcm.length / SAMPLE_RATE, track.id).toBeGreaterThanOrEqual(expected);
      expect(pcm.length / SAMPLE_RATE, track.id).toBeLessThan(expected + 0.6); // + release tail only
      let peak = 0;
      let energy = 0;
      for (let i = 0; i < pcm.length; i++) {
        peak = Math.max(peak, Math.abs(pcm[i]));
        energy += pcm[i] * pcm[i];
      }
      expect(peak, `${track.id} peak`).toBeLessThanOrEqual(1.0001);
      expect(Math.sqrt(energy / pcm.length), `${track.id} rms`).toBeGreaterThan(0.03);
    }
  });
  it("ground truth density: every track has ≥ 4 drum truth steps per bar", () => {
    for (const track of tracks) {
      for (let bar = 0; bar < track.bars; bar++) {
        const hits = [track.drums.kick[bar], track.drums.snare[bar], track.drums.hat[bar]].reduce(
          (sum, pattern) => sum + (pattern?.filter((v) => v > 0).length ?? 0),
          0,
        );
        expect(hits, `${track.id} bar ${bar}`).toBeGreaterThanOrEqual(4);
      }
      expect(track.bass.length, `${track.id} bass notes`).toBeGreaterThanOrEqual(track.bars);
      expect(track.chords.length, `${track.id} chords`).toBe(track.bars);
    }
  });
});

describe("transcribeTrack contract — pending layers are honest", () => {
  it("returns tempo+key shape and marks drums/bass/chords implemented:false", () => {
    for (const track of tracks) {
      const t = transcriptions.get(track.id)!;
      expect(t.sampleRate).toBe(SAMPLE_RATE);
      expect(t.durationSec).toBeGreaterThan(4);
      if (t.tempo !== null) {
        expect(typeof t.tempo.bpm).toBe("number");
        expect(t.tempo.confidence).toBeGreaterThan(0);
      }
      if (t.key !== null) expect(typeof t.key.key).toBe("string");
      for (const layer of ["drums", "bass", "chords"] as const) {
        expect(t[layer].implemented, `${track.id}.${layer}`).toBe(false);
        expect(t[layer].warning, `${track.id}.${layer}`).toMatch(/U[123]/);
      }
    }
  });
});

describe("LIVE floor — tempo & key estimators on golden material", () => {
  // These run against the SHIPPED estimators TODAY and lock the measured
  // U0 baseline (npm run unsuno:golden re-measures). The baseline is
  // DELIBERATELY per-track exact: any estimator/synth change must flip a
  // test and get re-locked on purpose — silent drift is the enemy.
  // Known gaps (locked, not hidden): detectTransients finds only 2–11 of
  // ~100 events on polyphonic material, so estimateTempo returns null on
  // 3/5 tracks and misses by 8/30 BPM on the rest → U0.5 follow-up wave.
  const BASELINE: Record<string, { tempo: number | null; key: string | null }> = {
    "house-126-am": { tempo: 118, key: "A Natural Minor" },
    "techno-130-em": { tempo: null, key: "E Natural Minor" },
    "boombap-90-cm": { tempo: null, key: "C Natural Minor" },
    "trap-140-fsm": { tempo: 110, key: null }, // detects A Natural Minor — wrong tonic (truth F#)
    "dnb-174-gm": { tempo: null, key: "G Natural Minor" },
  };

  it("tempo: per-track locked baseline (or honest null), fold error ≤ 30 everywhere", () => {
    for (const track of tracks) {
      const expected = BASELINE[track.id];
      const t = transcriptions.get(track.id)!;
      expect(t.tempo?.bpm ?? null, `${track.id} tempo`).toBe(expected.tempo);
      const error = tempoFoldError(t.tempo?.bpm ?? null, track.bpm);
      if (error !== null) expect(error, `${track.id} fold error`).toBeLessThanOrEqual(30);
    }
  });
  it("key: 4/5 exact (mode included) — the U0 KPI floor (≥ 0.8), per-track locked", () => {
    const exactCount = tracks.filter(
      (track) => keyMatch(transcriptions.get(track.id)!.key?.key ?? null, track.key).exact,
    ).length;
    expect(exactCount).toBeGreaterThanOrEqual(4);
    // Lock WHICH tracks pass — a new pass (e.g. trap fixed) must re-lock.
    for (const track of tracks) {
      const expected = BASELINE[track.id];
      const report = keyMatch(transcriptions.get(track.id)!.key?.key ?? null, track.key);
      expect(report.exact, `${track.id} exact`).toBe(expected.key !== null);
      if (expected.key !== null) {
        expect(transcriptions.get(track.id)!.key?.key, `${track.id} key string`).toBe(expected.key);
      }
    }
  });
  it("onset floor: detectTransients finds ≥ 2 events per track (today's honest floor)", () => {
    for (const track of tracks) {
      const onsets = detectTransients(rendered.get(track.id)!, SAMPLE_RATE, 1);
      expect(onsets.length, `${track.id} onsets`).toBeGreaterThanOrEqual(2);
    }
  });
});

// ─── U1/U2/U3 KPI gates — dormant until the layer flips implemented:true ───

describe("U1 chords KPI (activates when chords.implemented)", () => {
  const ready = tracks.filter((track) => transcriptions.get(track.id)!.chords.implemented);
  it.skipIf(ready.length === 0)("per-bar exact accuracy ≥ 0.90 on every track", () => {
    for (const track of ready) {
      const t = transcriptions.get(track.id)!;
      void track;
      void t;
      // Wire-up lands with U1: chordBarAccuracy(t.chords.events, goldenChords(track))
      throw new Error("U1 landed — replace this stub with the real chordBarAccuracy assertion");
    }
  });
});

describe("U2 bass KPI (activates when bass.implemented)", () => {
  const ready = tracks.filter((track) => transcriptions.get(track.id)!.bass.implemented);
  it.skipIf(ready.length === 0)("onset recall ≥ 0.70 and pitch accuracy ≥ 0.90 per track", () => {
    for (const track of ready) {
      const t = transcriptions.get(track.id)!;
      void track;
      void t;
      // Wire-up lands with U2: bassNoteMetrics(t.bass.notes, goldenBass(track), windowSec)
      throw new Error("U2 landed — replace this stub with the real bassNoteMetrics assertion");
    }
  });
});

describe("U3 drums KPI (activates when drums.implemented)", () => {
  const ready = tracks.filter((track) => transcriptions.get(track.id)!.drums.implemented);
  it.skipIf(ready.length === 0)("kick/snare/hat step F1 ≥ 0.85 per track (±1 step tolerance)", () => {
    for (const track of ready) {
      const t = transcriptions.get(track.id)!;
      void t;
      // Wire-up lands with U3: stepF1(t.drums.kickSteps, goldenKickSteps(track), { tolerance: 1 })
      throw new Error("U3 landed — replace this stub with the real stepF1 assertions");
    }
  });
});
