import { describe, expect, it } from "vitest";
import { addArrangementClip, createVariationAndPlaceClip } from "../src/commands/arrangement";
import { appendCapturedArrangement, createArrangementSkeleton } from "../src/commands/arrangementShapes";
import { addMarker, moveMarker } from "../src/commands/markers";
import { setSceneIntensityCurve } from "../src/commands/clipPlayback";
import { consolidateTimeRange, duplicateTimeRange } from "../src/commands/timeRange";
import { addEffect, duplicateTrack } from "../src/commands/tracks";
import { addNote } from "../src/commands/notes";
import { addAudioTakeClip } from "../src/commands/audioClips";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { MAX_ARRANGEMENT_CLIP_BARS } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import type { ProjectDocument } from "../src/project-model/types";
import { BAR_TICKS } from "../src/project-model/types";

/**
 * Ultra editor hardening (2026-10-06) — model-level regression coverage.
 * Every behavior pinned here contradicts a removed defect found by sweeping
 * the command layer against the editor invariants (§2/§8/§27/§28/§32):
 *
 *  - duplicateTrack: instrument clones silently started with EMPTY note lanes
 *    (drum clones cloned their rows) and the automation family stayed on the
 *    original track while the clone's effects got fresh ids.
 *  - createVariationAndPlaceClip / appendCapturedArrangement / addArrangementClip:
 *    NaN or over-MAX geometry wrote a clip normalize silently DROPPED — the
 *    variation path also minted an orphan scene+pattern that survived.
 *  - createArrangementSkeleton / consolidateTimeRange: replaced clips left
 *    stale marker.linkedClipId refs behind (deleteArrangementClip unlinks).
 *  - duplicateTimeRange: a copied marker kept the ORIGINAL clip's link instead
 *    of following the clip copy into the zone.
 *  - addMarker/moveMarker/setSceneIntensityCurve: NaN ticks/offsets passed
 *    Math.max clamps and silently landed at 0 on the next normalize.
 */

function emptyArrangementDoc(): ProjectDocument {
  const base = createProjectFromTemplate("house");
  return { ...base, arrangement: { ...base.arrangement, clips: [] } };
}

/* ---------------- duplicateTrack: content + automation follow the clone ---------------- */

function instrumentDocWithAutomation(): { doc: ProjectDocument; trackId: string; fxId: string | null } {
  let doc = createProjectFromTemplate("house");
  const inst = doc.tracks.find((t) => t.kind === "instrument");
  if (!inst) throw new Error("house template has no instrument track");
  doc = addNote(doc, inst.id, { pitch: 60, start: 0, duration: 480, velocity: 0.8 }).execute(doc);
  doc = addNote(doc, inst.id, { pitch: 64, start: 960, duration: 240, velocity: 0.6 }).execute(doc);
  let fxId: string | null = null;
  if (inst.effects.length === 0) {
    doc = addEffect(doc, inst.id, "delay").execute(doc);
    fxId = doc.tracks.find((t) => t.id === inst.id)!.effects[0]!.id;
  } else {
    fxId = inst.effects[0]!.id;
  }
  doc = {
    ...doc,
    automation: [
      {
        id: "lane-src",
        target: { kind: "fxParam", trackId: inst.id, fxId: fxId!, paramId: "mix" },
        points: [
          { tick: 0, value: 0.25 },
          { tick: 480, value: 0.75 },
        ],
      },
    ],
    sceneAutomation: [
      {
        id: "sa-src",
        sceneId: doc.scenes[0]!.id,
        target: { kind: "trackPan", trackId: inst.id },
        points: [{ tick: 0, value: -0.5 }],
      },
    ],
    lfos: [{ id: "lfo-src", trackId: inst.id, param: "gain", amount: 0.3 }],
    macros: [
      {
        id: "mac-src",
        name: "M",
        value: 0.5,
        mappings: [{ id: "map-src", trackId: inst.id, param: "gain", amount: 0.5 }],
      },
    ],
  };
  return { doc, trackId: inst.id, fxId };
}

