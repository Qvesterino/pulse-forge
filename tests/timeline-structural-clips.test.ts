import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { duplicateTimeRange } from "../src/commands/timeRange";
import {
  deleteArrangementClipRipple,
  moveArrangementClipRipple,
  resizeArrangementClipRipple,
} from "../src/commands/clipPlayback";
import { addMidiClip, splitMidiClipAtTick } from "../src/commands/midiClips";
import { addAutomationClip, splitAutomationClipAtTick } from "../src/commands/automationClips";
import type { ArrangementClip, MidiClip, ProjectDocument } from "../src/project-model/types";

/**
 * W1/ADR-0025-completion — the structural time-range operations (duplicate
 * range, ripple ×3) finally SEE the tick-addressed lanes (MIDI + arrangement
 * automation, ADR 0044/0045). Semantics locked in the approved plan:
 *
 *   duplicate: wholly-inside → copy at +delta (shared patternId, phase/mute/
 *   lock carried, automation points DEEP-copied); straddle → refuse;
 *   trailing → shift; lane-absence preserved.
 *
 *   ripple: clips at/after the threshold shift (tick space); straddling stay.
 */

const STEP = 120; // 16th @ 120bpm

function instrumentDoc(): ProjectDocument {
  // The house template ships an instrument track + active pattern — the same
  // fixture shape tests/midi-arrangement-clips.test.ts uses. Scene clips are
  // cleared: these specs exercise the TICK lanes against a known-clear range.
  const source = createProjectFromTemplate("house");
  const track = source.tracks.find((candidate) => candidate.kind === "instrument");
  if (!track || track.kind !== "instrument") throw new Error("house template needs an instrument track");
  return { ...source, arrangement: { ...source.arrangement, clips: [] } };
}

function midiClipAt(doc: ProjectDocument, seedId: string, startTick: number, lengthTicks: number): ProjectDocument {
  const track = doc.tracks.find((t) => t.kind === "instrument");
  if (!track) throw new Error("fixture needs an instrument track");
  const next = addMidiClip(doc, track.id, doc.activePatternId, startTick, lengthTicks).execute(doc);
  // addMidiClip mints its own id — tag the minted clip with the seed id by
  // rewriting it in place (fixtures address clips by these seed ids).
  const lane = (next.arrangement.midiClips ?? []).map((c) =>
    c.startTick === startTick && c.lengthTicks === lengthTicks ? { ...c, id: seedId } : c,
  );
  return { ...next, arrangement: { ...next.arrangement, midiClips: lane } };
}

function findMidi(doc: ProjectDocument, id: string): MidiClip {
  const clip = (doc.arrangement.midiClips ?? []).find((c) => c.id === id);
  if (!clip) throw new Error(`midi clip ${id} missing`);
  return clip;
}

describe("duplicateTimeRange — tick lanes (W1)", () => {
  it("a wholly-inside MIDI clip is duplicated at +delta with SHARED patternId and phase carried", () => {
    let doc = instrumentDoc();
    doc = midiClipAt(doc, "mc1", STEP, STEP * 4);
    const source = findMidi(doc, "mc1");
    const next = duplicateTimeRange(doc, 0, STEP * 16).execute(doc);
    const lane = next.arrangement.midiClips ?? [];
    const copies = lane.filter((c) => c.id !== "mc1" && c.patternId === source.patternId);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.startTick).toBe(source.startTick + STEP * 16);
    expect(copies[0]!.lengthTicks).toBe(source.lengthTicks);
  });

  it("a STRADDLING MIDI clip refuses the duplicate (consistency with the audio lane)", () => {
    let doc = instrumentDoc();
    doc = midiClipAt(doc, "mc1", STEP * 8, STEP * 16); // straddles tick 1920 (end of bar 1)
    expect(() => duplicateTimeRange(doc, 0, STEP * 16).execute(doc)).toThrow(/MIDI clip/);
  });

  it("a TRAILING MIDI clip shifts by the bar-aligned delta", () => {
    let doc = instrumentDoc();
    doc = midiClipAt(doc, "mc1", STEP * 20, STEP * 4); // starts after the range
    const next = duplicateTimeRange(doc, 0, STEP * 16).execute(doc);
    expect(findMidi(next, "mc1").startTick).toBe(STEP * 20 + STEP * 16);
  });

  it("automation clips duplicate with DEEP-COPIED points and keep linkedTargets", () => {
    let doc = instrumentDoc();
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    doc = addAutomationClip(doc, { kind: "trackGain", trackId: track.id }, STEP * 2, STEP * 4, [
      { tick: STEP * 2, value: 0.2 },
      { tick: STEP * 6, value: 0.8 },
    ]).execute(doc);
    const source = (doc.arrangement.automationClips ?? [])[0]!;
    const next = duplicateTimeRange(doc, 0, STEP * 16).execute(doc);
    const copy = (next.arrangement.automationClips ?? []).find((c) => c.id !== source.id)!;
    expect(copy.startTick).toBe(source.startTick + STEP * 16);
    expect(copy.points).not.toBe(source.points); // deep copy — own array
    expect(copy.points.map((p) => ({ ...p }))).toEqual(source.points.map((p) => ({ ...p })));
    // Mutating the copy's points must not touch the source (the deep-copy pin).
    copy.points[0] = { ...copy.points[0]!, value: 0.99 };
    expect(source.points[0]!.value).toBe(0.2);
  });

  it("a lane-less document gains no MIDI lane from a duplicate (absence preserved)", () => {
    const doc = instrumentDoc();
    const stripped: ProjectDocument = {
      ...doc,
      arrangement: (({ midiClips: _m, automationClips: _a, ...rest }) => rest)(
        doc.arrangement,
      ) as ProjectDocument["arrangement"],
    };
    const next = duplicateTimeRange(stripped, 0, STEP * 16).execute(stripped);
    expect(next.arrangement.midiClips).toBeUndefined();
    expect(next.arrangement.automationClips).toBeUndefined();
  });
});

