import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { addAudioClip, fitAudioClipTempo, updateAudioClip } from "../src/commands/commands";

function docWithClip() {
  const base = createDefaultProject();
  const doc = addAudioClip(base, base.tracks[0].id, "factory.loop", 0, 4).execute(base);
  return { doc, clipId: doc.arrangement.audioClips![0].id };
}

describe("fitAudioClipTempo", () => {
  it("sets pitch-preserving stretch mode with detected/project rate", () => {
    const { doc, clipId } = docWithClip();
    const next = fitAudioClipTempo(doc, clipId, 100).execute(doc); // project default is 124 BPM
    const clip = next.arrangement.audioClips!.find((c) => c.id === clipId)!;
    expect(clip.stretchMode).toBe("stretch");
    expect(clip.stretchRate).toBeCloseTo(100 / 124, 2);
    // Effective tempo lands on the project grid.
    expect(Math.abs(100 / clip.stretchRate - doc.bpm)).toBeLessThan(1.5);
  });

  it("speeds a slower loop up (rate < 1) and slows a faster one down (rate > 1)", () => {
    const { doc, clipId } = docWithClip();
    const faster = fitAudioClipTempo(doc, clipId, 150).execute(doc);
    expect(faster.arrangement.audioClips!.find((c) => c.id === clipId)!.stretchRate).toBeGreaterThan(1);
    const slower = fitAudioClipTempo(doc, clipId, 90).execute(doc);
    expect(slower.arrangement.audioClips!.find((c) => c.id === clipId)!.stretchRate).toBeLessThan(1);
  });

  it("keeps warp markers and other clip fields untouched", () => {
    const { doc, clipId } = docWithClip();
    const warped = updateAudioClip(doc, clipId, {
      warpMarkers: [
        { timeSec: 0, tick: 0 },
        { timeSec: 1.935, tick: 1920 },
      ],
      gain: 0.8,
    }).execute(doc);
    const next = fitAudioClipTempo(warped, clipId, 100).execute(warped);
    const clip = next.arrangement.audioClips!.find((c) => c.id === clipId)!;
    expect(clip.warpMarkers).toEqual(warped.arrangement.audioClips!.find((c) => c.id === clipId)!.warpMarkers);
    expect(clip.gain).toBe(0.8);
    expect(clip.startBar).toBe(0);
  });

  it("undoes back to the original rate and mode", () => {
    const { doc, clipId } = docWithClip();
    const command = fitAudioClipTempo(doc, clipId, 100);
    const next = command.execute(doc);
    const undone = command.undo(next);
    const clip = undone.arrangement.audioClips!.find((c) => c.id === clipId)!;
    expect(clip.stretchRate).toBe(1);
    expect(clip.stretchMode).toBeUndefined();
  });

  it("carries a human-readable label for the history panel", () => {
    const { doc, clipId } = docWithClip();
    const command = fitAudioClipTempo(doc, clipId, 100.4);
    expect(command.label).toMatch(/100.*124.*BPM/u);
  });

  it("throws for unknown clip ids and implausible detections", () => {
    const { doc, clipId } = docWithClip();
    expect(() => fitAudioClipTempo(doc, "nope", 120)).toThrow(/not found/u);
    expect(() => fitAudioClipTempo(doc, clipId, Number.NaN)).toThrow(/refusing/u);
    expect(() => fitAudioClipTempo(doc, clipId, 20)).toThrow(/refusing/u);
    expect(() => fitAudioClipTempo(doc, clipId, 400)).toThrow(/refusing/u);
  });
});
