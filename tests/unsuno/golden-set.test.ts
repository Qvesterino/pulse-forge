import { describe, expect, it } from "vitest";
import { detectTransients } from "../../src/audio-workers/onset-detector";
import {
  bassNoteMetrics,
  chordBarAccuracy,
  expandChordSpans,
  keyMatch,
  tempoFoldError,
} from "../../src/reference/unsuno-metrics";
import { transcribeTrack, type UnsunoTranscription } from "../../src/reference/transcribe";
import {
  drumsOnlyTrack,
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

describe("transcribeTrack contract — implemented layers vs honest pending", () => {
  it("tempo/key shape, chords implemented since U1, drums/bass still pending", () => {
    for (const track of tracks) {
      const t = transcriptions.get(track.id)!;
      expect(t.sampleRate).toBe(SAMPLE_RATE);
      expect(t.durationSec).toBeGreaterThan(4);
      if (t.tempo !== null) {
        expect(typeof t.tempo.bpm).toBe("number");
        expect(t.tempo.confidence).toBeGreaterThan(0);
      }
      if (t.key !== null) expect(typeof t.key.key).toBe("string");
      // chords: implemented since U1 — harmonic golden tracks must carry
      // spans (grid/estimator failures surface as warning, never silence).
      expect(t.chords.implemented, `${track.id}.chords`).toBe(true);
      expect(t.chords.spans.length, `${track.id}.chords spans`).toBeGreaterThan(0);
      expect(t.chords.warning, `${track.id}.chords warning`).toBeNull();
      for (const span of t.chords.spans) {
        expect(span.rootPc, `${track.id} span root`).toBeGreaterThanOrEqual(0);
        expect(span.quality, `${track.id} span quality`).toMatch(/^(maj|min|dom7|min7|maj7|sus4)$/);
        expect(span.confidence, `${track.id} span confidence`).toBeGreaterThanOrEqual(0);
      }
      // bass: implemented since U2 — harmonic golden tracks carry notes.
      expect(t.bass.implemented, `${track.id}.bass`).toBe(true);
      expect(t.bass.notes.length, `${track.id}.bass notes`).toBeGreaterThan(0);
      expect(t.bass.warning, `${track.id}.bass warning`).toBeNull();
      // drums: still waiting for U3 — honest pending, never empty claims.
      expect(t.drums.implemented, `${track.id}.drums`).toBe(false);
      expect(t.drums.warning, `${track.id}.drums`).toMatch(/U3/);
    }
  });
  it("chord spans carry degree/function against the detected key", () => {
    // house: A minor detected → its tonic span must be degree 1 / T.
    const house = transcriptions.get("house-126-am")!;
    const tonic = house.chords.spans.find((span) => span.rootPc === 9);
    expect(tonic).toBeDefined();
    expect(tonic!.degree).toBe(1);
    expect(tonic!.func).toBe("T");
    // …and the bVI (F major) is a degree-6 passing chord, not a function.
    const submediant = house.chords.spans.find((span) => span.rootPc === 5);
    expect(submediant!.degree).toBe(6);
    expect(submediant!.func).toBe("p");
  });
});

describe("LIVE floor — tempo & key estimators on golden material", () => {
  // These run against the SHIPPED estimators TODAY and lock the measured
  // baseline (npm run unsuno:golden re-measures). The baseline is
  // DELIBERATELY per-track exact: any estimator/synth change must flip a
  // test and get re-locked on purpose — silent drift is the enemy.
  //
  // HISTORY: U0 locked the old estimators (tempo null on 3/5, misses 8/30
  // BPM; key 4/5). U0.5 rebuilt estimateTempo on the F1 flux envelope +
  // parabolic candidates and fixed the golden fixture's chord qualities
  // (were all "min"; D/A/E in an F#-minor progression are MAJOR — the F
  // natural in Dm poisoned the trap key) → both KPIs now 5/5. Re-locked
  // 2026-10-04.
  // U1 fixture evolution (bass roots now diatonic) exposed the KK rotation
  // limit — chroma alone read trap as D major and dnb as Eb major (both
  // diatonically valid rotations, floor honestly re-locked 3/5). U1.5 fixed
  // it at the SOURCE: the chord sequence decides the key (first chord ×3,
  // tonic returns, mode matches) — estimateKey only falls back when no
  // harmony is readable. Floor back to 5/5. Re-locked 2026-10-04.
  const BASELINE: Record<string, { tempo: number; key: string }> = {
    "house-126-am": { tempo: 126.0, key: "A Natural Minor" },
    "techno-130-em": { tempo: 130.0, key: "E Natural Minor" },
    "boombap-90-cm": { tempo: 89.9, key: "C Natural Minor" },
    "trap-140-fsm": { tempo: 139.8, key: "F# Natural Minor" },
    "dnb-174-gm": { tempo: 86.9, key: "G Natural Minor" },
  };

  it("tempo: per-track locked baseline, fold error ≤ 1 BPM everywhere (U0.5 KPI)", () => {
    for (const track of tracks) {
      const expected = BASELINE[track.id];
      const t = transcriptions.get(track.id)!;
      expect(t.tempo?.bpm ?? null, `${track.id} tempo`).toBe(expected.tempo);
      const error = tempoFoldError(t.tempo?.bpm ?? null, track.bpm);
      expect(error, `${track.id} fold error`).not.toBeNull();
      expect(error!, `${track.id} fold error`).toBeLessThanOrEqual(1);
    }
  });
  it("key: 5/5 exact (mode included) — the U1.5 chord-sequence key, per-track locked", () => {
    const exactCount = tracks.filter(
      (track) => keyMatch(transcriptions.get(track.id)!.key?.key ?? null, track.key).exact,
    ).length;
    expect(exactCount).toBe(5);
    for (const track of tracks) {
      const expected = BASELINE[track.id];
      expect(transcriptions.get(track.id)!.key?.key ?? null, `${track.id} key string`).toBe(expected.key);
    }
  });
  it("onset floor: detectTransients finds ≥ 2 events per track (shared detector untouched)", () => {
    for (const track of tracks) {
      const onsets = detectTransients(rendered.get(track.id)!, SAMPLE_RATE, 1);
      expect(onsets.length, `${track.id} onsets`).toBeGreaterThanOrEqual(2);
    }
  });
});

// ─── U1 chords KPI — ACTIVE since the chords layer landed ───────────────────

describe("U1 chords KPI (active)", () => {
  it("per-bar exact accuracy ≥ 0.90 on every golden track (grid-reconciled)", () => {
    const perTrack: string[] = [];
    for (const track of tracks) {
      const t = transcriptions.get(track.id)!;
      expect(t.chords.implemented, track.id).toBe(true);
      // The detected tempo may sit at half/double time (dnb at 86.9) — spans
      // are scored on the TRUTH grid through time (seconds), never indices.
      const detected = expandChordSpans(t.chords.spans, {
        spanBarSec: 240 / (t.tempo?.bpm ?? track.bpm),
        truthBarSec: 240 / track.bpm,
        totalBars: track.bars,
      });
      const report = chordBarAccuracy(detected, track.chords);
      perTrack.push(`${track.id}: ${report.exactCorrect}/${report.total} (root ${report.rootCorrect}/${report.total})`);
      expect(report.exactAccuracy, `${track.id}: ${perTrack[perTrack.length - 1]}`).toBeGreaterThanOrEqual(0.9);
    }
    // eslint-disable-next-line no-console
    console.log(`U1 chords KPI:\n${perTrack.join("\n")}`);
  });
  it("overall exact accuracy across the golden set ≥ 0.90", () => {
    let correct = 0;
    let total = 0;
    for (const track of tracks) {
      const t = transcriptions.get(track.id)!;
      const detected = expandChordSpans(t.chords.spans, {
        spanBarSec: 240 / (t.tempo?.bpm ?? track.bpm),
        truthBarSec: 240 / track.bpm,
        totalBars: track.bars,
      });
      const report = chordBarAccuracy(detected, track.chords);
      correct += report.exactCorrect;
      total += report.total;
    }
    expect(correct / total).toBeGreaterThanOrEqual(0.9);
  });
});

describe("chord honesty — empty beats invented", () => {
  it("drums-only material: chords stay EMPTY with a warning, never invented", () => {
    const pcm = renderGoldenTrack(drumsOnlyTrack());
    const t = transcribeTrack(pcm, SAMPLE_RATE);
    expect(t.chords.implemented).toBe(true);
    expect(t.chords.spans).toEqual([]);
    expect(t.chords.warning).toMatch(/no stable harmony/);
  });
  it("silence: no tempo → no bar grid → chords skip with a warning", () => {
    const t = transcribeTrack(new Float32Array(SAMPLE_RATE * 2), SAMPLE_RATE);
    expect(t.tempo).toBeNull();
    expect(t.chords.spans).toEqual([]);
    expect(t.chords.warning).toMatch(/bar grid/);
    expect(t.bass.notes).toEqual([]);
    expect(t.bass.warning).toMatch(/bar grid/);
  });
  it("drums-only: without chord context the bass lane refuses to guess", () => {
    const t = transcribeTrack(renderGoldenTrack(drumsOnlyTrack()), SAMPLE_RATE);
    expect(t.chords.spans).toEqual([]);
    expect(t.bass.implemented).toBe(true);
    expect(t.bass.notes).toEqual([]);
    expect(t.bass.warning).toMatch(/chord context/);
  });
});

// ─── U2 bass KPI — ACTIVE, floors locked at the U2 baseline ─────────────────

describe("U2 bass KPI (active — floors at the U2 baseline, KPI NOT yet met)", () => {
  // The bass lane works on clean material (unit tests) but the golden set's
  // synthetic kick is a pure-sine sweep LOUDER than the bass — its tail
  // (48–52 Hz) out-claries the bass fundamental and YIN tracks it through
  // the chord-tone prior whenever the terminal pitch is a chord tone.
  // Floors below are the U2 baseline; the U2.5 wave (kick-tail suppression
  // via transient gating) must only move them UP. docs/UN-SUNO-PLAN.md.
  const FLOORS: Record<string, { recall: number; pitch: number; pitchClass: number }> = {
    "house-126-am": { recall: 0.4, pitch: 0.5, pitchClass: 0.9 },
    "techno-130-em": { recall: 0.4, pitch: 0.0, pitchClass: 0.0 },
    "boombap-90-cm": { recall: 0.3, pitch: 0.0, pitchClass: 0.3 },
    "trap-140-fsm": { recall: 0.6, pitch: 0.35, pitchClass: 0.7 },
    "dnb-174-gm": { recall: 0.15, pitch: 0.4, pitchClass: 0.4 },
  };
  it("onset recall / pitch accuracy at or above the locked U2 baseline", () => {
    const lines: string[] = [];
    for (const track of tracks) {
      const t = transcriptions.get(track.id)!;
      const stepSec = 60 / track.bpm / 4;
      const truth = track.bass.map((note) => ({
        startSec: note.step * stepSec,
        midi: note.pitch,
      }));
      const report = bassNoteMetrics(
        t.bass.notes.map((note) => ({ startSec: note.startSec, midi: note.midi })),
        truth,
        stepSec * 0.6,
      );
      const floor = FLOORS[track.id];
      lines.push(
        `${track.id}: recall ${report.onset.recall.toFixed(2)} pitch ${(report.pitchAccuracy * 100).toFixed(0)}% pc ${(report.pitchClassAccuracy * 100).toFixed(0)}%`,
      );
      expect(report.onset.recall, `${track.id} onset recall`).toBeGreaterThanOrEqual(floor.recall);
      expect(report.pitchAccuracy, `${track.id} pitch accuracy`).toBeGreaterThanOrEqual(floor.pitch);
      expect(report.pitchClassAccuracy, `${track.id} pitch-class accuracy`).toBeGreaterThanOrEqual(floor.pitchClass);
    }
    // eslint-disable-next-line no-console
    console.log(`U2 bass KPI (baseline, KPI pending U2.5): ${lines.join(" | ")}`);
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
