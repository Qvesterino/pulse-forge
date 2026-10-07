/**
 * Edit-tools interaction audit — geometry & references pass.
 *
 * Regression coverage for the defects fixed in this audit:
 *
 *  S1 stripSilenceAudioClip placed fragments against raw `offsetSec`,
 *     ignoring trimStart / stretchRate / the scene-pinned tempo, never
 *     bounded fragments to the clip's audible window, and let every fragment
 *     share the parent's warpMarkers array via the `...clip` spread.
 *  S2 sliceAudioClipToArrangement wrote offsetSec without trimStart and
 *     without the wall→source stretch conversion, and advanced the placement
 *     cursor by unrounded lengths (drift).
 *  U1 updateAudioClip stored patch.warpMarkers by reference.
 *  Z1 duplicateTimeRange shifted scene clips by fractional bars for
 *     tick-quantized (marquee) ranges, dropped phase/scene offsets on the
 *     copies, and could land a copy on a boundary-straddling clip
 *     (no-overlap lane violation).
 *  M1 deleting a clip (or a track with clips) left marker.linkedClipId
 *     dangling in every save.
 *  F1 sanitizeAudioClips let fades longer than the clip survive a load.
 *
 * Follow-up wave (deferred-risk resolution):
 *  R2 the in-command fade clamps now bound at the scene-pinned tempo too
 *     (audioClipDurationSec/clampClipFades/updateAudioClip) — previously only
 *     the load-time sanitize was scene-aware.
 *  R3 fitAudioClipTempo fits against the tempo the transport runs at the
 *     clip (scene pin), and marker cue routing semantics are pinned.
 *  R4 strip-silence on take-lane clips keeps take identity (comp fragments
 *     stay audible; inactive-take fragments stay silent) — pinned, not changed.
 *
 * Plus probes for gaps found by the audit: split at the exact end tick,
 * repeated-move fixed points, and a stress chain over the new paths.
 */
import { describe, expect, it } from "vitest";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import { BAR_TICKS, PPQ } from "../src/project-model/types";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";
import { audioClipsForPlayback } from "../src/project-model/audio-takes";
import { markerCueTrackId } from "../src/project-model/markers";
import {
  addArrangementClip,
  addAudioClip,
  addAudioTakeClip,
  addMarker,
  compAudioTakeRange,
  deleteArrangementClip,
  deleteArrangementClipRipple,
  deleteAudioClip,
  deleteTrack,
  duplicateAudioClip,
  duplicateTimeRange,
  fitAudioClipTempo,
  moveAudioClip,
  moveArrangementClip,
  resizeAudioClip,
  setSceneBpm,
  sliceAudioClipToArrangement,
  splitAudioClipAtTick,
  stripSilenceAudioClip,
  updateAudioClip,
} from "../src/commands/commands";

function clipDurationSec(doc: ProjectDocument, clip: AudioClip): number {
  return (clip.lengthBars * BAR_TICKS * 60) / (doc.bpm * PPQ);
}

function secPerBar(doc: ProjectDocument): number {
  return (BAR_TICKS * 60) / (doc.bpm * PPQ);
}

/** House template + one audio clip built through the real command. */
function audioDoc(
  lengthBars: number,
  patch: Parameters<typeof updateAudioClip>[2] = {},
): { doc: ProjectDocument; clipId: string; trackId: string } {
  let doc = createDefaultProject();
  const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
  doc = addAudioClip(doc, trackId, "buf-audit", 0, lengthBars).execute(doc);
  const clipId = doc.arrangement.audioClips![0]!.id;
  if (Object.keys(patch).length > 0) doc = updateAudioClip(doc, clipId, patch).execute(doc);
  return { doc, clipId, trackId };
}

