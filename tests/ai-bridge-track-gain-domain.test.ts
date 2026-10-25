import { describe, expect, it } from "vitest";
import { applyBridgeCommandForTest } from "../src/ai/bridge/executor";
import type { BridgeCommand } from "../src/ai/bridge/types";
import { setTrackParams } from "../src/commands/project";
import { createDefaultProject } from "../src/project-model/schema";

/**
 * F-05 — the AI bridge must not own a wider gain domain than the command
 * layer. The bridge clamped track gain to 0..4 while setTrackParams (the
 * command every other surface uses), the UI fader and the MCP cap all clamp
 * [0, 1.5] — so a "+12 dB" ask could land a gain no other surface can set or
 * show. The bridge now lands inside the one shared domain.
 */

function bassOf(doc: ReturnType<typeof createDefaultProject>) {
  const bass = doc.tracks.find((track) => track.kind === "instrument" && /bass|808/i.test(track.name));
  if (!bass) throw new Error("default project has no bass instrument track");
  return bass;
}

function setVolume(target: string, volumeDb: number): BridgeCommand {
  return { kind: "set-volume", label: "test", rationale: "test", target: { namePattern: target }, volumeDb };
}

describe("the AI bridge lands track gain inside the command layer's domain", () => {
  it("a +12 dB ask (valid per the bridge's own range) clamps at the shared ceiling", () => {
    const doc = createDefaultProject();
    const bass = bassOf(doc);
    const next = applyBridgeCommandForTest(doc, setVolume(bass.name, 12));
    const landed = next.tracks.find((track) => track.id === bass.id)!.gain;
    expect(landed).toBeLessThanOrEqual(1.5);
    // The ceiling is THE command layer's ceiling - the same value through
    // setTrackParams lands at the same number.
    const viaCommand = setTrackParams(doc, bass.id, { gain: 4 }).execute(doc);
    expect(landed).toBe(viaCommand.tracks.find((track) => track.id === bass.id)!.gain);
  });

  it("an ask inside the domain lands exactly (no silent rescale)", () => {
    const doc = createDefaultProject();
    const bass = bassOf(doc);
    const next = applyBridgeCommandForTest(doc, setVolume(bass.name, -6));
    expect(next.tracks.find((track) => track.id === bass.id)!.gain).toBeCloseTo(10 ** (-6 / 20), 12);
  });
});
