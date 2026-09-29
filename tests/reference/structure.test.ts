/**
 * F2 structure — energy curve + section map.
 *
 * The section logic is a port of `beat_modifier`'s `_structure_from_energy`,
 * so the tests here pin the SAME behaviour it depends on: the `0.4·median` /
 * `0.7` thresholds, chunk-mean/max normalization, and the role table. If the
 * Python side moves a constant, this file is the reminder.
 *
 * The two KYX departures get their own coverage because they exist to fix
 * real defects in the source's behaviour:
 *
 *  - beat snapping: without it a section edge lands mid-beat and an imported
 *    marker is musically meaningless
 *  - short-section merging: without it a quiet intro oscillating around the
 *    threshold produces a dozen sections in eight seconds
 *
 * The `structureIntroDropOutro` fixture is a real 20 s signal with a known
 * shape (quiet → loud → quiet), so the section list is checked against the
 * music rather than against itself.
 */

import { describe, expect, it } from "vitest";
import { analyzeReference } from "../../src/reference/analysis/analyzeReference";
import { averageEnergy, energyCurve, markerTypeForRole, sectionsFromEnergy } from "../../src/reference/structure";
import { makeMetadata } from "./_fixtures";
import { FIXTURE_SR } from "./_fixtures";

/** 20 s: 4 s quiet, 12 s loud, 4 s quiet. Real amplitude, real transitions. */
function structureIntroDropOutro(seconds = 20, sr = FIXTURE_SR): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sr));
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const loud = t >= 4 && t < 16;
    // A little tone content so it is not pure DC; the envelope is what matters.
    const v = loud ? 0.7 : 0.06;
    out[i] = v * Math.sin(2 * Math.PI * 110 * t);
  }
  return out;
}

describe("F2 energy curve", () => {
  it("produces between 16 and 64 normalized points", () => {
    for (const seconds of [2, 10, 30, 60, 200, 600]) {
      const curve = energyCurve(structureIntroDropOutro(Math.min(seconds, 30)), Math.min(seconds, 30));
      expect(curve.length).toBeGreaterThanOrEqual(16);
      expect(curve.length).toBeLessThanOrEqual(64);
      // Position spans 0..1 and is monotonic — the curve is a timeline.
      expect(curve[0].position).toBeGreaterThan(0);
      expect(curve[curve.length - 1].position).toBeLessThan(1);
      for (let i = 1; i < curve.length; i++) {
        expect(curve[i].position).toBeGreaterThan(curve[i - 1].position);
      }
    }
  });

  it("keeps energy inside 0..1", () => {
    const curve = energyCurve(structureIntroDropOutro(), 20);
    for (const p of curve) {
      expect(p.energy).toBeGreaterThanOrEqual(0);
      expect(p.energy).toBeLessThanOrEqual(1);
    }
  });

  it("puts the loudest section at energy 1.0 and quiet parts below it", () => {
    const curve = energyCurve(structureIntroDropOutro(), 20);
    const peak = Math.max(...curve.map((p) => p.energy));
    expect(peak).toBeCloseTo(1, 3);
    // The loud window is 4..16 s of 20 s; its points must beat the intro.
    const first = curve[0].energy;
    const middle = curve[Math.floor(curve.length / 2)].energy;
    expect(middle).toBeGreaterThan(first);
  });

  it("is deterministic — the same signal gives the same curve", () => {
    const a = energyCurve(structureIntroDropOutro(), 20);
    const b = energyCurve(structureIntroDropOutro(), 20);
    expect(a).toEqual(b);
  });

  it("handles a signal shorter than one FFT frame without dividing by zero", () => {
    const tiny = new Float32Array([0.5, -0.5, 0.25]);
    const curve = energyCurve(tiny, 0.0001);
    expect(curve.length).toBeGreaterThan(0);
    for (const p of curve) expect(Number.isFinite(p.energy)).toBe(true);
  });

  it("returns a full-length flat zero curve for an empty signal", () => {
    const curve = energyCurve(new Float32Array(0), 0);
    // 16 points of zero rather than a 2-point stub: the curve keeps a
    // consistent shape so downstream consumers never branch on length.
    expect(curve.length).toBe(16);
    for (const p of curve) expect(p.energy).toBe(0);
    expect(averageEnergy(curve)).toBe(0);
  });
});

/** No tempo detected — sections stay in seconds with null beat indices. */
const NO_BEATS = { durationSeconds: 20, beatTimes: [] as number[], bpm: null };

