import { describe, expect, it } from "vitest";
import {
  analyzeArrangementCensus,
  measureArrangementCensusEnergy,
  type EnergyBuffer,
} from "../../src/analysis/arrangement-census";
import { arrangementSecondsBetweenTicks } from "../../src/project-model/scene-time";
import { ticksPerBar } from "../../src/project-model/schema";
import type { DrumTrack, Pattern, ProjectDocument } from "../../src/project-model/types";
import { testDoc } from "../fixtures/doc";

/**
 * E6 gate — the arrangement repetition census against known content.
 *
 * The census is the observation layer for "why does my track feel static",
 * so its licence depends on three answers being RIGHT:
 *
 * 1. identical CORE CONTENT under different pattern UUIDs must collide on one
 *    fingerprint (the whole point: repetition hides behind fresh ids);
 * 2. a one-step content difference must NOT collide (no false "same");
 * 3. the per-pattern metrics must be exact on a pattern whose counts a human
 *    can verify by hand.
 *
 * The audio-energy layer is measured against constant-amplitude segments
 * whose RMS is analytic (0.5 → −6.02 dBFS, 0.05 → −26.02 dBFS). No vitest
 * spec renders audio; the buffer is synthetic, the expectations are exact.
 */

const BASS_NOTE_A = { id: "note-a1", pitch: 36, start: 0, duration: 120, velocity: 0.5 };
const BASS_NOTE_B = { id: "note-a2", pitch: 48, start: 120, duration: 120, velocity: 0.9 };

function basePattern(doc: ProjectDocument, pattern: Pattern): void {
  const drums = doc.tracks.find((track): track is DrumTrack => track.kind === "drum")!;
  const bass = doc.tracks.find((track) => track.kind === "instrument" && track.name === "808")!;
  pattern.stepCount = 16;
  pattern.rows = { [drums.pads[0]!.id]: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0, 0] };
  pattern.notes = { [bass.id]: [structuredClone(BASS_NOTE_A), structuredClone(BASS_NOTE_B)] };
}

/** Two scenes, two patterns, byte-equal content, different UUIDs, two clips. */
function docWithRepeatedContent(): ProjectDocument {
  const doc = structuredClone(testDoc());
  doc.bpm = 120; // 2.000 s per bar — analytic sample math for the energy layer
  const sceneA = structuredClone(doc.scenes[0]!);
  basePattern(doc, doc.patterns[0]!);

  const patternB: Pattern = structuredClone(doc.patterns[0]!);
  patternB.id = "pattern-b";
  doc.patterns.push(patternB);
  const sceneB = { ...sceneA, id: "scene-b", name: "Drop B", patternId: patternB.id, role: "drop" as const };
  doc.scenes.push(sceneB);

  doc.arrangement.clips = [
    { id: "clip-a", sceneId: sceneA.id, startBar: 0, lengthBars: 4 },
    { id: "clip-b", sceneId: sceneB.id, startBar: 4, lengthBars: 4 },
  ];
  return doc;
}

function fingerprintOfFirstClip(doc: ProjectDocument): string {
  const census = analyzeArrangementCensus(doc);
  expect(census.clips[0]?.fingerprint).not.toBeNull();
  return census.clips[0]!.fingerprint!;
}

describe("arrangement census fingerprints (E6)", () => {
  it("identical content under DIFFERENT pattern UUIDs collides on one fingerprint", () => {
    const doc = docWithRepeatedContent();
    const census = analyzeArrangementCensus(doc);
    expect(census.clips).toHaveLength(2);
    expect(census.clips[0]!.fingerprint).toBe(census.clips[1]!.fingerprint);
    expect(census.counts.uniquePatterns).toBe(1);
    expect(census.counts.repeatedGroups).toBe(1);
    expect(census.counts.repeatedOccurrences).toBe(2);
    expect(census.clips[1]!.relationToPrevious).toBe("same-content");
    const group = census.repeatedPatterns[0]!;
    expect(group.occurrences).toBe(2);
    expect(group.patternIds).toHaveLength(2); // two DISTINCT pattern ids, one content truth
  });

  it("one changed step breaks the collision — no false 'same-content'", () => {
    const doc = docWithRepeatedContent();
    doc.patterns[1]!.rows = { ...doc.patterns[1]!.rows };
    const drums = doc.tracks.find((track): track is DrumTrack => track.kind === "drum")!;
    const rows = { ...doc.patterns[1]!.rows };
    rows[drums.pads[0]!.id] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0.9, 0]; // one extra ghost hit
    doc.patterns[1]!.rows = rows;
    const census = analyzeArrangementCensus(doc);
    expect(census.clips[0]!.fingerprint).not.toBe(census.clips[1]!.fingerprint);
    expect(census.counts.repeatedGroups).toBe(0);
    expect(census.clips[1]!.relationToPrevious).toBe("different-content");
    expect(census.clips[1]!.changeFromPrevious?.drumHitsPerBar).toBe(1); // 6 vs 5 hits per bar
  });

  it("the fingerprint is UUID-FREE: renaming pads (same order) changes nothing", () => {
    const doc = docWithRepeatedContent();
    const before = fingerprintOfFirstClip(doc);
    const renamed = structuredClone(doc);
    const drums = renamed.tracks.find((track): track is DrumTrack => track.kind === "drum")!;
    const oldId = drums.pads[0]!.id;
    drums.pads[0] = { ...drums.pads[0]!, id: "pad-renamed" };
    for (const pattern of renamed.patterns) {
      const rows = pattern.rows ?? {};
      if (rows[oldId]) {
        const { [oldId]: values, ...rest } = rows;
        pattern.rows = { ...rest, "pad-renamed": values };
      }
    }
    expect(fingerprintOfFirstClip(renamed)).toBe(before);
  });

  it("stepCount participates: the same rows at a different length are different content", () => {
    const doc = docWithRepeatedContent();
    doc.patterns[1]!.stepCount = 32;
    const census = analyzeArrangementCensus(doc);
    expect(census.clips[0]!.fingerprint).not.toBe(census.clips[1]!.fingerprint);
    expect(census.clips[1]!.metrics?.patternBars).toBe(2); // 32 steps = 2 bars
  });

  it("authored stepMeta (microtiming) changes the fingerprint; doc-level groove does not exist here", () => {
    const doc = docWithRepeatedContent();
    const drums = doc.tracks.find((track): track is DrumTrack => track.kind === "drum")!;
    doc.patterns[1]!.stepMeta = { [drums.pads[0]!.id]: { 0: { microtiming: -0.5 } } };
    const census = analyzeArrangementCensus(doc);
    expect(census.clips[0]!.fingerprint).not.toBe(census.clips[1]!.fingerprint);
  });
});

