/**
 * docDelta — delta engine correctness + command round-trip safety.
 *
 * The delta engine powers `snapshot()` by converting full-document prev/next
 * pairs into id-anchored operation lists. This file verifies:
 *   1. Correctness of each operation type (set, del, ins, move)
 *   2. Reference-pruned delta computation (O(changes))
 *   3. Round-trip correctness for ALL snapshot-based commands
 *   4. Fallback safety: non-immutable command → legacy snapshot()
 */
import { describe, expect, it } from "vitest";
import { applyDocDelta, computeDocDelta, deepEqualRef } from "../src/commands/docDelta";
import {
  createScene,
  createPattern,
  duplicatePattern,
  deletePattern,
  renamePattern,
  setPatternLength,
  clearPattern,
  createDrumTrack,
  createInstrumentTrack,
  createGroupTrack,
  deleteTrack,
  addToGroup,
  removeFromGroup,
  renameScene,
  setScenePattern,
  setSceneIntensity,
  addArrangementClip,
  moveArrangementClip,
  resizeArrangementClip,
  deleteArrangementClip,
  duplicateArrangementClip,
  addAutomationLane,
  removeAutomationLane,
  addLfo,
  removeLfo,
  addMacroMapping,
  removeMacroMapping,
  setMasterConfig,
  setBpm,
  setProjectName,
  addNote,
  addEffect,
  removeEffect,
  moveEffect,
  setTrackPreset,
  setActivePattern,
  freezeTrack,
  unfreezeTrack,
  __resetSnapshotVerificationFallbacks,
  __snapshotVerificationFallbacks,
} from "../src/commands/commands";
import type { Command } from "../src/commands/types";
import type { ProjectDocument } from "../src/project-model/types";
import {
  activePatternOf,
  commandHarness,
  deterministicTestDoc,
  drumTrackOf,
  instTrackOf,
  testDoc,
} from "./fixtures/doc";

// ─── Harness ────────────────────────────────────────────────────────────────

const house = testDoc;
const drum = drumTrackOf;
const inst = instTrackOf;

function roundTrip(cmd: Command, doc: ProjectDocument): void {
  const result = cmd.execute(doc);
  const back = cmd.undo(result);
  expect(deepEqualRef(back, doc)).toBe(true);
  expect(deepEqualRef(result, doc)).toBe(false);
}

// ─── 1. Engine correctness ──────────────────────────────────────────────────

describe("docDelta — primitive values", () => {
  it("set on scalar at root", () => {
    const a = { ...house(), bpm: 120 };
    const b = { ...a, bpm: 140 };
    const delta = computeDocDelta(a, b);
    expect(delta.ops.length).toBe(1);
    expect(applyDocDelta(a, delta.ops)).toEqual(b);
    const inv = computeDocDelta(b, a);
    expect(applyDocDelta(b, inv.ops)).toEqual(a);
  });

  it("set on nested scalar (timeSignature.numerator)", () => {
    const a = house();
    const b = { ...a, timeSignature: { ...a.timeSignature, numerator: 6 } };
    const delta = computeDocDelta(a, b);
    expect(delta.ops.length).toBe(1);
    expect(applyDocDelta(a, delta.ops)).toEqual(b);
  });

  it("del on key (e.g. removing 'key')", () => {
    const a = { ...house(), key: "C Major" as const };
    const b = { ...a } as ProjectDocument;
    delete (b as any).key;
    const delta = computeDocDelta(a, b);
    expect(delta.ops.some((op) => op.k === "del")).toBe(true);
    expect(applyDocDelta(a, delta.ops)).toEqual(b);
    const inv = computeDocDelta(b, a);
    expect(applyDocDelta(b, inv.ops)).toEqual(a);
  });
});