describe("stripSilenceAudioClip — geometry (S1)", () => {
  it("anchors fragment placement at the audible window start (trimStart honored)", () => {
    // 2-bar clip, first 2s of source trimmed away: a segment at source 2s is
    // the FIRST thing this clip plays → fragment must land at the clip start.
    const { doc, clipId } = audioDoc(2, { trimStart: 2 });
    const next = stripSilenceAudioClip(doc, clipId, [{ startSec: 2, endSec: 3 }]).execute(doc);
    const frag = next.arrangement.audioClips![0]!;
    expect(frag.startBar).toBeCloseTo(0, 9);
    expect(frag.offsetSec).toBe(2);
    expect(frag.trimStart).toBe(0);
    // 1s of source at the project tempo.
    expect(frag.lengthBars).toBeCloseTo(1 / secPerBar(doc), 2);
  });

  it("drops segments that live entirely in the trimmed-away region", () => {
    const { doc, clipId } = audioDoc(2, { trimStart: 2 });
    const next = stripSilenceAudioClip(doc, clipId, [
      { startSec: 0, endSec: 1 },
      { startSec: 2, endSec: 3 },
    ]).execute(doc);
    expect(next.arrangement.audioClips).toHaveLength(1);
    expect(next.arrangement.audioClips![0]!.offsetSec).toBe(2);
  });

  it("bounds fragments to the clip's window (sourceDurationSec − trimEnd)", () => {
    // 8-bar clip; window ends at source 6s (trimEnd 4 of a 10s buffer).
    const { doc, clipId } = audioDoc(8, { trimEnd: 4 });
    const next = stripSilenceAudioClip(doc, clipId, [{ startSec: 5, endSec: 9 }], 10).execute(doc);
    const frag = next.arrangement.audioClips![0]!;
    expect(frag.offsetSec).toBe(5);
    // Clamped to [5, 6]: 1s of source.
    expect(frag.lengthBars).toBeCloseTo(1 / secPerBar(doc), 2);
  });

  it("scales fragment wall length by the resample rate", () => {
    // rate 2 = 2 source seconds per wall second: a 2s segment plays for 1s.
    const { doc, clipId } = audioDoc(4, { stretchRate: 2 });
    const next = stripSilenceAudioClip(doc, clipId, [{ startSec: 0, endSec: 2 }]).execute(doc);
    expect(next.arrangement.audioClips![0]!.lengthBars).toBeCloseTo(1 / secPerBar(doc), 2);
  });

  it("uses the scene-pinned tempo for placement and length", () => {
    let doc = createDefaultProject();
    doc = setSceneBpm(doc, doc.scenes[0]!.id, 240).execute(doc);
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    doc = addAudioClip(doc, trackId, "buf-audit", 0, 4).execute(doc);
    const clipId = doc.arrangement.audioClips![0]!.id;
    const next = stripSilenceAudioClip(doc, clipId, [{ startSec: 0.25, endSec: 0.75 }]).execute(doc);
    const frag = next.arrangement.audioClips![0]!;
    // At 240bpm one bar = 1s of wall time: 0.25s in = bar 0.25, span 0.5 bars.
    expect(frag.startBar).toBeCloseTo(0.25, 6);
    expect(frag.lengthBars).toBeCloseTo(0.5, 6);
  });

  it("fragments never carry (or share) the parent's warpMarkers", () => {
    const { doc, clipId } = audioDoc(4, {
      warpMarkers: [
        { timeSec: 0.1, tick: 240 },
        { timeSec: 0.5, tick: 960 },
      ],
    });
    const next = stripSilenceAudioClip(doc, clipId, [
      { startSec: 0, endSec: 1 },
      { startSec: 2, endSec: 3 },
    ]).execute(doc);
    for (const frag of next.arrangement.audioClips!) {
      expect(frag.warpMarkers).toBeUndefined();
    }
  });

  it("refuses reversed and looping clips instead of misplacing fragments", () => {
    const reversed = audioDoc(2, { reverse: true });
    expect(() => stripSilenceAudioClip(reversed.doc, reversed.clipId, [{ startSec: 0, endSec: 1 }])).toThrow(
      /reversed/i,
    );
    const looped = audioDoc(2, { loop: true });
    expect(() => stripSilenceAudioClip(looped.doc, looped.clipId, [{ startSec: 0, endSec: 1 }])).toThrow(/looping/i);
  });

  it("a segment covering the whole window is a no-op and refuses", () => {
    const { doc, clipId } = audioDoc(2);
    const full = clipDurationSec(doc, doc.arrangement.audioClips![0]!);
    expect(() => stripSilenceAudioClip(doc, clipId, [{ startSec: 0, endSec: full }])).toThrow(/No silence/i);
  });

  it("undo restores the exact pre-strip document", () => {
    const { doc, clipId } = audioDoc(4, { trimStart: 1 });
    const command = stripSilenceAudioClip(doc, clipId, [
      { startSec: 1, endSec: 2 },
      { startSec: 3, endSec: 4 },
    ]);
    const next = command.execute(doc);
    expect(command.undo(next)).toEqual(doc);
  });
});

