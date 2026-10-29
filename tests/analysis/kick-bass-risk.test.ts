import { describe, expect, it } from "vitest";
import {
  analyzeKickBassRisk,
  makeIsolatedKickDoc,
  notAnalyzedKickBassRisk,
  selectKickBassSourcePair,
  type KickBassSourcePair,
} from "../../src/analysis/kick-bass-risk";
import { detectTransients } from "../../src/audio-workers/onset-detector";
import type { DrumTrack, ProjectDocument } from "../../src/project-model/types";
import { testDoc } from "../fixtures/doc";

/**
 * E2 gate — the onset-aligned kick/bass spectrum analyzer against signals
 * with KNOWN ground truth.
 *
 * The hypothesis under test: co-occurrence in the shared low bands must
 * depend on what actually sounds AT the kick onsets — not on averages. Every
 * spec here builds a synthetic mix whose answer is known by construction
 * (sine bursts at named frequencies and amplitudes) and asserts the report
 * agrees. The thresholds pinned are the module's own: measurable floor
 * −70 dBFS, candidate floor −45 dBFS, ±18 dB level-difference gate, one-bin
 * close-peak tolerance. Agreement with these known answers is the module's
 * licence to appear in kyx_render_summary output; if any of them flips, the
 * finding text agents read is lying.
 */

const SR = 44100;

interface SyntheticKickSpec {
  /** Burst start times in seconds. */
  onsetsSec: number[];
  burstSec?: number;
  freqHz?: number;
  amplitude?: number;
}

/** A kick stem: short sine bursts (sharp envelope steps the transient detector cannot miss). */
function kickSignal(spec: SyntheticKickSpec, totalSec: number): Float32Array {
  const data = new Float32Array(Math.ceil(totalSec * SR));
  const burst = spec.burstSec ?? 0.15;
  const freq = spec.freqHz ?? 50;
  const amplitude = spec.amplitude ?? 0.5;
  for (const onset of spec.onsetsSec) {
    const start = Math.round(onset * SR);
    const end = Math.min(data.length, start + Math.round(burst * SR));
    for (let i = start; i < end; i += 1) {
      const t = (i - start) / SR;
      const fade = Math.min(1, t / 0.002); // 2 ms attack: a clean transient step
      data[i] = amplitude * Math.sin(2 * Math.PI * freq * t) * fade;
    }
  }
  return data;
}

/** A bass stem: a continuous sine (or silence). */
function bassSignal(freqHz: number | null, amplitude: number, totalSec: number): Float32Array {
  const data = new Float32Array(Math.ceil(totalSec * SR));
  if (freqHz === null) return data;
  for (let i = 0; i < data.length; i += 1) {
    data[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / SR);
  }
  return data;
}

const WINDOW = { startSample: 0, startTick: 0, endTick: 7680, startSec: 0, endSec: 1.2, sampleRate: SR };

function pairFrom(doc: ProjectDocument): KickBassSourcePair {
  const selection = selectKickBassSourcePair(doc);
  if (!selection.pair) throw new Error(`fixture has no kick/bass pair: ${selection.reason ?? ""}`);
  return selection.pair;
}

/** The house fixture already names its roles: the "808" instrument + a kick pad? No —
 * build an EXPLICIT pair doc: a drum track with a synth kick pad and the 808 bass. */
function docWithKickAndBass(): ProjectDocument {
  const doc = testDoc();
  const drums = doc.tracks.find((track): track is DrumTrack => track.kind === "drum")!;
  // Make the kick role EXPLICIT and unambiguous: pad 0 is named "Kick", every
  // other pad gets a role-neutral name so the selector sees exactly one
  // highest-ranked kick candidate. Nothing is muted or soloed.
  return {
    ...doc,
    tracks: doc.tracks.map((track) => {
      if (track.kind === "drum") {
        return {
          ...drums,
          mute: false,
          solo: false,
          pads: drums.pads.map((pad, index) => ({
            ...pad,
            mute: false,
            solo: false,
            name: index === 0 ? "Kick" : `Pad ${index + 1}`,
          })),
        };
      }
      return { ...track, mute: false, solo: false };
    }),
  };
}