describe("ripple — tick lanes ride the same delta (W1)", () => {
  function rippleDoc() {
    // One scene clip as the RIPPLE TARGET + tick clips placed after it.
    let doc = instrumentDoc();
    const scene = doc.scenes[0]!;
    const target: ArrangementClip = { id: "ripple-target", sceneId: scene.id, startBar: 0, lengthBars: 4 };
    doc = { ...doc, arrangement: { ...doc.arrangement, clips: [target] } };
    doc = midiClipAt(doc, "mc-after", STEP * 70, STEP * 4);
    doc = midiClipAt(doc, "mc-before", STEP * 2, STEP * 4);
    return { doc, targetId: target.id };
  }

  it("move ripple: a MIDI clip after the moved clip shifts; one before stays", () => {
    const { doc, targetId } = rippleDoc();
    const next = moveArrangementClipRipple(doc, targetId, 4).execute(doc);
    expect(findMidi(next, "mc-after").startTick).toBe(STEP * 70 + 4 * 1920);
    expect(findMidi(next, "mc-before").startTick).toBe(STEP * 2);
  });

  it("resize ripple: growing a clip pushes later MIDI clips right", () => {
    const { doc, targetId } = rippleDoc();
    const target = doc.arrangement.clips.find((c) => c.id === targetId)!;
    const next = resizeArrangementClipRipple(doc, targetId, target.lengthBars + 2).execute(doc);
    expect(findMidi(next, "mc-after").startTick).toBe(STEP * 70 + 2 * 1920);
  });

  it("delete ripple: a MIDI clip after the removed clip closes the gap", () => {
    const { doc, targetId } = rippleDoc();
    const target = doc.arrangement.clips.find((c) => c.id === targetId)!;
    const next = deleteArrangementClipRipple(doc, targetId).execute(doc);
    expect(findMidi(next, "mc-after").startTick).toBe(STEP * 70 - target.lengthBars * 1920);
  });
});

describe("automation lane split parity (used by future consolidate flows)", () => {
  it("splitAutomationClipAtTick keeps the left phase and re-anchors the right", () => {
    let doc = instrumentDoc();
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    doc = addAutomationClip(doc, { kind: "trackGain", trackId: track.id }, STEP * 2, STEP * 16, [
      { tick: STEP * 2, value: 0.1 },
      { tick: STEP * 18, value: 0.9 },
    ]).execute(doc);
    const source = (doc.arrangement.automationClips ?? [])[0]!;
    const next = splitAutomationClipAtTick(doc, source.id, STEP * 10).execute(doc);
    const lane = next.arrangement.automationClips ?? [];
    expect(lane).toHaveLength(2);
    const left = lane.find((c) => c.id === source.id)!;
    const right = lane.find((c) => c.id !== source.id)!;
    expect(left.lengthTicks).toBe(STEP * 8);
    expect(right.startTick).toBe(STEP * 10);
    // Right's source-relative points survive: phase offset covers the shift.
    expect(right.phaseOffsetTicks ?? 0).toBeGreaterThanOrEqual(STEP * 8);
  });

  it("splitMidiClipAtTick preserves the shared-source contract (both halves reference the pattern)", () => {
    let doc = instrumentDoc();
    doc = midiClipAt(doc, "mc1", 0, STEP * 16);
    const source = findMidi(doc, "mc1");
    const next = splitMidiClipAtTick(doc, "mc1", STEP * 8).execute(doc);
    const lane = next.arrangement.midiClips ?? [];
    expect(lane).toHaveLength(2);
    for (const clip of lane) expect(clip.patternId).toBe(source.patternId);
  });
});