describe("sliceAudioClipToArrangement — source windows & placement (S2)", () => {
  it("honors trimStart: slices play the region the clip played", () => {
    // Window starts at source 2s (offset 1 + trim 1). Slicing at wall 8s must
    // consume source 2+8=10s, not 1+8=9s.
    const { doc, clipId } = audioDoc(8, { offsetSec: 1, trimStart: 1 });
    const next = sliceAudioClipToArrangement(doc, clipId, [8]).execute(doc);
    const slices = next.arrangement.audioClips!.filter((c) => c.id !== clipId).sort((a, b) => a.startBar - b.startBar);
    expect(slices[0]!.offsetSec).toBeCloseTo(2, 6);
    expect(slices[1]!.offsetSec).toBeCloseTo(10, 6);
    expect(slices[1]!.trimStart).toBe(0);
  });

  it("scales source advance by the resample rate", () => {
    // rate 2: 8 wall seconds consume 16 source seconds.
    const { doc, clipId } = audioDoc(8, { stretchRate: 2 });
    const next = sliceAudioClipToArrangement(doc, clipId, [8]).execute(doc);
    const slices = next.arrangement.audioClips!.filter((c) => c.id !== clipId).sort((a, b) => a.startBar - b.startBar);
    expect(slices[1]!.offsetSec).toBeCloseTo(16, 6);
  });

  it("places slices at exact 0.25-bar gaps with no accumulation drift", () => {
    // 0.61s wall = 0.305 bars → stored 0.31; the NEXT clip must sit exactly
    // 0.25 bars after the stored end, not after the unrounded one.
    const { doc, clipId } = audioDoc(8);
    const next = sliceAudioClipToArrangement(doc, clipId, [0.61, 3]).execute(doc);
    const slices = next.arrangement.audioClips!.filter((c) => c.id !== clipId).sort((a, b) => a.startBar - b.startBar);
    expect(slices.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < slices.length; i++) {
      const gap = slices[i]!.startBar - (slices[i - 1]!.startBar + slices[i - 1]!.lengthBars);
      expect(gap).toBeCloseTo(0.25, 9);
    }
  });

  it("refuses reversed and looping clips", () => {
    const reversed = audioDoc(4, { reverse: true });
    expect(() => sliceAudioClipToArrangement(reversed.doc, reversed.clipId, [1])).toThrow(/reversed/i);
    const looped = audioDoc(4, { loop: true });
    expect(() => sliceAudioClipToArrangement(looped.doc, looped.clipId, [1])).toThrow(/looping/i);
  });
});

describe("updateAudioClip — no shared mutable state (U1)", () => {
  it("clones patch.warpMarkers: mutating the caller's array cannot rewrite the doc", () => {
    const { doc, clipId } = audioDoc(4);
    const markers = [{ timeSec: 0.5, tick: 960 }];
    const next = updateAudioClip(doc, clipId, { warpMarkers: markers }).execute(doc);
    markers[0]!.tick = 4321;
    markers.push({ timeSec: 9, tick: 9999 });
    const stored = next.arrangement.audioClips![0]!.warpMarkers!;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tick).toBe(960);
  });
});