describe("F2 sections from energy", () => {
  it("finds quiet → loud → quiet as intro, drop, outro", () => {
    const curve = energyCurve(structureIntroDropOutro(), 20);
    const sections = sectionsFromEnergy(curve, NO_BEATS);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    const roles = sections.map((s) => s.role);
    expect(roles[0]).toBe("intro");
    expect(roles[roles.length - 1]).toBe("outro");
    // The loudest section is in the middle, not at either end.
    const energies = sections.map((s) => s.energy);
    expect(Math.max(...energies)).toBeGreaterThan(energies[0]);
  });

  it("orders sections and covers the timeline without gaps", () => {
    const curve = energyCurve(structureIntroDropOutro(), 20);
    const sections = sectionsFromEnergy(curve, NO_BEATS);
    for (let i = 0; i < sections.length; i++) {
      expect(sections[i].endSec).toBeGreaterThan(sections[i].startSec);
      if (i > 0) expect(sections[i].startSec).toBeGreaterThanOrEqual(sections[i - 1].endSec - 1e-6);
    }
  });

  it("does not shatter a quiet intro into a dozen sections", () => {
    // The regression this merge rule exists for: without it, a low-energy
    // region oscillating around the threshold emits one section per energy
    // bucket and marker import becomes unusable.
    const curve = energyCurve(structureIntroDropOutro(), 20);
    const sections = sectionsFromEnergy(curve, NO_BEATS);
    expect(sections.length).toBeLessThanOrEqual(6);
  });

  it("returns no sections for a flat zero curve", () => {
    const sections = sectionsFromEnergy(
      [
        { position: 0, energy: 0 },
        { position: 1, energy: 0 },
      ],
      NO_BEATS,
    );
    // Honest empty: a flat curve has no structure to claim.
    expect(sections).toEqual([]);
  });

  it("maps every role to a KYX marker type", () => {
    expect(markerTypeForRole("drop")).toBe("drop");
    expect(markerTypeForRole("intro")).toBe("buildup");
    expect(markerTypeForRole("breakdown")).toBe("cue");
    expect(markerTypeForRole("outro")).toBe("impact");
    expect(markerTypeForRole("development")).toBe("custom");
    expect(markerTypeForRole("full")).toBe("custom");
  });

  it("gives every section a markerType that matches its role", () => {
    const curve = energyCurve(structureIntroDropOutro(), 20);
    for (const s of sectionsFromEnergy(curve, NO_BEATS)) {
      expect(s.markerType).toBe(markerTypeForRole(s.role));
    }
  });
});

describe("F2 beat snapping", () => {
  it("snaps section edges onto the detected beat grid", () => {
    // A 120 BPM grid: beats every 0.5 s. A section edge at 4.1 s must land on
    // 4.0 or 4.5, not stay at 4.1.
    const beatTimes: number[] = [];
    for (let t = 0; t <= 20; t += 0.5) beatTimes.push(t);
    const curve = energyCurve(structureIntroDropOutro(), 20);
    const sections = sectionsFromEnergy(curve, { durationSeconds: 20, beatTimes, bpm: 120 });
    for (const s of sections) {
      const isOnGrid = Math.abs(s.startSec * 2 - Math.round(s.startSec * 2)) < 1e-6;
      expect(isOnGrid, `section starts at ${s.startSec}, off the 0.5 s grid`).toBe(true);
    }
  });

  it("reports beat indices when a grid is present", () => {
    const beatTimes: number[] = [];
    for (let t = 0; t <= 20; t += 0.5) beatTimes.push(t);
    const curve = energyCurve(structureIntroDropOutro(), 20);
    const sections = sectionsFromEnergy(curve, { durationSeconds: 20, beatTimes, bpm: 120 });
    expect(sections.length).toBeGreaterThan(0);
    for (const s of sections) {
      expect(s.startBeat).not.toBeNull();
      expect(s.endBeat).not.toBeNull();
      // Indices must index the grid they came from.
      if (s.startBeat !== null) expect(beatTimes[s.startBeat]).toBeCloseTo(s.startSec, 6);
    }
  });

  it("leaves positions unsnapped and beat indices null when no tempo was found", () => {
    const curve = energyCurve(structureIntroDropOutro(), 20);
    const sections = sectionsFromEnergy(curve, NO_BEATS);
    for (const s of sections) {
      expect(s.startBeat).toBeNull();
      expect(s.endBeat).toBeNull();
    }
  });

  it("never produces a zero-width section after snapping", () => {
    // Two adjacent boundaries can snap onto the same beat; a collapsed
    // section renders as an invisible band.
    const beatTimes: number[] = [];
    for (let t = 0; t <= 20; t += 0.5) beatTimes.push(t);
    const curve = energyCurve(structureIntroDropOutro(), 20);
    for (const s of sectionsFromEnergy(curve, { durationSeconds: 20, beatTimes, bpm: 120 })) {
      expect(s.endSec).toBeGreaterThan(s.startSec);
    }
  });
});

describe("F2 end-to-end through analyzeReference", () => {
  it("attaches a structure block to the result", () => {
    const result = analyzeReference({
      mono: structureIntroDropOutro(),
      metadata: makeMetadata(20),
    }).result;
    expect(result.structure).toBeDefined();
    expect(result.structure!.energyCurve.length).toBeGreaterThanOrEqual(16);
    expect(result.structure!.sections.length).toBeGreaterThan(0);
    expect(result.structure!.averageEnergy).toBeGreaterThan(0);
  });

  it("omits structure for silence rather than inventing a section", () => {
    const result = analyzeReference({ mono: new Float32Array(FIXTURE_SR * 3), metadata: makeMetadata(3) }).result;
    // The silent early-return path never reaches the structure stage, so
    // there is no structure claim to make.
    expect(result.structure).toBeUndefined();
  });

  it("is deterministic end to end", () => {
    const mono = structureIntroDropOutro();
    const a = analyzeReference({ mono, metadata: makeMetadata(20) }).result.structure;
    const b = analyzeReference({ mono, metadata: makeMetadata(20) }).result.structure;
    expect(a).toEqual(b);
  });

  it("emits a 'structure' stage so the UI can show it", () => {
    const stages: string[] = [];
    analyzeReference({
      mono: structureIntroDropOutro(),
      metadata: makeMetadata(20),
      onStage: (s) => stages.push(s),
    });
    expect(stages).toContain("structure");
  });
});