describe("docDelta — entity arrays", () => {
  it("add entity to empty array", () => {
    const a = { ...house(), markers: [] as any[] };
    const marker = { id: "m1", name: "X", type: "cue" as const, tick: 0 };
    const b = { ...a, markers: [marker] };
    const delta = computeDocDelta(a, b);
    expect(delta.ops.length).toBeGreaterThan(0);
    expect(applyDocDelta(a, delta.ops)).toEqual(b);
  });

  it("remove entity from array", () => {
    const marker = { id: "m1", name: "X", type: "cue" as const, tick: 0 };
    const a = { ...house(), markers: [marker] };
    const b = { ...a, markers: [] };
    const delta = computeDocDelta(a, b);
    expect(delta.ops.some((op) => op.k === "del")).toBe(true);
    expect(applyDocDelta(a, delta.ops)).toEqual(b);
  });

  it("reorder entities by move ops", () => {
    const m1 = { id: "m1", name: "A", type: "cue" as const, tick: 0 };
    const m2 = { id: "m2", name: "B", type: "cue" as const, tick: 100 };
    const a = { ...house(), markers: [m1, m2] };
    const b = { ...a, markers: [m2, m1] };
    const delta = computeDocDelta(a, b);
    expect(delta.ops.some((op) => op.k === "move")).toBe(true);
    expect(applyDocDelta(a, delta.ops)).toEqual(b);
  });

  it("entity field change (only the changed entity is touched)", () => {
    const a = house();
    const b = { ...a, tracks: a.tracks.map((t) => (t.id === drum(a).id ? { ...t, name: "KICK" } : t)) };
    const delta = computeDocDelta(a, b);
    expect(delta.ops.length).toBeLessThan(5);
    expect(applyDocDelta(a, delta.ops)).toEqual(b);
  });
});

describe("docDelta — nested arrays (rows, points, notes)", () => {
  it("number array cell change", () => {
    const a = house();
    const padId = drum(a).pads[0].id;
    const pattern = activePatternOf(a);
    const row = [...pattern.rows[padId]];
    row[3] = 0.9;
    const b = {
      ...a,
      patterns: a.patterns.map((p) => (p.id === pattern.id ? { ...p, rows: { ...p.rows, [padId]: row } } : p)),
    };
    const delta = computeDocDelta(a, b);
    expect(delta.ops.length).toBe(1);
    expect(applyDocDelta(a, delta.ops)).toEqual(b);
  });

  it("automation points array change", () => {
    const a = { ...house(), automation: [] };
    const lane = {
      id: "lane-1",
      target: { kind: "trackGain" as const, trackId: drum(a).id },
      points: [{ tick: 0, value: 0.5 }],
    };
    const b = { ...a, automation: [lane] };
    const delta = computeDocDelta(a, b);
    expect(applyDocDelta(a, delta.ops)).toEqual(b);
    const inv = computeDocDelta(b, a);
    expect(applyDocDelta(b, inv.ops)).toEqual(a);
  });
});

describe("docDelta — deepEqualRef", () => {
  it("structural equality vs reference", () => {
    expect(deepEqualRef(1, 1)).toBe(true);
    expect(deepEqualRef({ a: 1 }, { a: 1 })).toBe(true);
    expect(deepEqualRef([1, 2], [1, 2])).toBe(true);
    expect(deepEqualRef(1, 2)).toBe(false);
    expect(deepEqualRef([1], [1, 2])).toBe(false);
  });
});

describe("docDelta — idempotent empty delta", () => {
  it("identical docs produce zero ops", () => {
    const a = house();
    const delta = computeDocDelta(a, a);
    expect(delta.ops).toHaveLength(0);
    expect(applyDocDelta(a, delta.ops)).toBe(a); // same reference
  });
});

// ─── 2. Command round-trip battery ──────────────────────────────────────────