describe("duplicateTimeRange — zone geometry (Z1)", () => {
  function zoneDoc(): { doc: ProjectDocument; insideId: string; trailingId: string; sceneId: string } {
    let doc = createDefaultProject();
    const sceneId = doc.scenes[0]!.id;
    // Template clip occupies bars 0–4; add B@4(2) and D@8(2).
    doc = addArrangementClip(doc, sceneId, 4, 2).execute(doc);
    doc = addArrangementClip(doc, sceneId, 8, 2).execute(doc);
    const insideId = doc.arrangement.clips.find((c) => c.startBar === 4)!.id;
    const trailingId = doc.arrangement.clips.find((c) => c.startBar === 8)!.id;
    return { doc, insideId, trailingId, sceneId };
  }

  it("a tick-quantized marquee range keeps scene clips on whole bars", () => {
    const { doc, trailingId } = zoneDoc();
    // Drag from bar 4.3 to 6.7 → ticks 8256..12864 → quantized bars 4–7.
    const next = duplicateTimeRange(doc, 8256, 12864).execute(doc);
    for (const clip of next.arrangement.clips) {
      expect(Number.isInteger(clip.startBar), `startBar ${clip.startBar} must stay integral`).toBe(true);
    }
    // Inside clip (bars 4–6) copied to bar 7; trailing clip (bar 8) to bar 11.
    expect(next.arrangement.clips.some((c) => c.startBar === 7 && c.lengthBars === 2)).toBe(true);
    expect(next.arrangement.clips.find((c) => c.id === trailingId)!.startBar).toBe(11);
    // Bar-aligned ranges are untouched by the quantization.
    expect(next.arrangement.clips.filter((c) => c.startBar === 0)).toHaveLength(1);
  });

  it("carries phaseOffsetTicks/sceneOffsetTicks/loop onto the zone copies", () => {
    const { doc, insideId } = zoneDoc();
    const withPhase: ProjectDocument = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        clips: doc.arrangement.clips.map((c) =>
          c.id === insideId ? { ...c, phaseOffsetTicks: 240, sceneOffsetTicks: 480, loop: true } : c,
        ),
      },
    };
    const next = duplicateTimeRange(withPhase, 4 * BAR_TICKS, 6 * BAR_TICKS).execute(withPhase);
    const copy = next.arrangement.clips.find((c) => c.startBar === 6 && c.id !== insideId)!;
    expect(copy.phaseOffsetTicks).toBe(240);
    expect(copy.sceneOffsetTicks).toBe(480);
    expect(copy.loop).toBe(true);
  });

  it("refuses when a scene clip crosses the zone boundary (no-overlap lane)", () => {
    const { doc } = zoneDoc();
    // Zone bars 5–7 cuts through the clip at bars 4–6.
    expect(() => duplicateTimeRange(doc, 5 * BAR_TICKS, 7 * BAR_TICKS)).toThrow(/crosses its boundary/i);
  });
});

describe("marker.linkedClipId — stale reference cleanup (M1)", () => {
  function docWithLinkedMarker(clipKind: "scene" | "audio"): {
    doc: ProjectDocument;
    markerId: string;
    clipId: string;
    trackId: string;
  } {
    let doc = createDefaultProject();
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    let clipId: string;
    if (clipKind === "audio") {
      doc = addAudioClip(doc, trackId, "buf-audit", 0, 2).execute(doc);
      clipId = doc.arrangement.audioClips![0]!.id;
    } else {
      const sceneId = doc.scenes[0]!.id;
      doc = addArrangementClip(doc, sceneId, 4, 2).execute(doc);
      clipId = doc.arrangement.clips.find((c) => c.startBar === 4)!.id;
    }
    doc = addMarker(doc, { tick: 0, name: "Drop", type: "drop", linkedClipId: clipId }).execute(doc);
    return { doc, markerId: doc.markers[0]!.id, clipId, trackId };
  }

  it("deleteArrangementClip unlinks the marker; undo restores the link", () => {
    const { doc, markerId, clipId } = docWithLinkedMarker("scene");
    const command = deleteArrangementClip(doc, clipId);
    const next = command.execute(doc);
    expect(next.markers.find((m) => m.id === markerId)!.linkedClipId).toBeUndefined();
    const undone = command.undo(next);
    expect(undone.markers.find((m) => m.id === markerId)!.linkedClipId).toBe(clipId);
  });

  it("deleteArrangementClipRipple unlinks the marker", () => {
    const { doc, markerId, clipId } = docWithLinkedMarker("scene");
    const next = deleteArrangementClipRipple(doc, clipId).execute(doc);
    expect(next.markers.find((m) => m.id === markerId)!.linkedClipId).toBeUndefined();
  });

  it("deleteAudioClip unlinks the marker; undo restores the link", () => {
    const { doc, markerId, clipId } = docWithLinkedMarker("audio");
    const command = deleteAudioClip(doc, clipId);
    const next = command.execute(doc);
    expect(next.markers.find((m) => m.id === markerId)!.linkedClipId).toBeUndefined();
    expect(command.undo(next).markers.find((m) => m.id === markerId)!.linkedClipId).toBe(clipId);
  });

  it("deleteTrack unlinks markers tied to the track's audio clips", () => {
    const { doc, markerId, trackId } = docWithLinkedMarker("audio");
    const next = deleteTrack(doc, trackId).execute(doc);
    expect(next.markers.find((m) => m.id === markerId)!.linkedClipId).toBeUndefined();
    expect(next.markers).toHaveLength(1);
  });
});