describe("duplicateTrack carries the track's content and automation (§8/§28)", () => {
  it("instrument clone gets its own note lanes; original untouched", () => {
    const { doc, trackId } = instrumentDocWithAutomation();
    const sourcePattern = doc.patterns.find((p) => p.id === doc.activePatternId)!;
    const originalNotes = sourcePattern.notes?.[trackId] ?? [];
    expect(originalNotes.length).toBeGreaterThanOrEqual(2); // template seeds + our two
    const next = duplicateTrack(doc, trackId).execute(doc);
    const clone = next.tracks.find((t) => t.name === `${doc.tracks.find((t) => t.id === trackId)!.name} copy`);
    expect(clone).toBeDefined();
    expect(clone!.id).not.toBe(trackId);

    const pattern = next.patterns.find((p) => p.id === next.activePatternId)!;
    const clonedNotes = pattern.notes?.[clone!.id];
    // Pre-fix: clonedNotes was undefined — a duplicated synth played nothing.
    expect(clonedNotes).toBeDefined();
    expect(clonedNotes!.length).toBe(originalNotes.length);
    expect((pattern.notes?.[trackId] ?? []).length).toBe(originalNotes.length);
    // Independent mutable state: fresh note ids, distinct array, same content.
    expect(clonedNotes!.map((n) => n.id)).not.toEqual(originalNotes.map((n) => n.id));
    expect(clonedNotes).not.toBe(originalNotes);
    expect(clonedNotes!.map((n) => n.pitch)).toEqual(originalNotes.map((n) => n.pitch));
    expect(clonedNotes!.map((n) => n.start)).toEqual(originalNotes.map((n) => n.start));
  });

  it("automation lanes, scene automation, LFOs and macro mappings are cloned onto the new ids", () => {
    const { doc, trackId, fxId } = instrumentDocWithAutomation();
    const next = duplicateTrack(doc, trackId).execute(doc);
    const clone = next.tracks.find((t) => t.id !== trackId && t.kind === "instrument")!;

    const clonedLanes = next.automation.filter((lane) => lane.target.trackId === clone.id);
    expect(clonedLanes.length).toBe(1);
    expect(clonedLanes[0]!.id).not.toBe("lane-src");
    expect(clonedLanes[0]!.points.length).toBe(2);
    expect(clonedLanes[0]!.points).not.toBe(doc.automation[0]!.points);
    // The fx the lane targets is the CLONE's effect, not the original's.
    expect(clonedLanes[0]!.target.fxId).toBeDefined();
    expect(clonedLanes[0]!.target.fxId).not.toBe(fxId);
    expect(clone.effects.some((fx) => fx.id === clonedLanes[0]!.target.fxId)).toBe(true);
    // Original lane still targets the original track/fx.
    expect(next.automation.some((lane) => lane.id === "lane-src")).toBe(true);

    const clonedSceneAutomation = next.sceneAutomation.filter((entry) => entry.target.trackId === clone.id);
    expect(clonedSceneAutomation.length).toBe(1);
    expect(clonedSceneAutomation[0]!.id).not.toBe("sa-src");

    const clonedLfos = next.lfos.filter((lfo) => lfo.trackId === clone.id);
    expect(clonedLfos.length).toBe(1);
    expect(clonedLfos[0]!.id).not.toBe("lfo-src");
    expect(clonedLfos[0]!.amount).toBe(0.3);

    const macro = next.macros.find((m) => m.id === "mac-src")!;
    expect(macro.mappings.length).toBe(2);
    expect(macro.mappings.some((m) => m.trackId === trackId)).toBe(true);
    expect(macro.mappings.some((m) => m.trackId === clone.id)).toBe(true);
  });

  it("undo restores the pre-duplicate document exactly", () => {
    const { doc, trackId } = instrumentDocWithAutomation();
    const preNotes = doc.patterns.find((p) => p.id === doc.activePatternId)!.notes?.[trackId] ?? [];
    const store = new ProjectStore(doc);
    store.execute(duplicateTrack(doc, trackId));
    expect(store.getDoc().tracks.length).toBe(doc.tracks.length + 1);
    store.undo();
    const restored = store.getDoc();
    expect(restored.tracks.length).toBe(doc.tracks.length);
    expect(restored.automation.length).toBe(1);
    expect(restored.lfos.length).toBe(1);
    expect(restored.sceneAutomation.length).toBe(1);
    expect(restored.macros[0]!.mappings.length).toBe(1);
    const pattern = restored.patterns.find((p) => p.id === restored.activePatternId)!;
    expect(Object.keys(pattern.notes ?? {})).not.toContain(
      restored.tracks.find((t) => t.name.endsWith(" copy"))?.id ?? "__none__",
    );
    expect((pattern.notes?.[trackId] ?? []).length).toBe(preNotes.length);
  });
});

/* ---------------- placement guards: NaN / MAX on every clip-writing path ---------------- */