describe("snapshot commands — execute/undo round-trip", () => {
  it("createPattern", () => {
    const doc = house();
    roundTrip(createPattern(doc, "New Pattern"), doc);
  });
  it("duplicatePattern", () => {
    const doc = house();
    roundTrip(duplicatePattern(doc, doc.patterns[0].id), doc);
  });
  it("deletePattern", () => {
    const doc = house();
    const withPat = createPattern(doc, "Del Me").execute(doc);
    roundTrip(deletePattern(withPat, withPat.patterns[1].id), withPat);
  });
  it("renamePattern", () => {
    const doc = house();
    roundTrip(renamePattern(doc, doc.patterns[0].id, "Renamed"), doc);
  });
  it("setPatternLength", () => {
    const doc = house();
    roundTrip(setPatternLength(doc, doc.patterns[0].id, 32), doc);
  });
  it("clearPattern", () => {
    const doc = house();
    roundTrip(clearPattern(doc, doc.patterns[0].id), doc);
  });
  it("createDrumTrack", () => {
    const doc = house();
    roundTrip(createDrumTrack(doc), doc);
  });
  it("createInstrumentTrack", () => {
    const doc = house();
    roundTrip(createInstrumentTrack(doc, "bass"), doc);
  });
  it("createGroupTrack", () => {
    const doc = house();
    roundTrip(createGroupTrack(doc), doc);
  });
  it("deleteTrack", () => {
    const doc = house();
    const withDrum = createDrumTrack(doc).execute(doc);
    roundTrip(deleteTrack(withDrum, withDrum.tracks[withDrum.tracks.length - 1].id), withDrum);
  });
  it("addToGroup", () => {
    const doc = house();
    const withGroup = createGroupTrack(doc).execute(doc);
    roundTrip(addToGroup(withGroup, drum(withGroup).id, withGroup.tracks[withGroup.tracks.length - 1].id), withGroup);
  });
  it("removeFromGroup", () => {
    const doc = house();
    const withGroup = createGroupTrack(doc).execute(doc);
    const groupId = withGroup.tracks[withGroup.tracks.length - 1].id;
    const grouped = addToGroup(withGroup, drum(withGroup).id, groupId).execute(withGroup);
    roundTrip(removeFromGroup(grouped, drum(grouped).id), grouped);
  });
  it("createScene", () => {
    const doc = house();
    roundTrip(createScene(doc, "Test Scene"), doc);
  });
  it("renameScene", () => {
    const doc = house();
    roundTrip(renameScene(doc, doc.scenes[0].id, "New Name"), doc);
  });
  it("setScenePattern", () => {
    const doc = house();
    const scene = doc.scenes[0];
    const withPat = createPattern(doc, "Pat B").execute(doc);
    roundTrip(setScenePattern(withPat, scene.id, withPat.patterns[1].id), withPat);
  });
  it("setSceneIntensity", () => {
    const doc = house();
    roundTrip(setSceneIntensity(doc, doc.scenes[0].id, 0.5), doc);
  });
  it("addArrangementClip", () => {
    const doc = house();
    roundTrip(addArrangementClip(doc, doc.scenes[0].id, 10, 2), doc);
  });
  it("moveArrangementClip", () => {
    const doc = house();
    const withClip = addArrangementClip(doc, doc.scenes[0].id, 10, 2).execute(doc);
    const clipId = withClip.arrangement.clips.find((c) => c.startBar === 10)!.id;
    roundTrip(moveArrangementClip(withClip, clipId, 20), withClip);
  });
  it("resizeArrangementClip", () => {
    const doc = house();
    const withClip = addArrangementClip(doc, doc.scenes[0].id, 10, 2).execute(doc);
    const clipId = withClip.arrangement.clips.find((c) => c.startBar === 10)!.id;
    roundTrip(resizeArrangementClip(withClip, clipId, 6), withClip);
  });
  it("deleteArrangementClip", () => {
    const doc = house();
    const withClip = addArrangementClip(doc, doc.scenes[0].id, 10, 2).execute(doc);
    const clipId = withClip.arrangement.clips.find((c) => c.startBar === 10)!.id;
    roundTrip(deleteArrangementClip(withClip, clipId), withClip);
  });
  it("duplicateArrangementClip", () => {
    const doc = house();
    const withClip = addArrangementClip(doc, doc.scenes[0].id, 10, 2).execute(doc);
    const clipId = withClip.arrangement.clips.find((c) => c.startBar === 10)!.id;
    roundTrip(duplicateArrangementClip(withClip, clipId), withClip);
  });
  it("addAutomationLane", () => {
    const doc = house();
    roundTrip(addAutomationLane(doc, { kind: "trackGain", trackId: drum(doc).id }), doc);
  });
  it("removeAutomationLane", () => {
    const doc = house();
    const withLane = addAutomationLane(doc, { kind: "trackGain", trackId: drum(doc).id }).execute(doc);
    roundTrip(removeAutomationLane(withLane, withLane.automation[0].id), withLane);
  });
  it("addLfo", () => {
    const doc = house();
    roundTrip(addLfo(doc, drum(doc).id), doc);
  });
  it("removeLfo", () => {
    const doc = house();
    const withLfo = addLfo(doc, drum(doc).id).execute(doc);
    roundTrip(removeLfo(withLfo, withLfo.lfos[0].id), withLfo);
  });
  it("addMacroMapping", () => {
    const doc = house();
    roundTrip(addMacroMapping(doc, doc.macros[0].id, drum(doc).id, "gain"), doc);
  });
  it("removeMacroMapping", () => {
    const doc = house();
    const withMap = addMacroMapping(doc, doc.macros[0].id, drum(doc).id, "gain").execute(doc);
    roundTrip(removeMacroMapping(withMap, withMap.macros[0].id, withMap.macros[0].mappings[0].id), withMap);
  });
  it("setMasterConfig", () => {
    const doc = house();
    roundTrip(setMasterConfig(doc, { masterGain: 1.2 }), doc);
  });
  it("setBpm", () => {
    const doc = house();
    roundTrip(setBpm(doc, 140), doc);
  });
  it("setProjectName", () => {
    const doc = house();
    roundTrip(setProjectName(doc, "New Name"), doc);
  });
  it("addEffect", () => {
    const doc = house();
    roundTrip(addEffect(doc, drum(doc).id, "eq"), doc);
  });
  it("removeEffect", () => {
    const doc = house();
    const withFx = addEffect(doc, drum(doc).id, "eq").execute(doc);
    roundTrip(
      removeEffect(withFx, drum(withFx).id, withFx.tracks.find((t) => t.id === drum(withFx).id)!.effects[0].id),
      withFx,
    );
  });
  it("moveEffect", () => {
    const doc = house();
    const withFx = addEffect(doc, drum(doc).id, "eq").execute(doc);
    const withFx2 = addEffect(withFx, drum(withFx).id, "delay").execute(withFx);
    const fxId = withFx2.tracks.find((t) => t.id === drum(withFx2).id)!.effects[0].id;
    roundTrip(moveEffect(withFx2, drum(withFx2).id, fxId, 1), withFx2);
  });
  it("setActivePattern", () => {
    const doc = house();
    const withPat = createPattern(doc, "Pat B").execute(doc);
    // Switch to the FIRST pattern (Pat B is currently active after createPattern).
    roundTrip(setActivePattern(withPat, withPat.patterns[0].id), withPat);
  });
  it("freezeTrack", () => {
    const doc = house();
    roundTrip(freezeTrack(doc, drum(doc).id, "buf-1", 30, 44100), doc);
  });
  it("unfreezeTrack", () => {
    const doc = house();
    const frozen = freezeTrack(doc, drum(doc).id, "buf-1", 30, 44100).execute(doc);
    roundTrip(unfreezeTrack(frozen, drum(frozen).id), frozen);
  });
  it("setTrackPreset", () => {
    const doc = house();
    roundTrip(setTrackPreset(doc, inst(doc).id, "preset-1"), doc);
  });
});