describe("fade bounds on load (F1)", () => {
  it("normalizeProject clamps a fade that outlives its clip", () => {
    const { doc } = audioDoc(0.25);
    const clip = doc.arrangement.audioClips![0]!;
    const poisoned: ProjectDocument = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: [{ ...clip, fadeIn: 4, fadeOut: 9 }],
      },
    };
    const normalized = normalizeProject(poisoned);
    const bounded = normalized.arrangement.audioClips![0]!;
    const bound = clipDurationSec(normalized, bounded);
    expect(bound).toBeLessThan(1);
    expect(bounded.fadeIn).toBeLessThanOrEqual(bound);
    expect(bounded.fadeOut).toBeLessThanOrEqual(bound);
  });

  it("the fade bound is scene-aware: a fade sized at the scene tempo survives normalize", () => {
    // 0.0625 bars under a pinned 60bpm scene = 0.25s of real time — a 0.25s
    // crossfade-sized fade is IN bounds there, even though the flat
    // project-tempo bound (124bpm → 0.121s) would clamp it to half.
    let doc = createDefaultProject();
    doc = setSceneBpm(doc, doc.scenes[0]!.id, 60).execute(doc);
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    doc = addAudioClip(doc, trackId, "buf-audit", 0, 1).execute(doc);
    const clip = doc.arrangement.audioClips![0]!;
    const tiny: ProjectDocument = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: [{ ...clip, lengthBars: 0.0625, fadeIn: 0.25, fadeOut: 0.25 }],
      },
    };
    const normalized = normalizeProject(tiny);
    const bounded = normalized.arrangement.audioClips![0]!;
    expect(bounded.fadeIn).toBeCloseTo(0.25, 9);
    expect(bounded.fadeOut).toBeCloseTo(0.25, 9);
  });
});

describe("audit probes — boundary & repeatability gaps", () => {
  it("splitAudioClipAtTick refuses a split at the exact END tick", () => {
    const { doc, clipId } = audioDoc(4);
    expect(() => splitAudioClipAtTick(doc, clipId, 4 * BAR_TICKS)).toThrow(/outside/i);
  });

  it("repeated audio moves to the same target are a fixed point (no drift)", () => {
    const { doc, clipId } = audioDoc(2);
    let next = moveAudioClip(doc, clipId, 4.005).execute(doc);
    const first = next.arrangement.audioClips![0]!.startBar;
    // Tick quantization (snap wave): stored bar geometry lands on the
    // nearest 1/1920-bar tick — the old 0.01-bar round destroyed 1/8 and
    // 1/16 positions the snap grid needs. The FIXED-POINT intent is what
    // this probe pins: the quantized value is exact, and re-moving to it
    // never drifts.
    expect(first).toBe(Math.round(4.005 * BAR_TICKS) / BAR_TICKS);
    for (let i = 0; i < 50; i++) next = moveAudioClip(next, clipId, first).execute(next);
    expect(next.arrangement.audioClips![0]!.startBar).toBe(first);
  });

  it("scene clip moves round to whole bars (grid stays exact under repeats)", () => {
    let doc = createDefaultProject();
    const sceneId = doc.scenes[0]!.id;
    doc = addArrangementClip(doc, sceneId, 4, 2).execute(doc);
    const clipId = doc.arrangement.clips.find((c) => c.startBar === 4)!.id;
    let next = moveArrangementClip(doc, clipId, 6.7).execute(doc);
    expect(next.arrangement.clips.find((c) => c.id === clipId)!.startBar).toBe(7);
    for (let i = 0; i < 25; i++) next = moveArrangementClip(next, clipId, 7).execute(next);
    expect(next.arrangement.clips.find((c) => c.id === clipId)!.startBar).toBe(7);
  });

  it("stress: strip → split fragment → duplicate → delete → undo×3 stays coherent", () => {
    const { doc, clipId } = audioDoc(8, { trimStart: 1 });
    const strip = stripSilenceAudioClip(doc, clipId, [
      { startSec: 1, endSec: 3 },
      { startSec: 5, endSec: 8 },
    ]);
    let next = strip.execute(doc);
    const frags = next.arrangement.audioClips!;
    expect(frags.length).toBe(2);
    for (const clip of frags) {
      expect(Number.isFinite(clip.startBar)).toBe(true);
      expect(clip.lengthBars).toBeGreaterThan(0);
      expect(clip.fadeIn).toBeLessThanOrEqual(clipDurationSec(next, clip));
      expect(clip.fadeOut).toBeLessThanOrEqual(clipDurationSec(next, clip));
    }
    // Split the first fragment, duplicate the left half, delete it, then undo
    // the whole chain back to the pre-strip document.
    const frag = frags[0]!;
    const midTick = (frag.startBar + frag.lengthBars / 2) * BAR_TICKS;
    const split = splitAudioClipAtTick(next, frag.id, midTick, 20);
    next = split.execute(next);
    const left = next.arrangement.audioClips!.find((c) => c.startBar === frag.startBar)!;
    const dup = duplicateAudioClip(next, left.id);
    next = dup.execute(next);
    const del = deleteAudioClip(next, left.id);
    next = del.execute(next);
    next = del.undo(next);
    next = dup.undo(next);
    next = split.undo(next);
    next = strip.undo(next);
    expect(next).toEqual(doc);
  });
});

