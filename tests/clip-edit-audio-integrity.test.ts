import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addAudioClip,
  moveAudioClip,
  resizeAudioClip,
  slipAudioClip,
  splitAudioClipAtTick,
  updateAudioClip,
  toggleAudioClipsMute,
  buildClipClipboard,
  pasteClips,
  duplicateAudioClip,
  trimAudioClipStart,
} from "../src/commands/commands";
import { audioClipDurationSec } from "../src/commands/audioClips";
import { audioClipPlayWindow } from "../src/audio-engine/warpManager";
import { audioClipWaveformWindow } from "../src/audio-engine/audioClipChannels";
import { audioClipPlayedSourceSec, audioClipSourceSecondsPerWallSecond } from "../src/project-model/audio-clip-warp";
import { audioClipsForPlayback } from "../src/project-model/audio-takes";
import { ticksPerBar } from "../src/project-model/schema";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * THE AUDIBLE LEG OF THE EDIT CHAIN.
 *
 * The edit matrix (clip-edit-matrix.test.ts) proves that an edit changes the
 * right FIELDS. This suite proves the last leg: that the edited clip still
 * PLAYS what the editor shows.
 *
 * Two independent authorities, both already owned by the codebase:
 *
 *   - `audioClipPlayWindow` — the engine's own window resolver. Live playback
 *     and the offline render both go through it.
 *   - `audioClipWaveformWindow` — what the editor DRAWS.
 *
 * The invariant is the "picture is the sound" one: the drawn window starts
 * where playback starts and stops where the material stops. A verb that
 * rewrites a field one of them reads but not the other desynchronizes the
 * editor from the audio — and that is invisible in a doc-level assertion.
 */

/** The source buffer every clip in this suite points at (seconds). */
const SOURCE_SEC = 30;

function storeWithClip(patch: Partial<AudioClip> = {}): { store: ProjectStore; clipId: string } {
  const store = new ProjectStore(createProjectFromTemplate("house"));
  store.execute(addAudioClip(store.doc, store.doc.tracks[0]!.id, "factory.kick", 0, 4, patch));
  return { store, clipId: store.doc.arrangement.audioClips![0]!.id };
}

const clipOf = (doc: ProjectDocument, id: string): AudioClip =>
  doc.arrangement.audioClips!.find((c) => c.id === id)!;

/** Wall seconds the transport gives this clip. */
function wallSec(doc: ProjectDocument, clip: AudioClip): number {
  return audioClipDurationSec(doc, clip.lengthBars, clip.startBar);
}

/** The play-buffer time scale: 1 for resample, the rate for a pre-stretched buffer. */
function timeScaleFor(clip: AudioClip): number {
  const rate = Math.min(4, Math.max(0.25, clip.stretchRate ?? 1));
  const preStretched = clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01;
  return preStretched ? rate : 1;
}

/**
 * How many ORIGINAL-sample seconds the engine plays for this clip — derived
 * from the engine's own resolver, never from a second copy of the rule.
 */
function enginePlayedSourceSec(clip: AudioClip, wall: number): number {
  const rate = Math.min(4, Math.max(0.25, clip.stretchRate ?? 1));
  const preStretched = clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01;
  const timeScale = preStretched ? rate : 1;
  const win = audioClipPlayWindow(clip, SOURCE_SEC * timeScale, wall, timeScale);
  const looping = clip.loop === true && clip.reverse !== true;
  return (looping ? win.contentDur : win.bufferDuration) / timeScale;
}

/** The window the editor draws for this clip. */
function drawnWindow(clip: AudioClip, wall: number): { startSec: number; endSec: number } {
  const played = audioClipPlayedSourceSec(clip, SOURCE_SEC, wall);
  return audioClipWaveformWindow(SOURCE_SEC, clip.offsetSec ?? 0, clip.trimStart ?? 0, clip.trimEnd ?? 0, played);
}

/** The window the engine plays for this clip, in ORIGINAL-sample seconds. */
function playedWindow(clip: AudioClip, wall: number): { startSec: number; endSec: number } {
  const timeScale = timeScaleFor(clip);
  const win = audioClipPlayWindow(clip, SOURCE_SEC * timeScale, wall, timeScale);
  const looping = clip.loop === true && clip.reverse !== true;
  const span = looping ? win.contentDur : win.bufferDuration;
  return { startSec: win.playOffset / timeScale, endSec: (win.playOffset + span) / timeScale };
}

/**
 * THE CHAIN INVARIANT: what the editor draws and what the engine plays are
 * the same region of the source. Checked on the plain (forward, non-looping)
 * clip — the reverse and loop branches have their own windows by design.
 */
