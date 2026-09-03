import { describe, expect, it } from "vitest";
import { buildBounceZoneDoc } from "../src/rendering/bounce";
import { createDefaultProject } from "../src/project-model/schema";
import { addAudioClip, createScene } from "../src/commands/commands";
import { BAR_TICKS } from "../src/project-model/types";

describe("buildBounceZoneDoc", () => {
  it("throws when the zone has no content", () => {
    const doc = createDefaultProject();
    expect(() => buildBounceZoneDoc(doc, [doc.tracks[0].id], { startBar: 100, lengthBars: 4 })).toThrow(
      /Nothing to bounce/u,
    );
  });

  it("throws without tracks", () => {
    const doc = createDefaultProject();
    expect(() => buildBounceZoneDoc(doc, [], { startBar: 0, lengthBars: 4 })).toThrow(/at least one track/u);
  });

  it("clips a scene clip to the zone and shifts it to bar 0", () => {
    let doc = createDefaultProject();
    const scene = createScene(doc, "S");
    doc = scene.execute(doc);
    doc = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        clips: [{ id: "c-big", sceneId: doc.scenes[0].id, startBar: 0, lengthBars: 16 }],
      },
    }; // 16-bar clip placed directly (addAudioClip/addArrangementClip reject overlaps by design)
    const trackIds = [doc.tracks[0].id];
    // Zone = bars 4..8 (middle of the clip) → 4-bar bounce doc from bar 0.
    const bounced = buildBounceZoneDoc(doc, trackIds, { startBar: 4, lengthBars: 4 });
    const clip = bounced.arrangement.clips[0];
    expect(clip.startBar).toBe(0);
    expect(clip.lengthBars).toBe(4);
  });

  it("keeps sample-exact audio clip alignment via offsetSec", () => {
    let doc = createDefaultProject();
    doc = addAudioClip(doc, doc.tracks[0].id, "factory.kick.deep", 0, 8).execute(doc);
    const trackIds = [doc.tracks[0].id];
    // Zone starts at bar 2 → head trim of 2 bars lands in offsetSec.
    const bounced = buildBounceZoneDoc(doc, trackIds, { startBar: 2, lengthBars: 4 });
    const clip = bounced.arrangement.audioClips![0];
    expect(clip.startBar).toBe(0);
    expect(clip.lengthBars).toBe(4);
    expect(clip.offsetSec).toBeCloseTo(2 * BAR_TICKS * (60 / (doc.bpm * 480)), 4);
  });

  it("filters tracks to the selection plus parent groups", () => {
    let doc = createDefaultProject();
    const instrument = doc.tracks.find((t) => t.kind === "instrument")!;
    doc = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        clips: [{ id: "c-4", sceneId: doc.scenes[0].id, startBar: 0, lengthBars: 4 }],
      },
    };
    const bounced = buildBounceZoneDoc(doc, [instrument.id], { startBar: 0, lengthBars: 4 });
    const kinds = bounced.tracks.map((t) => t.kind);
    expect(kinds).not.toContain("drum");
    expect(bounced.arrangement.transitions).toEqual([]);
    expect(bounced.markers).toEqual([]);
  });
});
