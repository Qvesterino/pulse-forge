import { describe, expect, it } from "vitest";
import { createDefaultProject, sanitizeAudioClips } from "../src/project-model/schema";
import { addAudioClip, updateAudioClip } from "../src/commands/commands";
import type { ProjectDocument } from "../src/project-model/types";

function docWithClip(): { doc: ProjectDocument; clipId: string; trackId: string } {
  const base = createDefaultProject();
  const trackId = base.tracks[0].id;
  const doc = addAudioClip(base, trackId, "factory.kick", 0, 4).execute(base);
  return { doc, clipId: doc.arrangement.audioClips![0].id, trackId };
}

describe("updateAudioClip", () => {
  it("clamps gain to 0..2 and stretchRate to 0.25..4", () => {
    const { doc, clipId } = docWithClip();
    const next = updateAudioClip(doc, clipId, { gain: 99, stretchRate: 20 }).execute(doc);
    const clip = next.arrangement.audioClips!.find((c) => c.id === clipId)!;
    expect(clip.gain).toBe(2);
    expect(clip.stretchRate).toBe(4);

    const next2 = updateAudioClip(next, clipId, { gain: -3, stretchRate: 0.01 }).execute(next);
    const clip2 = next2.arrangement.audioClips!.find((c) => c.id === clipId)!;
    expect(clip2.gain).toBe(0);
    expect(clip2.stretchRate).toBe(0.25);
  });

  it("passes stretchMode through and keeps other fields untouched", () => {
    const { doc, clipId } = docWithClip();
    const next = updateAudioClip(doc, clipId, { stretchMode: "stretch", stretchRate: 1.5 }).execute(doc);
    const clip = next.arrangement.audioClips!.find((c) => c.id === clipId)!;
    expect(clip.stretchMode).toBe("stretch");
    expect(clip.stretchRate).toBe(1.5);
    // untouched fields keep their values
    expect(clip.bufferId).toBe("factory.kick");
    expect(clip.startBar).toBe(0);
    // the original doc is not mutated
    expect(doc.arrangement.audioClips!.find((c) => c.id === clipId)!.stretchRate).toBe(1);
  });

  it("drops non-finite numeric patches instead of poisoning the doc (regression: NaN stretchRate crashed the scheduler)", () => {
    const { doc, clipId } = docWithClip();
    const next = updateAudioClip(doc, clipId, {
      stretchRate: Number.NaN,
      gain: Number.NaN,
      offsetSec: Number.NaN,
      trimStart: Number.NaN,
      trimEnd: Number.NaN,
      fadeIn: Number.NaN,
      fadeOut: Number.NaN,
    }).execute(doc);
    const clip = next.arrangement.audioClips!.find((c) => c.id === clipId)!;
    expect(clip.stretchRate).toBe(1);
    expect(clip.gain).toBe(1);
    expect(clip.offsetSec).toBe(0);
    expect(clip.trimStart).toBe(0);
    expect(clip.trimEnd).toBe(0);
    expect(clip.fadeIn).toBe(0);
    expect(clip.fadeOut).toBe(0);
  });

  it("coerces reverse to a strict boolean", () => {
    const { doc, clipId } = docWithClip();
    const next = updateAudioClip(doc, clipId, { reverse: "yes" as unknown as boolean }).execute(doc);
    expect(next.arrangement.audioClips!.find((c) => c.id === clipId)!.reverse).toBe(false);
  });

  it("throws for an unknown clip id (explicit failure, not silent no-op)", () => {
    const { doc } = docWithClip();
    expect(() => updateAudioClip(doc, "nope", { gain: 1 })).toThrow(/not found/u);
  });

  it("addAudioClip honors stretchMode from its patch (was silently dropped)", () => {
    const base = createDefaultProject();
    const trackId = base.tracks[0].id;
    const next = addAudioClip(base, trackId, "factory.kick", 0, 4, {
      stretchMode: "stretch",
      stretchRate: 1.5,
    }).execute(base);
    const clip = next.arrangement.audioClips![0];
    expect(clip.stretchMode).toBe("stretch");
    expect(clip.stretchRate).toBe(1.5);
  });

  it("adds, changes, and clears a mono source-channel route", () => {
    const base = createDefaultProject();
    const added = addAudioClip(base, base.tracks[0].id, "recorded-stereo-take", 0, 1, { sourceChannel: 1 }).execute(
      base,
    );
    const clip = added.arrangement.audioClips![0];
    expect(clip.sourceChannel).toBe(1);

    const changed = updateAudioClip(added, clip.id, { sourceChannel: 0 }).execute(added);
    expect(changed.arrangement.audioClips![0].sourceChannel).toBe(0);
    const restoredStereo = updateAudioClip(changed, clip.id, { sourceChannel: null }).execute(changed);
    expect(restoredStereo.arrangement.audioClips![0].sourceChannel).toBeUndefined();
  });

  it("sanitizes source-channel routing to safe channel indexes", () => {
    const base = createDefaultProject();
    const trackIds = new Set(base.tracks.map((track) => track.id));
    const trackId = base.tracks[0].id;
    const clips = sanitizeAudioClips(
      [
        { id: "valid", trackId, bufferId: "take", startBar: 0, lengthBars: 1, sourceChannel: 1 },
        { id: "negative", trackId, bufferId: "take", startBar: 1, lengthBars: 1, sourceChannel: -1 },
        { id: "high", trackId, bufferId: "take", startBar: 2, lengthBars: 1, sourceChannel: 32 },
        { id: "string", trackId, bufferId: "take", startBar: 3, lengthBars: 1, sourceChannel: "1" },
      ],
      trackIds,
    )!;
    expect(clips[0].sourceChannel).toBe(1);
    expect(clips.slice(1).every((clip) => clip.sourceChannel === undefined)).toBe(true);
  });

  it("loop toggles on/off and rides the addAudioClip patch (texture beds)", () => {
    const { doc, clipId } = docWithClip();
    expect(doc.arrangement.audioClips!.find((c) => c.id === clipId)!.loop).toBeUndefined();
    const on = updateAudioClip(doc, clipId, { loop: true }).execute(doc);
    expect(on.arrangement.audioClips!.find((c) => c.id === clipId)!.loop).toBe(true);
    const off = updateAudioClip(on, clipId, { loop: false }).execute(on);
    expect(off.arrangement.audioClips!.find((c) => c.id === clipId)!.loop).toBe(false);
    const base = createDefaultProject();
    const added = addAudioClip(base, base.tracks[0].id, "factory.kick", 0, 8, {
      loop: true,
      loopPhaseOffsetSec: 2,
    }).execute(base);
    expect(added.arrangement.audioClips![0].loop).toBe(true);
    const unlooped = updateAudioClip(added, added.arrangement.audioClips![0]!.id, { loop: false }).execute(added);
    expect(unlooped.arrangement.audioClips![0]!.loopPhaseOffsetSec).toBeUndefined();
  });

  it("sanitizes loop phase only for finite, forward looped clips", () => {
    const base = createDefaultProject();
    const trackId = base.tracks[0].id;
    const clips = sanitizeAudioClips(
      [
        { id: "valid", trackId, bufferId: "take", startBar: 0, lengthBars: 1, loop: true, loopPhaseOffsetSec: 2.5 },
        { id: "negative", trackId, bufferId: "take", startBar: 1, lengthBars: 1, loop: true, loopPhaseOffsetSec: -1 },
        { id: "not-looped", trackId, bufferId: "take", startBar: 2, lengthBars: 1, loopPhaseOffsetSec: 3 },
        {
          id: "reverse",
          trackId,
          bufferId: "take",
          startBar: 3,
          lengthBars: 1,
          loop: true,
          reverse: true,
          loopPhaseOffsetSec: 3,
        },
      ],
      new Set(base.tracks.map((track) => track.id)),
    )!;
    expect(clips.find((clip) => clip.id === "valid")!.loopPhaseOffsetSec).toBe(2.5);
    expect(clips.find((clip) => clip.id === "negative")!.loopPhaseOffsetSec).toBeUndefined();
    expect(clips.find((clip) => clip.id === "not-looped")!.loopPhaseOffsetSec).toBeUndefined();
    expect(clips.find((clip) => clip.id === "reverse")!.loopPhaseOffsetSec).toBeUndefined();
  });

  it("sanitizeAudioClips keeps loop only when strictly true", () => {
    const base = createDefaultProject();
    const trackIds = new Set(base.tracks.map((t) => t.id));
    const trackId = base.tracks[0].id;
    const raw = [
      { id: "a", trackId, bufferId: "b", startBar: 0, lengthBars: 4, loop: true },
      { id: "b", trackId, bufferId: "b", startBar: 4, lengthBars: 4, loop: "yes" },
      { id: "c", trackId, bufferId: "b", startBar: 8, lengthBars: 4 },
    ];
    const out = sanitizeAudioClips(raw, trackIds)!;
    expect(out.find((c) => c.id === "a")!.loop).toBe(true);
    expect(out.find((c) => c.id === "b")!.loop).toBeUndefined();
    expect(out.find((c) => c.id === "c")!.loop).toBeUndefined();
  });
});