describe("arrangement census metrics (hand-verifiable counts)", () => {
  it("drum hits, notes, pitch span, velocity mean/range/SD are exact", () => {
    const doc = docWithRepeatedContent();
    const census = analyzeArrangementCensus(doc);
    const metrics = census.clips[0]!.metrics!;
    expect(metrics.patternBars).toBe(1);
    expect(metrics.drumHits).toBe(5); // four downbeats + one 0.5 ghost
    expect(metrics.drumHitsPerBar).toBe(5);
    expect(metrics.melodicNotes).toBe(2);
    expect(metrics.notesPerBar).toBe(2);
    expect(metrics.pitchMin).toBe(36);
    expect(metrics.pitchMax).toBe(48);
    expect(metrics.velocityMean).toBe(0.7);
    expect(metrics.velocityRange).toEqual([0.5, 0.9]);
    expect(metrics.velocityStdDev).toBe(0.2);
    // Only the explicitly authored role is reported — never name inference.
    expect(census.clips[1]!.authoredRole).toBe("drop");
  });

  it("window clipping keeps only overlapping clips", () => {
    const doc = docWithRepeatedContent();
    const barTicks = ticksPerBar(doc);
    const census = analyzeArrangementCensus(doc, { startTick: barTicks * 6, endTick: barTicks * 20 });
    expect(census.counts.clipsInScope).toBe(1);
    expect(census.clips[0]!.clipId).toBe("clip-b");
    expect(census.clips[0]!.range.startTick).toBe(barTicks * 6); // clamped into the window
  });

  it("malformed clips are skipped, revision passes through", () => {
    const doc = docWithRepeatedContent();
    doc.arrangement.clips.push({
      id: "clip-broken",
      sceneId: doc.scenes[0]!.id,
      startBar: -2,
      lengthBars: 0,
    });
    const census = analyzeArrangementCensus(doc, null, 4123);
    expect(census.clips.map((clip) => clip.clipId)).not.toContain("clip-broken");
    expect(census.projectRevision).toBe(4123);
  });
});

describe("arrangement census energy (analytic RMS)", () => {
  it("per-clip RMS is exact and the delta chain is honest", () => {
    const doc = docWithRepeatedContent();
    const census = analyzeArrangementCensus(doc);
    const SR = 44100;
    const barTicks = ticksPerBar(doc);
    const secondsOf = (tick: number) =>
      arrangementSecondsBetweenTicks(doc.arrangement.clips, doc.scenes, 0, tick, doc.bpm, barTicks);
    // The scenes may pin their own BPM — the segment boundary comes from the
    // SAME tempo map the energy resolver uses, never from an assumed 2 s bar.
    const boundary = Math.round(secondsOf(barTicks * 4) * SR);
    const tail = Math.ceil((secondsOf(barTicks * 8) + 1) * SR);
    // ONE mono content in both channels — the energy layer averages channels
    // by design, so a loud-L/quiet-R fake would measure the average.
    const mixed = new Float32Array(tail);
    mixed.fill(0.5, 0, boundary);
    mixed.fill(0.05, boundary);
    const buffer: EnergyBuffer = {
      sampleRate: SR,
      numberOfChannels: 2,
      getChannelData: () => mixed,
    };
    const measured = measureArrangementCensusEnergy(census, buffer, (startTick, endTick) => {
      return {
        startSample: Math.round(secondsOf(startTick) * SR),
        endSample: Math.round(secondsOf(endTick) * SR),
      };
    });
    expect(measured.energy.status).toBe("measured");
    expect(measured.clips[0]!.energy?.rmsDbfs).toBeCloseTo(-6.02, 1);
    expect(measured.clips[1]!.energy?.rmsDbfs).toBeCloseTo(-26.02, 1);
    expect(measured.clips[1]!.energy?.deltaRmsDbFromPrevious).toBeCloseTo(-20, 1);
    expect(measured.clips[0]!.energy?.deltaRmsDbFromPrevious).toBeNull(); // no previous — honest null
    expect(measured.clips[1]!.energy?.sampleRate).toBe(SR);
  });
});