describe("kick/bass source selection", () => {
  it("selects the named synth-kick pad and the 808 instrument; refuses ambiguity and solo state", () => {
    const doc = docWithKickAndBass();
    const clean = selectKickBassSourcePair(doc);
    expect(clean.pair).not.toBeNull();
    expect(clean.pair!.bass.instrument).toBe("808");

    // Solo state changes audibility — the selector must refuse, not guess.
    const withSolo = selectKickBassSourcePair({
      ...doc,
      tracks: doc.tracks.map((track) => (track.kind === "drum" ? { ...track, solo: true } : track)),
    });
    expect(withSolo.pair).toBeNull();
    expect(withSolo.reason).toContain("solo");

    // Two equally-ranked kick pads are ambiguous — never guess.
    const drums = doc.tracks.find((track): track is DrumTrack => track.kind === "drum")!;
    const clonedPad = { ...drums.pads[0]!, id: "pad-clone" };
    const ambiguous = selectKickBassSourcePair({
      ...doc,
      tracks: doc.tracks.map((track) =>
        track.id === drums.id ? { ...drums, pads: [...drums.pads, clonedPad] } : track,
      ),
    });
    expect(ambiguous.pair).toBeNull();
    expect(ambiguous.reason).toContain("ambiguous");
  });

  it("makeIsolatedKickDoc mutes every OTHER pad and clears solos", () => {
    const doc = docWithKickAndBass();
    const pair = pairFrom(doc);
    const isolated = makeIsolatedKickDoc(doc, pair);
    const drums = isolated.tracks.find((track): track is DrumTrack => track.kind === "drum")!;
    for (const pad of drums.pads) {
      expect(pad.mute).toBe(pad.id !== pair.kick.padId);
      expect(pad.solo).toBe(false);
    }
  });

  it("no candidates at all → honest not-analyzed report carrying the counts", () => {
    const doc = testDoc();
    const drums = doc.tracks.find((track): track is DrumTrack => track.kind === "drum")!;
    const renamed = {
      ...doc,
      tracks: doc.tracks.map((track) =>
        track.id === drums.id ? { ...drums, pads: drums.pads.map((pad) => ({ ...pad, name: "Shaker" })) } : track,
      ),
    };
    const selection = selectKickBassSourcePair(renamed);
    expect(selection.pair).toBeNull();
    const report = notAnalyzedKickBassRisk(WINDOW, selection.reason ?? "no pair", {
      kickCandidates: selection.kickCandidates,
      bassCandidates: selection.bassCandidates,
    });
    expect(report.status).toBe("not-analyzed");
    expect(report.selection?.kickCandidates).toBe(0);
    expect(report.caveats.length).toBeGreaterThan(0);
  });
});