describe("snapshot commands — every cmd actually changes the document", () => {
  it("structural commands produce a new document AND use the delta path (no legacy fallbacks)", () => {
    // Two invariants in one battery:
    //   1. Every command changes the doc (catches vacuous-verification bugs —
    //      a command that mutates prev in place would no-op here).
    //   2. ZERO snapshot() calls fall back to the legacy whole-document
    //      command — if the delta engine ever fails self-verification for a
    //      real command shape, this assertion surfaces it immediately.
    __resetSnapshotVerificationFallbacks();
    const fallbacksBefore = __snapshotVerificationFallbacks();
    const doc = house();
    const withPat = createPattern(doc, "X").execute(doc);
    const withExtraDrum = createDrumTrack(withPat).execute(withPat);
    const withExtraInst = createInstrumentTrack(withExtraDrum, "bass").execute(withExtraDrum);
    const withExtraGroup = createGroupTrack(withExtraInst).execute(withExtraInst);
    const extraDrumId = withExtraDrum.tracks[withExtraDrum.tracks.length - 1].id;
    const extraInstId = withExtraInst.tracks[withExtraInst.tracks.length - 1].id;
    const extraGroupId = withExtraGroup.tracks[withExtraGroup.tracks.length - 1].id;
    const newPatId = withPat.patterns[withPat.patterns.length - 1].id;
    const grouped = addToGroup(withExtraGroup, extraDrumId, extraGroupId).execute(withExtraGroup);

    // Each entry: [name, command, the doc it was created from]
    const cases: Array<[string, Command, ProjectDocument]> = [
      ["createPattern", createPattern(doc, "X2"), doc],
      ["duplicatePattern", duplicatePattern(doc, doc.patterns[0].id), doc],
      ["deletePattern", deletePattern(withPat, newPatId), withPat],
      ["renamePattern", renamePattern(doc, doc.patterns[0].id, "Y"), doc],
      ["setPatternLength", setPatternLength(doc, doc.patterns[0].id, 32), doc],
      ["clearPattern", clearPattern(doc, doc.patterns[0].id), doc],
      ["createDrumTrack", createDrumTrack(doc), doc],
      ["createInstrumentTrack", createInstrumentTrack(doc, "bass"), doc],
      ["createGroupTrack", createGroupTrack(doc), doc],
      ["deleteTrack", deleteTrack(withExtraGroup, extraDrumId), withExtraGroup],
      ["createScene", createScene(doc, "S"), doc],
      ["renameScene", renameScene(doc, doc.scenes[0].id, "R"), doc],
      ["setSceneIntensity", setSceneIntensity(doc, doc.scenes[0].id, 0.2), doc],
      ["addArrangementClip", addArrangementClip(doc, doc.scenes[0].id, 10, 1), doc],
      ["addAutomationLane", addAutomationLane(doc, { kind: "trackGain", trackId: drum(doc).id }), doc],
      ["addLfo", addLfo(doc, drum(doc).id), doc],
      ["addMacroMapping", addMacroMapping(doc, doc.macros[0].id, drum(doc).id, "gain"), doc],
      ["setMasterConfig", setMasterConfig(doc, { masterGain: 0.5 }), doc],
      ["setBpm", setBpm(doc, 200), doc],
      ["setProjectName", setProjectName(doc, "Changed"), doc],
      ["addEffect", addEffect(doc, drum(doc).id, "eq"), doc],
      ["addNote", addNote(doc, inst(doc).id, { pitch: 60, start: 0, duration: 120, velocity: 0.8 }), doc],
      ["addToGroup", addToGroup(withExtraGroup, extraDrumId, extraGroupId), withExtraGroup],
      ["removeFromGroup", removeFromGroup(grouped, extraDrumId), grouped],
      ["setTrackPreset", setTrackPreset(withExtraGroup, extraInstId, "preset-1"), withExtraGroup],
      ["freezeTrack", freezeTrack(doc, drum(doc).id, "buf-1", 30, 44100), doc],
    ];
    for (const [name, cmd, d] of cases) {
      const result = cmd.execute(d);
      expect(result, `${name}: execute should change the doc`).not.toBe(d);
    }
    expect(
      __snapshotVerificationFallbacks(),
      "every snapshot command must pass delta self-verification (fallback counter must stay at zero)",
    ).toBe(fallbacksBefore);
  });
});