function expectPictureMatchesSound(doc: ProjectDocument, clipId: string, label: string): void {
  const clip = clipOf(doc, clipId);
  const wall = wallSec(doc, clip);
  const drawn = drawnWindow(clip, wall);
  const played = playedWindow(clip, wall);
  expect(drawn.startSec, `${label}: the drawn window must start where playback starts`).toBeCloseTo(
    played.startSec,
    6,
  );
  expect(
    drawn.endSec - drawn.startSec,
    `${label}: the drawn window must be as long as the source that plays`,
  ).toBeCloseTo(played.endSec - played.startSec, 6);
}

describe("an edit keeps the picture and the sound together", () => {
  it("a plain clip agrees before any edit", () => {
    const { store, clipId } = storeWithClip();
    expectPictureMatchesSound(store.doc, clipId, "unedited");
  });

  it("a move does not touch the source window", () => {
    const { store, clipId } = storeWithClip();
    const before = playedWindow(clipOf(store.doc, clipId), wallSec(store.doc, clipOf(store.doc, clipId)));
    store.execute(moveAudioClip(store.doc, clipId, 4));
    const clip = clipOf(store.doc, clipId);
    expect(clip.startBar, "the move must land").toBe(4);
    const after = playedWindow(clip, wallSec(store.doc, clip));
    expect(after.startSec, "a move must not detach the source").toBeCloseTo(before.startSec, 6);
    expect(after.endSec).toBeCloseTo(before.endSec, 6);
    expectPictureMatchesSound(store.doc, clipId, "moved");
  });

  it("a resize plays less source — and the editor shows exactly that", () => {
    const { store, clipId } = storeWithClip();
    store.execute(resizeAudioClip(store.doc, clipId, 2));
    const clip = clipOf(store.doc, clipId);
    const wall = wallSec(store.doc, clip);
    const drawn = drawnWindow(clip, wall);
    const played = playedWindow(clip, wall);
    // Half the clip: half the source, no more.
    expect(played.endSec - played.startSec).toBeCloseTo(wall, 6);
    expect(drawn.endSec - drawn.startSec).toBeCloseTo(wall, 6);
    expectPictureMatchesSound(store.doc, clipId, "resized");
  });

  it("a slip shifts the audible source by exactly the slip", () => {
    const { store, clipId } = storeWithClip({ trimStart: 0.5 });
    store.execute(slipAudioClip(store.doc, clipId, 1.25));
    const clip = clipOf(store.doc, clipId);
    const played = playedWindow(clip, wallSec(store.doc, clip));
    expect(played.startSec, "the audible start is offsetSec + trimStart").toBeCloseTo(
      clip.offsetSec + (clip.trimStart ?? 0),
      6,
    );
    expectPictureMatchesSound(store.doc, clipId, "slipped");
  });

  it("a head trim advances the audible source by exactly the trimmed time", () => {
    const { store, clipId } = storeWithClip();
    const clip = clipOf(store.doc, clipId);
    const oneBarSec = wallSec(store.doc, clip) / clip.lengthBars;
    store.execute(
      trimAudioClipStart(store.doc, clipId, {
        startBar: clip.startBar + 1,
        lengthBars: clip.lengthBars - 1,
        trimStart: clip.trimStart,
        offsetSec: clip.offsetSec + oneBarSec,
      }),
    );
    const trimmed = clipOf(store.doc, clipId);
    const played = playedWindow(trimmed, wallSec(store.doc, trimmed));
    expect(played.startSec, "the trim must advance the source by the trimmed time").toBeCloseTo(oneBarSec, 6);
    expectPictureMatchesSound(store.doc, clipId, "trimmed");
  });

  it("a gain change does not touch the source window", () => {
    const { store, clipId } = storeWithClip();
    const before = playedWindow(clipOf(store.doc, clipId), wallSec(store.doc, clipOf(store.doc, clipId)));
    store.execute(updateAudioClip(store.doc, clipId, { gain: 0.25 }));
    const clip = clipOf(store.doc, clipId);
    const after = playedWindow(clip, wallSec(store.doc, clip));
    expect(after.startSec).toBeCloseTo(before.startSec, 6);
    expect(after.endSec).toBeCloseTo(before.endSec, 6);
  });
});