describe("onset-aligned kick/bass spectrum (known-answer contract)", () => {
  it("continuous 50 Hz bass under 50 Hz kick bursts → every onset is a risk candidate", () => {
    const doc = docWithKickAndBass();
    const pair = pairFrom(doc);
    const onsets = [0.1, 0.4, 0.7];
    const report = analyzeKickBassRisk({
      doc,
      pair,
      kickMono: kickSignal({ onsetsSec: onsets }, 1.2),
      bassChannels: [bassSignal(50, 0.1, 1.2)],
      ...WINDOW,
      selectionCounts: { kickCandidates: 1, bassCandidates: 1 },
    });
    expect(report.status).toBe("measured");
    // The analysis contract is "for every DETECTED onset" — the detector has
    // its own suite, so the expected count is derived from it, not assumed.
    const detected = detectTransients(kickSignal({ onsetsSec: onsets }, 1.2), SR, 1);
    expect(detected.length).toBeGreaterThanOrEqual(2);
    expect(report.measurement.detectedOnsets).toBe(detected.length);
    expect(report.measurement.analyzedOnsets).toBe(detected.length);
    expect(report.summary.riskCandidateOnsets).toBe(detected.length);
    expect(report.summary.overlapRate).toBe(1);
    for (const event of report.events) {
      expect(event.riskCandidate).toBe(true);
      expect(event.kick.dominantPeakHz).not.toBeNull();
      expect(Math.abs((event.kick.dominantPeakHz ?? 0) - 50)).toBeLessThan(15); // within one FFT bin
      expect(event.bass.bandDbfs.sub).toBeGreaterThan(-45); // continuous bass is loud in-band
    }
  });

  it("bass at 500 Hz shares NO low band — co-occurrence must stay empty, no risk", () => {
    const doc = docWithKickAndBass();
    const pair = pairFrom(doc);
    const report = analyzeKickBassRisk({
      doc,
      pair,
      kickMono: kickSignal({ onsetsSec: [0.1, 0.4] }, 1.2),
      bassChannels: [bassSignal(500, 0.2, 1.2)],
      ...WINDOW,
      selectionCounts: { kickCandidates: 1, bassCandidates: 1 },
    });
    expect(report.status).toBe("measured");
    expect(report.summary.sharedBandOnsets).toBe(0);
    expect(report.summary.riskCandidateOnsets).toBe(0);
    for (const event of report.events) {
      expect(event.sharedBands).toEqual([]);
      expect(event.riskCandidate).toBe(false);
      // The analyzer only scans 25–180 Hz, so a 500 Hz bass reads as a low
      // leakage floor — BELOW the candidate floor, i.e. nothing measurable.
      expect(event.bass.dominantPeakDbfs ?? -160).toBeLessThan(-45);
      expect(event.peakDistanceHz ?? Infinity).toBeGreaterThan(11); // far from the kick's ~50 Hz peak
    }
  });

  it("silent bass → nothing measurable, nothing claimed", () => {
    const doc = docWithKickAndBass();
    const pair = pairFrom(doc);
    const report = analyzeKickBassRisk({
      doc,
      pair,
      kickMono: kickSignal({ onsetsSec: [0.1, 0.4] }, 1.2),
      bassChannels: [bassSignal(null, 0, 1.2)],
      ...WINDOW,
      selectionCounts: { kickCandidates: 1, bassCandidates: 1 },
    });
    expect(report.summary.sharedBandOnsets).toBe(0);
    expect(report.summary.riskCandidateOnsets).toBe(0);
    for (const event of report.events) expect(event.riskCandidate).toBe(false);
  });

  it("the ±18 dB band gate holds even when the same-bin path fires: 34 dB quieter same-frequency bass", () => {
    const doc = docWithKickAndBass();
    const pair = pairFrom(doc);
    // kick 0.5 (≈ −9 dBFS band), bass 0.01 (≈ −43 dBFS band): both measurable,
    // difference ≈ 34 dB > 18 → the BAND path must refuse — but the bass peak
    // sits in the SAME bin as the kick's, so the independent close-peak path
    // still flags the co-occurrence. Both behaviours pinned separately.
    const report = analyzeKickBassRisk({
      doc,
      pair,
      kickMono: kickSignal({ onsetsSec: [0.1, 0.4], amplitude: 0.5 }, 1.2),
      bassChannels: [bassSignal(50, 0.01, 1.2)],
      ...WINDOW,
      selectionCounts: { kickCandidates: 1, bassCandidates: 1 },
    });
    const detected = detectTransients(kickSignal({ onsetsSec: [0.1, 0.4], amplitude: 0.5 }, 1.2), SR, 1);
    expect(report.summary.sharedBandOnsets).toBe(detected.length);
    expect(report.summary.closePeakOnsets).toBe(detected.length); // the same-bin path fired
    expect(report.summary.riskCandidateOnsets).toBe(detected.length); // risk = bands OR close peak
    for (const event of report.events) {
      expect(event.sharedBands.length).toBeGreaterThan(0);
      expect(event.riskCandidateBands).toEqual([]); // the band difference gate held
      expect(event.closePeakCandidate).toBe(true);
      expect(event.riskCandidate).toBe(true);
    }
  });

  it("a comparable bass level (14 dB down) IS a candidate — the gate has two sides", () => {
    const doc = docWithKickAndBass();
    const pair = pairFrom(doc);
    const report = analyzeKickBassRisk({
      doc,
      pair,
      kickMono: kickSignal({ onsetsSec: [0.1], amplitude: 0.5 }, 1.2),
      bassChannels: [bassSignal(50, 0.1, 1.2)],
      ...WINDOW,
      selectionCounts: { kickCandidates: 1, bassCandidates: 1 },
    });
    expect(report.summary.riskCandidateOnsets).toBe(1);
    expect(report.events[0]?.riskCandidateBands.length).toBeGreaterThan(0);
  });

  it("a silent kick stem reports no-kick-onsets and keeps the pair for the read-back", () => {
    const doc = docWithKickAndBass();
    const pair = pairFrom(doc);
    const report = analyzeKickBassRisk({
      doc,
      pair,
      kickMono: new Float32Array(Math.ceil(1.2 * SR)),
      bassChannels: [bassSignal(50, 0.1, 1.2)],
      ...WINDOW,
      selectionCounts: { kickCandidates: 1, bassCandidates: 1 },
    });
    expect(report.status).toBe("no-kick-onsets");
    expect(report.reason).toContain("no confident onsets");
    expect(report.pair).toEqual(pair);
    expect(report.events).toEqual([]);
  });

  it("onsets map back through the arrangement to ticks inside the window", () => {
    const doc = docWithKickAndBass();
    const pair = pairFrom(doc);
    const report = analyzeKickBassRisk({
      doc,
      pair,
      kickMono: kickSignal({ onsetsSec: [0.1, 0.4] }, 1.2),
      bassChannels: [bassSignal(50, 0.1, 1.2)],
      ...WINDOW,
      selectionCounts: { kickCandidates: 1, bassCandidates: 1 },
    });
    for (const event of report.events) {
      expect(event.tick).toBeGreaterThanOrEqual(WINDOW.startTick);
      expect(event.tick).toBeLessThanOrEqual(WINDOW.endTick);
    }
  });
});