describe("snapshot commands — fallback safety", () => {
  it("in-place mutation produces no delta ops (triggers legacy fallback in snapshot)", () => {
    // If a command mutates prev in-place, computeDocDelta sees no diffs
    // (prev===next by reference) — self-verification in snapshot() passes
    // vacuously. This test documents the invariant: NO command in the codebase
    // mutates prev. The round-trip battery above is the real guardrail.
    const doc = house();
    const mutated = doc;
    (mutated as any).bpm = 999; // in-place mutation
    const delta = computeDocDelta(doc, mutated);
    expect(delta.ops).toHaveLength(0); // no diffs detected
    expect(applyDocDelta(doc, delta.ops)).toBe(doc); // same reference
    // Clean up — reset the mutation.
    (mutated as any).bpm = 120;
  });
});

describe("fixtures — testDoc / commandHarness / deterministic ids", () => {
  it("testDoc has an empty arrangement (clips can be placed anywhere)", () => {
    const doc = testDoc();
    expect(doc.arrangement.clips).toHaveLength(0);
    // Bar 0 placement works — the house template's bar-0 clip is gone.
    const result = addArrangementClip(doc, doc.scenes[0].id, 0, 1).execute(doc);
    expect(result.arrangement.clips).toHaveLength(1);
  });

  it("harness keeps build-from and execute-on the same doc by construction", () => {
    // Regression for the whole class of "command created from instance A,
    // executed on instance B" test bugs — the harness makes it impossible.
    const h = commandHarness();
    h.run(setBpm(h.doc, 140));
    h.run(renamePattern(h.doc, h.doc.patterns[0].id, "Harness"));
    expect(h.doc.bpm).toBe(140);
    expect(h.doc.patterns[0].name).toBe("Harness");
    h.undo();
    expect(h.doc.patterns[0].name).not.toBe("Harness");
    h.undo();
    expect(h.doc.bpm).not.toBe(140);
  });

  it("deterministic ids align across instances — cross-instance commands work", () => {
    const a = deterministicTestDoc();
    const b = deterministicTestDoc();
    // Same construction order → same ids → a command built from `a` applies
    // cleanly to `b` (useful for snapshot-diff and round-trip fixtures).
    expect(drumTrackOf(a).id).toBe(drumTrackOf(b).id);
    expect(a.patterns[0].id).toBe(b.patterns[0].id);
    const result = renamePattern(a, a.patterns[0].id, "Aligned").execute(b);
    expect(result.patterns[0].name).toBe("Aligned");
  });
});