describe("clip placement NaN/MAX guards (§32)", () => {
  it("createVariationAndPlaceClip with NaN geometry places a finite clip, not an orphan scene", () => {
    const doc = emptyArrangementDoc();
    const sceneId = doc.scenes[0]!.id;
    const next = createVariationAndPlaceClip(doc, sceneId, Number.NaN, Number.NaN).execute(doc);
    // Pre-fix: normalize DROPPED the NaN clip while the minted scene+pattern
    // survived — success toast, empty timeline, orphan content.
    expect(next.arrangement.clips.length).toBe(1);
    const clip = next.arrangement.clips[0]!;
    expect(Number.isFinite(clip.startBar)).toBe(true);
    expect(clip.startBar).toBe(0);
    expect(Number.isFinite(clip.lengthBars)).toBe(true);
    expect(clip.lengthBars).toBe(1);
    expect(next.scenes.length).toBe(doc.scenes.length + 1);
    expect(next.patterns.length).toBe(doc.patterns.length + 1);
  });

  it("createVariationAndPlaceClip and addArrangementClip clamp length to MAX_ARRANGEMENT_CLIP_BARS", () => {
    const doc = emptyArrangementDoc();
    const sceneId = doc.scenes[0]!.id;
    const placed = addArrangementClip(doc, sceneId, 0, 1_000_000).execute(doc);
    // Pre-fix: normalize FILTERS over-length clips — the add "succeeded" but
    // nothing landed. Clamped here, the stored clip is one normalize keeps.
    expect(placed.arrangement.clips.length).toBe(1);
    expect(placed.arrangement.clips[0]!.lengthBars).toBe(MAX_ARRANGEMENT_CLIP_BARS);

    const doc2 = emptyArrangementDoc();
    const varied = createVariationAndPlaceClip(doc2, doc2.scenes[0]!.id, 0, 1_000_000).execute(doc2);
    expect(varied.arrangement.clips[0]!.lengthBars).toBe(MAX_ARRANGEMENT_CLIP_BARS);
  });

  it("appendCapturedArrangement sanitizes NaN capture entries instead of silently dropping them", () => {
    const doc = emptyArrangementDoc();
    const sceneId = doc.scenes[0]!.id;
    const next = appendCapturedArrangement(doc, [{ sceneId, startBar: Number.NaN, lengthBars: Number.NaN }]).execute(
      doc,
    );
    expect(next.arrangement.clips.length).toBe(1);
    const clip = next.arrangement.clips[0]!;
    expect(clip.startBar).toBe(0);
    expect(clip.lengthBars).toBe(1);
    expect(Number.isFinite(clip.startBar)).toBe(true);
    expect(Number.isFinite(clip.lengthBars)).toBe(true);
  });
});

/* ---------------- marker integrity across structural edits (§27) ---------------- */

describe("marker links survive clip replacement and zone duplication (§27)", () => {
  it("createArrangementSkeleton unlinks markers of the clips it replaces", () => {
    let doc = emptyArrangementDoc();
    const roles = ["intro", "build", "drop", "break", "outro"] as const;
    doc = {
      ...doc,
      scenes: [...doc.scenes, ...roles.map((role, i) => ({ ...doc.scenes[0]!, id: `role-sc-${i}`, name: role, role }))],
    };
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
    const replacedClipId = doc.arrangement.clips[0]!.id;
    doc = addMarker(doc, { tick: 2 * BAR_TICKS, linkedClipId: replacedClipId }).execute(doc);

    const next = createArrangementSkeleton(doc).execute(doc);
    // The skeleton REPLACES every clip; the marker must not keep a dead link
    // (same contract as deleteArrangementClip).
    expect(next.arrangement.clips.some((c) => c.id === replacedClipId)).toBe(false);
    expect(next.markers.length).toBe(1);
    expect(next.markers[0]!.linkedClipId).toBeUndefined();
  });

  it("consolidateTimeRange unlinks markers of the consolidated clips", () => {
    let doc = emptyArrangementDoc();
    const inst = doc.tracks.find((t) => t.kind === "instrument")!;
    doc = addNote(doc, inst.id, { pitch: 60, start: 0, duration: 480, velocity: 0.8 }).execute(doc);
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
    const replacedClipId = doc.arrangement.clips[0]!.id;
    doc = addMarker(doc, { tick: 2 * BAR_TICKS, linkedClipId: replacedClipId }).execute(doc);

    const next = consolidateTimeRange(doc, 0, 4 * BAR_TICKS).execute(doc);
    expect(next.arrangement.clips.some((c) => c.id === replacedClipId)).toBe(false);
    expect(next.markers[0]!.linkedClipId).toBeUndefined();
  });

  it("duplicateTimeRange: the copied marker links the COPIED clip, trailing links stay put", () => {
    let doc = emptyArrangementDoc();
    const sceneId = doc.scenes[0]!.id;
    doc = addArrangementClip(doc, sceneId, 0, 4).execute(doc);
    doc = addArrangementClip(doc, sceneId, 6, 4).execute(doc);
    const inside = doc.arrangement.clips.find((c) => c.startBar === 0)!;
    const trailing = doc.arrangement.clips.find((c) => c.startBar === 6)!;
    doc = addMarker(doc, { tick: 2 * BAR_TICKS, linkedClipId: inside.id }).execute(doc);
    doc = addMarker(doc, { tick: 7 * BAR_TICKS, linkedClipId: trailing.id }).execute(doc);

    const next = duplicateTimeRange(doc, 0, 4 * BAR_TICKS).execute(doc);
    const clipCopy = next.arrangement.clips.find((c) => c.startBar === 4 && c.id !== inside.id);
    expect(clipCopy).toBeDefined();
    // Copy of the inside marker lands at 2 bars + 4-bar delta and follows the
    // clip COPY (pre-fix it kept the original's id and navigated back).
    const markerCopy = next.markers.find((m) => m.tick === 6 * BAR_TICKS);
    expect(markerCopy).toBeDefined();
    expect(markerCopy!.linkedClipId).toBe(clipCopy!.id);
    // Original marker + link untouched.
    const original = next.markers.find((m) => m.tick === 2 * BAR_TICKS)!;
    expect(original.linkedClipId).toBe(inside.id);
    // Trailing marker shifted with its clip (same id) — link unchanged.
    const shifted = next.markers.find((m) => m.tick === 11 * BAR_TICKS)!;
    expect(shifted.linkedClipId).toBe(trailing.id);
    expect(next.arrangement.clips.find((c) => c.id === trailing.id)!.startBar).toBe(10);
  });
});