/* ── deferred-risk wave: scene-aware clamps, fit target, marker routing, takes ── */

describe("in-command fade clamps are scene-aware (R2)", () => {
  function pinnedDoc() {
    let doc = createDefaultProject();
    doc = setSceneBpm(doc, doc.scenes[0]!.id, 60).execute(doc);
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    doc = addAudioClip(doc, trackId, "buf-audit", 0, 1).execute(doc);
    return { doc, clipId: doc.arrangement.audioClips![0]!.id };
  }

  it("updateAudioClip bounds fades at the scene tempo (1 bar @60bpm = 4s, not 0.97s)", () => {
    const { doc, clipId } = pinnedDoc();
    const next = updateAudioClip(doc, clipId, { fadeIn: 5, fadeOut: 5 }).execute(doc);
    const clip = next.arrangement.audioClips![0]!;
    expect(clip.fadeIn).toBeCloseTo(4, 6); // flat doc.bpm bound would say ~0.97
    expect(clip.fadeOut).toBeCloseTo(4, 6);
  });

  it("resize re-bounds inherited fades at the scene tempo", () => {
    const { doc, clipId } = pinnedDoc();
    const sized = updateAudioClip(doc, clipId, { fadeIn: 4, fadeOut: 4 }).execute(doc);
    const next = resizeAudioClip(sized, clipId, 0.5).execute(sized); // half bar @60bpm = 2s
    const clip = next.arrangement.audioClips![0]!;
    expect(clip.fadeIn).toBeCloseTo(2, 6);
    expect(clip.fadeOut).toBeCloseTo(2, 6);
  });

  it("split seam declick stays at 3ms under a pinned scene (bound only ever shrinks it)", () => {
    const { doc, clipId } = pinnedDoc();
    const next = splitAudioClipAtTick(doc, clipId, BAR_TICKS / 2).execute(doc);
    const right = next.arrangement.audioClips!.find((c) => c.startBar === 0.5)!;
    expect(right.fadeIn).toBeCloseTo(0.003, 6);
  });
});

describe("fitAudioClipTempo targets the transport tempo (R3)", () => {
  it("fits against the scene-pinned tempo, and the label names it", () => {
    let doc = createDefaultProject();
    doc = setSceneBpm(doc, doc.scenes[0]!.id, 240).execute(doc);
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    doc = addAudioClip(doc, trackId, "buf-audit", 0, 4).execute(doc);
    const clipId = doc.arrangement.audioClips![0]!.id;
    const command = fitAudioClipTempo(doc, clipId, 120);
    const next = command.execute(doc);
    const clip = next.arrangement.audioClips!.find((c) => c.id === clipId)!;
    expect(clip.stretchRate).toBeCloseTo(0.5, 2); // 120/240 — flat doc.bpm would say ~0.97
    expect(command.label).toMatch(/120.*240.*BPM/u);
  });

  it("stays at the project tempo when no scene pins one (regression guard)", () => {
    const { doc, clipId } = audioDoc(4);
    const next = fitAudioClipTempo(doc, clipId, 62).execute(doc);
    const clip = next.arrangement.audioClips!.find((c) => c.id === clipId)!;
    expect(clip.stretchRate).toBeCloseTo(62 / doc.bpm, 2);
  });
});

