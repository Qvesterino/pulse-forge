import { describe, expect, it } from "vitest";
import { transcribeTrack } from "../../src/reference/transcribe";
import {
  bassNoteMetrics,
  chordBarAccuracy,
  expandChordSpans,
  keyMatch,
  stepF1,
} from "../../src/reference/unsuno-metrics";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "./golden-synth";

/**
 * S1 — HPSS lane integration (ADR 0019 Tier 1). With separation: "hpss"
 * each lane reads its guide stem (drums -> percussive, bass -> bass
 * register, chords/melody -> harmonic minus its bass register). The
 * DEFAULT path ("off") is untouched — the locked U0-U7 baselines all
 * measure it, so "no behavior change by default" is enforced by every
 * other suite in this folder.
 *
 * Floors below are the measured S1 HPSS baseline. Wins are real (techno
 * bass recall 0.05 -> 0.28, the documented S1 target nearly met; dnb
 * bass pitch-class to 100 %; key survives on 4/5). Known regressions vs
 * the full-mix baselines are LOCKED HERE as floors and documented, not
 * hidden: boombap bass reads 0 on the bass stem (S1.5 must fix the bass
 * lane's stem input), dnb chords collapse on the harmonic stem (dense
 * 174 BPM material splits ~50/50 — Tier 2 territory).
 */

const SR = GOLDEN_SAMPLE_RATE;

const HPSS_FLOORS: Record<
  string,
  { bassRecall: number; bassPc: number; chords: number; kick: number; snare: number; hat: number; key: boolean }
> = {
  "house-126-am": { bassRecall: 0.2, bassPc: 0.9, chords: 1.0, kick: 0.68, snare: 0.5, hat: 0.75, key: true },
  "techno-130-em": { bassRecall: 0.25, bassPc: 0.35, chords: 1.0, kick: 0.85, snare: 0.95, hat: 0.35, key: true },
  "boombap-90-cm": { bassRecall: 0.0, bassPc: 0.0, chords: 0.9, kick: 0.5, snare: 0.6, hat: 0.35, key: true },
  "trap-140-fsm": { bassRecall: 0.38, bassPc: 0.9, chords: 0.85, kick: 0.78, snare: 0.95, hat: 0.1, key: true },
  "dnb-174-gm": { bassRecall: 0.2, bassPc: 0.9, chords: 0.0, kick: 0.2, snare: 0.0, hat: 0.85, key: false },
};

describe("S1 — HPSS lane integration (separation: hpss)", () => {
  it("per-track locked floors: bass / chords / drums / key on guide stems", () => {
    const lines: string[] = [];
    for (const track of goldenTracks()) {
      const pcm = renderGoldenTrack(track);
      const t = transcribeTrack(pcm, SR, { separation: "hpss" });
      const floor = HPSS_FLOORS[track.id];
      const stepSec = 60 / track.bpm / 4;

      const bm = bassNoteMetrics(
        t.bass.notes.map((n) => ({ startSec: n.startSec, midi: n.midi })),
        track.bass.map((n) => ({ startSec: n.step * stepSec, midi: n.pitch })),
        stepSec * 0.6,
      );
      const cm = chordBarAccuracy(expandChordSpans(t.chords.spans), track.chords);
      const km = keyMatch(t.key?.key ?? null, track.key);

      lines.push(
        `${track.id}: bass r${bm.onset.recall.toFixed(2)} pc${(bm.pitchClassAccuracy * 100).toFixed(0)}% · chords ${cm.exactCorrect}/${cm.total} · key ${km.exact ? "exact" : "miss"}`,
      );
      expect(bm.onset.recall, `${track.id} bass recall`).toBeGreaterThanOrEqual(floor.bassRecall);
      expect(bm.pitchClassAccuracy, `${track.id} bass pc`).toBeGreaterThanOrEqual(floor.bassPc);
      expect(cm.exactAccuracy, `${track.id} chords`).toBeGreaterThanOrEqual(floor.chords);
      expect(km.exact, `${track.id} key`).toBe(floor.key);
      for (const band of ["kick", "snare", "hat"] as const) {
        const truth = new Set<number>();
        for (let bar = 0; bar < track.bars; bar++) {
          for (let slot = 0; slot < 16; slot++) if ((track.drums[band][bar]?.[slot] ?? 0) > 0) truth.add(slot);
        }
        const report = stepF1(
          t.drums[band],
          [...truth].sort((a, b) => a - b),
          { tolerance: 1 },
        );
        expect(report.f1, `${track.id}.${band}`).toBeGreaterThanOrEqual(floor[band]);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`S1 HPSS baseline:\n${lines.join("\n")}`);
  }, 240_000);

  it("the S1 target: techno bass recall on the bass stem improves over the full mix", () => {
    const track = goldenTracks()[1];
    const pcm = renderGoldenTrack(track);
    const stepSec = 60 / track.bpm / 4;
    const full = transcribeTrack(pcm, SR); // separation off
    const separated = transcribeTrack(pcm, SR, { separation: "hpss" });
    const truth = track.bass.map((n) => ({ startSec: n.step * stepSec, midi: n.pitch }));
    const fullReport = bassNoteMetrics(
      full.bass.notes.map((n) => ({ startSec: n.startSec, midi: n.midi })),
      truth,
      stepSec * 0.6,
    );
    const hpssReport = bassNoteMetrics(
      separated.bass.notes.map((n) => ({ startSec: n.startSec, midi: n.midi })),
      truth,
      stepSec * 0.6,
    );
    // 0.05 -> 0.28 measured: the bass stem DOES what it exists for.
    expect(hpssReport.onset.recall).toBeGreaterThan(fullReport.onset.recall);
    expect(hpssReport.onset.recall).toBeGreaterThanOrEqual(0.25);
  }, 120_000);
});