/* ---------------- numeric guards on marker/curve commands (§32) ---------------- */

describe("NaN tick/offset guards (§32)", () => {
  it("addMarker maps a non-finite tick to 0 instead of writing NaN", () => {
    const doc = createProjectFromTemplate("house");
    const next = addMarker(doc, { tick: Number.NaN }).execute(doc);
    const marker = next.markers[next.markers.length - 1]!;
    expect(marker.tick).toBe(0);
    expect(Number.isFinite(marker.tick)).toBe(true);
  });

  it("moveMarker refuses a non-finite tick (no-op) instead of teleporting to 0", () => {
    let doc = createProjectFromTemplate("house");
    doc = addMarker(doc, { tick: 3 * BAR_TICKS }).execute(doc);
    const markerId = doc.markers[doc.markers.length - 1]!.id;
    const next = moveMarker(doc, markerId, Number.NaN).execute(doc);
    expect(next.markers.find((m) => m.id === markerId)!.tick).toBe(3 * BAR_TICKS);
  });

  it("setSceneIntensityCurve clamps a non-finite offset to 0", () => {
    const doc = createProjectFromTemplate("house");
    const sceneId = doc.scenes[0]!.id;
    const next = setSceneIntensityCurve(doc, sceneId, [
      { offset: Number.NaN, value: 0.5 },
      { offset: 240, value: 0.8 },
    ]).execute(doc);
    const curve = next.scenes.find((s) => s.id === sceneId)!.intensityCurve!;
    expect(curve.length).toBe(2);
    expect(curve[0]!.offset).toBe(0);
    expect(curve.every((p) => Number.isFinite(p.offset) && Number.isFinite(p.value))).toBe(true);
  });
});

/* ---------------- take-lane comp source survives a track-level view (sanity) ---------------- */

describe("audio take group integrity under selection-free edits (§9/§28)", () => {
  it("addAudioTakeClip keeps take groups single-track and clips addressable", () => {
    let doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind !== "group")!;
    doc = addAudioTakeClip(doc, "grp-1", "take-1", track.id, "buf-a", 0, 8).execute(doc);
    doc = addAudioTakeClip(doc, "grp-1", "take-2", track.id, "buf-b", 0, 8).execute(doc);
    expect(doc.arrangement.takeGroups!.length).toBe(1);
    const groupClips = (doc.arrangement.audioClips ?? []).filter((c) => c.takeGroupId === "grp-1");
    expect(groupClips.length).toBe(2);
    expect(groupClips.every((c) => c.trackId === track.id)).toBe(true);
    expect(new Set(groupClips.map((c) => c.takeId)).size).toBe(2);
  });
});
