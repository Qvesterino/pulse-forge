import { describe, expect, it } from "vitest";
import { buildRemix, remixTagsOf, remixTitleOf } from "../src/gallery/remix";
import { encodeProjectForGallery } from "../src/gallery/galleryApi";
import { decodeShareCode } from "../src/export/shareCode";
import { baseDocument } from "../src/project-model/templates";
import type { DrumTrack, Pattern, ProjectDocument } from "../src/project-model/types";

function beatDoc(): ProjectDocument {
  const doc = baseDocument("Original Beat", 124);
  const drum: DrumTrack = {
    id: "drum-rx",
    kind: "drum",
    name: "Drums",
    gain: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
    sends: {},
    pads: [
      {
        id: "rx-kick",
        name: "Kick",
        assetId: null,
        gain: 1,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        chokeGroup: null,
      },
      {
        id: "rx-snr",
        name: "Snare",
        assetId: null,
        gain: 1,
        pan: 0,
        pitch: 0,
        mute: false,
        solo: false,
        chokeGroup: null,
      },
    ],
  };
  const row = (steps: [number, number][]) => {
    const r = new Array<number>(16).fill(0);
    for (const [i, v] of steps) r[i] = v;
    return r;
  };
  const mkPattern = (id: string, name: string, kick: number[], snare: number[]): Pattern => ({
    id,
    name,
    stepCount: 16,
    rows: { "rx-kick": kick, "rx-snr": snare },
    notes: {},
  });
  const p1 = mkPattern(
    "rx-p1",
    "Main",
    row([
      [0, 1],
      [8, 0.9],
    ]),
    row([
      [4, 0.8],
      [12, 0.8],
    ]),
  );
  const p2 = mkPattern("rx-p2", "Quiet", row([[0, 0.7]]), row([[12, 0.5]]));
  return {
    ...doc,
    tracks: [drum],
    patterns: [p1, p2],
    scenes: [
      { id: "rx-s1", name: "Drop A", patternId: "rx-p1", intensity: 0.9, role: "drop" },
      { id: "rx-s2", name: "Chill", patternId: "rx-p2", intensity: 0.4, role: "break" },
    ],
    arrangement: { clips: [] },
  };
}

describe("gallery remix pipeline", () => {
  const source = beatDoc();
  const code = encodeProjectForGallery(source);

  it("turns a beat into a remixed arrangement with a fresh identity", () => {
    const result = buildRemix({ id: "beat-123", title: "Night Drive", code })!;
    expect(result).not.toBeNull();
    expect(result.title).toBe("Remix of Night Drive");
    expect(result.doc.id).not.toBe(source.id);
    expect(result.doc.name).toBe("Remix of Night Drive");
    // Auto-arrange produced an arrangement from the scene grid.
    expect(result.doc.arrangement.clips.length).toBeGreaterThan(0);
    // Both drop-scene patterns were varied (drop roles survive arrange as drops).
    expect(result.variedPatterns).toBeGreaterThan(0);
    // The variation actually changed the drop pattern content.
    const dropScene = result.doc.scenes.find((s) => s.role === "drop");
    expect(dropScene).toBeDefined();
    const varied = result.doc.patterns.find((p) => p.id === dropScene!.patternId)!;
    const original = source.patterns[0];
    const differs =
      JSON.stringify(varied.rows) !== JSON.stringify(original.rows) ||
      JSON.stringify(varied.stepMeta) !== JSON.stringify(original.stepMeta ?? null);
    expect(differs).toBe(true);
    // The result re-encodes and decodes as a valid project.
    const decoded = decodeShareCode(encodeProjectForGallery(result.doc));
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe("Remix of Night Drive");
  });

  it("is deterministic per source beat and differs across source beats", () => {
    const a1 = buildRemix({ id: "beat-A", title: "X", code })!;
    const a2 = buildRemix({ id: "beat-A", title: "X", code })!;
    const b1 = buildRemix({ id: "beat-B", title: "X", code })!;
    const rowsOf = (r: ReturnType<typeof buildRemix>) => JSON.stringify(r!.doc.patterns.map((p) => p.rows));
    expect(rowsOf(a1)).toBe(rowsOf(a2));
    expect(rowsOf(a1)).not.toBe(rowsOf(b1));
  });

  it("returns null for garbage codes", () => {
    expect(buildRemix({ id: "x", title: "X", code: "not-a-code" })).toBeNull();
  });

  it("title and tags follow gallery rules", () => {
    expect(remixTitleOf("Short")).toBe("Remix of Short");
    expect(remixTitleOf("X".repeat(80))).toHaveLength(62); // 61 + ellipsis, ≤ 64
    expect(remixTagsOf(["techno", "UPPER", "way-too-long-tag-name", "ok"])).toEqual(["techno", "ok", "remix"]);
  });
});