describe("a split leaves no gap and no duplicate in the source", () => {
  it("the fragments tile the original's source window", () => {
    const { store, clipId } = storeWithClip();
    const original = clipOf(store.doc, clipId);
    const wall = wallSec(store.doc, original);
    const before = playedWindow(original, wall);
    store.execute(splitAudioClipAtTick(store.doc, clipId, 2 * ticksPerBar(store.doc)));
    const clips = [...store.doc.arrangement.audioClips!].sort((a, b) => a.startBar - b.startBar);
    expect(clips).toHaveLength(2);
    const left = playedWindow(clips[0]!, wallSec(store.doc, clips[0]!));
    const right = playedWindow(clips[1]!, wallSec(store.doc, clips[1]!));
    // The left fragment ends exactly where the right one starts: no gap.
    expect(left.endSec, "the fragments must not leave a gap in the source").toBeCloseTo(right.startSec, 6);
    // The pair covers exactly what the original played: no duplicate.
    expect(left.startSec).toBeCloseTo(before.startSec, 6);
    expect(right.endSec, "the pair must not play more than the original did").toBeCloseTo(before.endSec, 6);
    for (const clip of clips) {
      expectPictureMatchesSound(store.doc, clip.id, "split fragment");
    }
  });

  it("a repeated split keeps the fragments contiguous", () => {
    const { store, clipId } = storeWithClip();
    store.execute(splitAudioClipAtTick(store.doc, clipId, 1 * ticksPerBar(store.doc)));
    const middle = store.doc.arrangement.audioClips!.find((c) => c.startBar === 1)!;
    store.execute(splitAudioClipAtTick(store.doc, middle.id, 2 * ticksPerBar(store.doc)));
    const clips = [...store.doc.arrangement.audioClips!].sort((a, b) => a.startBar - b.startBar);
    expect(clips).toHaveLength(3);
    for (let i = 1; i < clips.length; i++) {
      const prev = playedWindow(clips[i - 1]!, wallSec(store.doc, clips[i - 1]!));
      const next = playedWindow(clips[i]!, wallSec(store.doc, clips[i]!));
      expect(next.startSec, `fragment ${i} must continue where fragment ${i - 1} stopped`).toBeCloseTo(
        prev.endSec,
        6,
      );
    }
  });
});

describe("a copy plays the same source as the clip it came from", () => {
  it("a duplicate keeps the source window", () => {
    const { store, clipId } = storeWithClip({ offsetSec: 2, trimStart: 0.25, trimEnd: 0.5 });
    const original = clipOf(store.doc, clipId);
    const before = playedWindow(original, wallSec(store.doc, original));
    store.execute(duplicateAudioClip(store.doc, clipId));
    const copy = store.doc.arrangement.audioClips!.find((c) => c.id !== original.id)!;
    const after = playedWindow(copy, wallSec(store.doc, copy));
    expect(after.startSec).toBeCloseTo(before.startSec, 6);
    expect(after.endSec).toBeCloseTo(before.endSec, 6);
  });

  it("a paste keeps the source window", () => {
    const { store, clipId } = storeWithClip({ offsetSec: 2, trimStart: 0.25, trimEnd: 0.5 });
    const original = clipOf(store.doc, clipId);
    const before = playedWindow(original, wallSec(store.doc, original));
    const clipboard = buildClipClipboard(store.doc, [clipId])!;
    const beforeIds = new Set(store.doc.arrangement.audioClips!.map((c) => c.id));
    store.execute(pasteClips(store.doc, clipboard, 8 * ticksPerBar(store.doc)));
    const pasted = store.doc.arrangement.audioClips!.find((c) => !beforeIds.has(c.id))!;
    const after = playedWindow(pasted, wallSec(store.doc, pasted));
    expect(after.startSec, "a pasted clip must play the source the original played").toBeCloseTo(before.startSec, 6);
    expect(after.endSec).toBeCloseTo(before.endSec, 6);
    expect(pasted.startBar, "the paste lands at the playhead").not.toBe(original.startBar);
  });
});

describe("mute reaches the scheduler", () => {
  it("a muted clip does not reach playback, and unmuting brings it back", () => {
    const { store, clipId } = storeWithClip();
    expect(audioClipsForPlayback(store.doc.arrangement).some((c) => c.id === clipId)).toBe(true);
    store.execute(toggleAudioClipsMute(store.doc, [clipId])!);
    expect(
      audioClipsForPlayback(store.doc.arrangement).some((c) => c.id === clipId),
      "a muted clip must not be scheduled",
    ).toBe(false);
    expect(clipOf(store.doc, clipId).muted, "the mute state stays on the clip").toBe(true);
    store.execute(toggleAudioClipsMute(store.doc, [clipId])!);
    expect(audioClipsForPlayback(store.doc.arrangement).some((c) => c.id === clipId)).toBe(true);
  });
});

describe("the audible source follows the clip's own rate", () => {
  it("a resample clip consumes source seconds faster than wall seconds", () => {
    const { store, clipId } = storeWithClip({ stretchRate: 2 });
    const clip = clipOf(store.doc, clipId);
    const wall = wallSec(store.doc, clip);
    expect(audioClipSourceSecondsPerWallSecond(clip), "rate 2 consumes two source seconds per wall second").toBe(2);
    const played = playedWindow(clip, wall);
    expect(played.endSec - played.startSec, "the clip must consume twice its wall length of source").toBeCloseTo(
      wall * 2,
      6,
    );
  });
});
