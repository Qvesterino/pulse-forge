import { describe, it, expect } from "vitest";
import { addAudioClip, previewStretchRate, stretchAudioClip } from "../src/commands/commands";
import { testDoc } from "./fixtures/doc";

function docWithClip() {
  const doc = testDoc();
  const trackId = doc.tracks[0].id;
  const next = addAudioClip(doc, trackId, "buf-test", 0, 4, { gain: 1, stretchRate: 1 }).execute(doc);
  const clipId = next.arrangement.audioClips![next.arrangement.audioClips!.length - 1].id;
  return { doc: next, clipId };
}

describe("previewStretchRate (Alt+drag math)", () => {
  it("scales rate inversely with length (double bars = half rate)", () => {
    expect(previewStretchRate(1, 4, 8)).toBe(0.5);
    expect(previewStretchRate(1, 4, 2)).toBe(2);
    expect(previewStretchRate(1, 4, 4)).toBe(1);
  });

  it("is relative to the current rate (keeps trims honest)", () => {
    expect(previewStretchRate(1.5, 4, 8)).toBe(0.75);
  });

  it("clamps to the engine 0.25–4 gate and survives garbage", () => {
    expect(previewStretchRate(1, 4, 64)).toBe(0.25);
    expect(previewStretchRate(1, 4, 0.1)).toBe(4);
    expect(previewStretchRate(Number.NaN, 4, 8)).toBe(0.5);
    expect(previewStretchRate(1, 0, 8)).toBe(0.25);
  });
});

describe("stretchAudioClip command", () => {
  it("applies length + rate atomically with one undo step", () => {
    const { doc, clipId } = docWithClip();
    const command = stretchAudioClip(doc, clipId, 8, 0.5);
    const next = command.execute(doc);
    const clip = next.arrangement.audioClips!.find((c) => c.id === clipId)!;
    expect(clip.lengthBars).toBe(8);
    expect(clip.stretchRate).toBe(0.5);
    // ONE undo restores both
    const undone = command.undo(next);
    const restored = undone.arrangement.audioClips!.find((c) => c.id === clipId)!;
    expect(restored.lengthBars).toBe(4);
    expect(restored.stretchRate).toBe(1);
  });

  it("clamps length floor and rate gate like resize/update", () => {
    const { doc, clipId } = docWithClip();
    const next = stretchAudioClip(doc, clipId, 0.01, 99).execute(doc);
    const clip = next.arrangement.audioClips!.find((c) => c.id === clipId)!;
    expect(clip.lengthBars).toBe(0.25);
    expect(clip.stretchRate).toBe(4);
  });

  it("throws on unknown clips", () => {
    expect(() => stretchAudioClip(testDoc(), "nope", 8, 0.5)).toThrow("AudioClip nope not found");
  });
});