describe("marker cue routing semantics (R3)", () => {
  it("an audio-linked marker routes to its track; scene-linked and unlinked stay on the global bus", () => {
    const { doc, trackId } = audioDoc(2);
    const audioClipId = doc.arrangement.audioClips![0]!.id;
    const sceneClipId = doc.arrangement.clips[0]!.id;
    const withMarkers = addMarker(doc, { tick: 0, name: "A", linkedClipId: audioClipId }).execute(doc);
    const both = addMarker(withMarkers, { tick: 10, name: "B", linkedClipId: sceneClipId }).execute(withMarkers);
    const linked = addMarker(both, { tick: 20, name: "C" }).execute(both);
    const [audioLinked, sceneLinked, unlinked] = linked.markers;
    expect(markerCueTrackId(linked.arrangement.audioClips, audioLinked!)).toBe(trackId);
    expect(markerCueTrackId(linked.arrangement.audioClips, sceneLinked!)).toBeUndefined();
    expect(markerCueTrackId(linked.arrangement.audioClips, unlinked!)).toBeUndefined();
  });
});

describe("strip silence keeps take-lane identity coherent (R4, pinned behavior)", () => {
  function takeDoc() {
    let doc = createDefaultProject();
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    doc = addAudioTakeClip(doc, "tg-audit", "take-1", trackId, "buf-audit", 0, 2).execute(doc);
    doc = addAudioTakeClip(doc, "tg-audit", "take-2", trackId, "buf-audit", 0, 2).execute(doc);
    return { doc, trackId };
  }

  it("stripping the audible comp clip keeps it in the comp playback", () => {
    const { doc } = takeDoc();
    const comped = compAudioTakeRange(doc, "tg-audit", "take-1", 0, BAR_TICKS).execute(doc);
    const group = comped.arrangement.takeGroups!.find((g) => g.id === "tg-audit")!;
    const compClip = audioClipsForPlayback(comped.arrangement).find((c) => c.takeId === group.compTakeId)!;
    expect(compClip).toBeDefined();
    const w0 = (compClip.offsetSec ?? 0) + (compClip.trimStart ?? 0);
    const dur = clipDurationSec(comped, compClip);
    const next = stripSilenceAudioClip(
      comped,
      compClip.id,
      [{ startSec: w0, endSec: w0 + dur / 2 }],
      w0 + dur * 2,
    ).execute(comped);
    const fragment = next.arrangement.audioClips!.find(
      (c) => c.compSourceTakeId === compClip.compSourceTakeId && c.id !== compClip.id,
    )!;
    expect(fragment.takeGroupId).toBe("tg-audit");
    expect(fragment.compSourceTakeId).toBe(compClip.compSourceTakeId);
    // Comp clips carry their source take's id; the group's activeTakeId
    // points at the comped take, so the fragment still plays through the lane.
    expect(fragment.takeId).toBe(compClip.takeId);
    expect(audioClipsForPlayback(next.arrangement).some((c) => c.id === fragment.id)).toBe(true);
  });

  it("stripping an inactive take keeps the fragments out of playback", () => {
    const { doc } = takeDoc();
    const group = doc.arrangement.takeGroups!.find((g) => g.id === "tg-audit")!;
    // addAudioTakeClip makes the NEWEST take active — strip one that isn't it.
    const inactive = doc.arrangement.audioClips!.find((c) => c.takeId && c.takeId !== group.activeTakeId)!;
    expect(audioClipsForPlayback(doc.arrangement).some((c) => c.id === inactive.id)).toBe(false);
    const next = stripSilenceAudioClip(doc, inactive.id, [{ startSec: 0, endSec: 1 }], 4).execute(doc);
    const fragments = next.arrangement.audioClips!.filter((c) => c.takeId === inactive.takeId);
    expect(fragments.length).toBeGreaterThan(0);
    for (const fragment of fragments) {
      expect(audioClipsForPlayback(next.arrangement).some((c) => c.id === fragment.id)).toBe(false);
    }
  });
});
