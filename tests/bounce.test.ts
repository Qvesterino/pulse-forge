import { describe, expect, it } from "vitest";
import { buildBounceZoneDoc } from "../src/rendering/bounce";
import { createDefaultProject } from "../src/project-model/schema";
import { addAudioClip, createScene } from "../src/commands/commands";
import { BAR_TICKS, PPQ } from "../src/project-model/types";

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

  it("uses the owning scene BPM for head trim and preserves stretch source-time semantics", () => {
    let doc = createDefaultProject();
    const scene = doc.scenes[0];
    doc = {
      ...doc,
      scenes: doc.scenes.map((candidate) => (candidate.id === scene.id ? { ...candidate, bpm: 62 } : candidate)),
      arrangement: {
        ...doc.arrangement,
        clips: [{ id: "scene-tempo", sceneId: scene.id, startBar: 0, lengthBars: 8 }],
      },
    };
    doc = addAudioClip(doc, doc.tracks[0].id, "factory.kick.deep", 0, 8, { stretchRate: 2 }).execute(doc);

    const bounced = buildBounceZoneDoc(doc, [doc.tracks[0].id], { startBar: 2, lengthBars: 4 });
    const clip = bounced.arrangement.audioClips![0];
    // offsetSec remains in original source seconds. The renderer will apply
    // stretchRate when indexing the pre-stretched buffer later.
    expect(clip.offsetSec).toBeCloseTo(2 * BAR_TICKS * (60 / (62 * PPQ)), 4);
    expect(clip.stretchRate).toBe(2);
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
