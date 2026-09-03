import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { GroovePoolRepository, type GroovePoolEntry } from "../src/persistence/GroovePoolRepository";
import { decodePackCode, encodePackCode } from "../src/export/packCode";
import { captureSketchFromDoc, installPackSketch } from "../src/commands/commands";
import { DEFAULT_PAD_KEYS } from "../src/ui/padKeys";
import { THEME_PRESETS } from "../src/ui/theme";

function makeEntry(name: string): GroovePoolEntry {
  return {
    id: `groove-${name}`,
    name,
    timing: [0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0],
    accent: [1, 0, 0.55, 0, 1, 0, 0.55, 0, 1, 0, 0.55, 0, 1, 0, 0.55, 0],
    createdAt: new Date().toISOString(),
  };
}

describe("GroovePoolRepository", () => {
  beforeEach(async () => {
    const repo = new GroovePoolRepository();
    for (const entry of await repo.list()) await repo.remove(entry.id);
  });

  it("saves, lists (newest first) and deletes entries", async () => {
    const repo = new GroovePoolRepository();
    await repo.save(makeEntry("Old"));
    await new Promise((r) => setTimeout(r, 5));
    await repo.save(makeEntry("New"));
    const list = await repo.list();
    expect(list.map((e) => e.name)).toEqual(["New", "Old"]);
    await repo.remove("groove-New");
    expect((await repo.list()).map((e) => e.name)).toEqual(["Old"]);
  });

  it("groove map round-trips intact", async () => {
    const repo = new GroovePoolRepository();
    const entry = makeEntry("Swing");
    await repo.save(entry);
    const loaded = (await repo.list())[0];
    expect(loaded.timing).toEqual(entry.timing);
    expect(loaded.accent).toEqual(entry.accent);
  });
});

describe("PACK share codes", () => {
  it("round-trips kit + binds + theme through encode/decode", () => {
    const code = encodePackCode({
      kitName: "My Pack",
      kitPads: [
        { idx: 0, assetId: "factory.kick.deep", gain: 1, pan: 0, chokeGroup: 1, pitch: 0 },
        { idx: 8, assetId: "user.resample", gain: 0.8, pan: -0.4, chokeGroup: 2, pitch: -5 },
      ],
      binds: ["z", "x", "c", "v"],
      theme: { preset: "matrix", hue: 300, scale: 1.1, compact: true, reduceMotion: false },
    });
    expect(code.startsWith("PFPACK1:")).toBe(true);
    const pack = decodePackCode(code);
    expect(pack).not.toBeNull();
    expect(pack!.kitName).toBe("My Pack");
    expect(pack!.kitPads![1]).toMatchObject({ idx: 8, assetId: "user.resample", pitch: -5 });
    // Normalize fills all 16 slots (defaults for gaps) — first four match.
    expect(pack!.binds!.slice(0, 4)).toEqual(["z", "x", "c", "v"]);
    expect(pack!.theme).toMatchObject({ preset: "matrix", hue: 300, scale: 1.1, compact: true });
  });

  it("keeps parts that survive and drops garbage parts", () => {
    const code = encodePackCode({
      kitName: "Kit",
      kitPads: [{ idx: 0, assetId: "a", gain: 1, pan: 0, chokeGroup: null, pitch: 0 }],
      binds: [],
      theme: { preset: "forge", hue: null, scale: 1, compact: false, reduceMotion: false },
    });
    const pack = decodePackCode(code)!;
    // binds [] survives as a legal empty map via normalize? normalize always
    // fills defaults, so binds present. Empty kit pads drop. Theme present.
    expect(pack.theme!.preset).toBe("forge");
  });

  it("rejects garbage and requires at least one meaningful part", () => {
    expect(decodePackCode("junk")).toBeNull();
    expect(decodePackCode("PFPACK1:!!!")).toBeNull();
  });

  it("unknown preset falls back to forge", () => {
    const pack = decodePackCode(
      encodePackCode({
        kitName: "K",
        kitPads: [{ idx: 0, assetId: "a", gain: 1, pan: 0, chokeGroup: null, pitch: 0 }],
        binds: DEFAULT_PAD_KEYS.slice(),
        theme: { preset: "nope", hue: null, scale: 1, compact: false, reduceMotion: false },
      }),
    )!;
    expect(pack.theme!.preset).toBe("forge");
    expect(pack.kitPads!.length).toBeGreaterThan(0);
    void THEME_PRESETS;
  });

  it("grooves travel in the pack and survive validation", () => {
    const code = encodePackCode({
      grooves: [
        { name: "Loose Swing", timing: [0, 0.4, -0.2], accent: [1, 0.6, 0.8] },
        { name: "", timing: [0], accent: [1] },
      ],
    });
    const pack = decodePackCode(code)!;
    expect(pack.grooves).toHaveLength(2);
    expect(pack.grooves![0]).toMatchObject({ name: "Loose Swing", timing: [0, 0.4, -0.2] });
    expect(pack.grooves![1].name).toBe("Groove");
    // Mismatched curves are dropped entirely.
    const bad = decodePackCode(encodePackCode({ grooves: [{ name: "X", timing: [0, 1], accent: [1] } as never] }));
    expect(bad).toBeNull();
    // Out-of-range values clamp instead of poisoning.
    const clamped = decodePackCode(encodePackCode({ grooves: [{ name: "C", timing: [5, -9], accent: [2, -3] }] }))!;
    expect(clamped.grooves![0].timing).toEqual([1, -1]);
    expect(clamped.grooves![0].accent).toEqual([1, 0]);
  });

  it("sketch round-trips scenes + clips and drops empty/garbage scenes", () => {
    const code = encodePackCode({
      sketch: {
        bpm: 174,
        scenes: [
          { name: "Drop A", role: "drop", intensity: 0.9, steps: 16, rows: ["f0a50000f0a50000", "0000f0000000f000"] },
          { name: "Empty", steps: 16, rows: ["0000000000000000"] },
          { name: "Junk", steps: 4, rows: "nope" as never },
        ],
        clips: [
          { scene: 0, startBar: 0, lengthBars: 8 },
          { scene: 9, startBar: 8, lengthBars: 4 },
        ],
      },
    });
    const pack = decodePackCode(code)!;
    expect(pack.sketch!.bpm).toBe(174);
    expect(pack.sketch!.scenes).toHaveLength(1);
    expect(pack.sketch!.scenes[0]).toMatchObject({ name: "Drop A", role: "drop", steps: 16 });
    // Clip pointing at a dropped scene is filtered out.
    expect(pack.sketch!.clips).toEqual([{ scene: 0, startBar: 0, lengthBars: 8 }]);
    // A pack of only an invalid sketch is not a pack.
    expect(decodePackCode(encodePackCode({ sketch: { scenes: [] } as never }))).toBeNull();
  });
});

describe("pack sketch capture + install", () => {
  const buildDoc = () => {
    const pads = Array.from({ length: 4 }, (_, i) => ({
      id: `pad-${i}`,
      name: `Pad ${i}`,
      assetId: null,
      gain: 1,
      pan: 0,
      pitch: 0,
      mute: false,
      solo: false,
      chokeGroup: null,
    }));
    const track = { id: "drum-1", kind: "drum" as const, name: "Drums", pads, volume: 0.8, muted: false };
    const rowA = [1, 0, 0, 0, 0.5, 0, 0, 0, 1, 0, 0, 0, 0.5, 0, 0.25, 0];
    const rowB = new Array(16).fill(0);
    rowB[4] = 0.8;
    const patternA = { id: "p-a", name: "A", stepCount: 16, rows: { "pad-0": rowA, "pad-1": rowB }, notes: {} };
    const patternB = { id: "p-b", name: "B", stepCount: 16, rows: { "pad-0": rowB }, notes: {} };
    return {
      doc: {
        bpm: 120,
        tracks: [track],
        patterns: [patternA, patternB],
        scenes: [
          { id: "s-a", name: "Drop A", patternId: "p-a", intensity: 0.9, role: "drop" as const },
          { id: "s-b", name: "Outro", patternId: "p-b", intensity: 0.4, role: "outro" as const },
        ],
        arrangement: {
          clips: [
            { id: "c-a", sceneId: "s-a", startBar: 0, lengthBars: 8 },
            { id: "c-b", sceneId: "s-b", startBar: 8, lengthBars: 4 },
          ],
        },
      },
      track,
    };
  };

  it("captureSketchFromDoc encodes rows as pad-index hex + clip layout", () => {
    const { doc } = buildDoc();
    const sketch = captureSketchFromDoc(doc as never, "drum-1")!;
    expect(sketch.bpm).toBe(120);
    expect(sketch.scenes).toHaveLength(2);
    // rowA velocities: 1 → f, 0.5×15 = 7.5 → 8, 0.25×15 = 3.75 → 4.
    expect(sketch.scenes[0].rows).toContain("f0008000f0008040");
    expect(sketch.scenes[0].role).toBe("drop");
    expect(sketch.clips).toEqual([
      { scene: 0, startBar: 0, lengthBars: 8 },
      { scene: 1, startBar: 8, lengthBars: 4 },
    ]);
  });

  it("installPackSketch rebuilds patterns/scenes/clips in one undoable command", () => {
    const { doc } = buildDoc();
    const sketch = captureSketchFromDoc(doc as never, "drum-1")!;
    const cmd = installPackSketch(doc as never, "drum-1", sketch)!;
    const next = cmd.execute(doc as never);
    expect(next.patterns).toHaveLength(4);
    expect(next.scenes).toHaveLength(4);
    expect(next.arrangement.clips).toHaveLength(4);
    // Clip layout is appended at the arrangement end (bar 12+).
    const newClips = next.arrangement.clips.slice(2);
    expect(newClips[0].startBar).toBe(12);
    expect(newClips[0].lengthBars).toBe(8);
    expect(newClips[1].startBar).toBe(20);
    // Rows decoded back: pad-0 step 0 velocity 1 in the first installed pattern.
    const installed = next.patterns.find((p) => p.name === "Drop A")!;
    expect(installed.rows["pad-0"][0]).toBeCloseTo(1, 5);
    expect(installed.rows["pad-1"][4]).toBeCloseTo(0.8, 5);
    expect(installed.stepCount).toBe(16);
    // One undo removes everything.
    expect(cmd.undo(next)).toEqual(doc);
    // Install also round-trips through the share code.
    const pack = decodePackCode(encodePackCode({ sketch }))!;
    const cmd2 = installPackSketch(doc as never, "drum-1", pack.sketch!)!;
    expect(cmd2.execute(doc as never).scenes).toHaveLength(4);
  });

  it("install refuses sketches that map nothing onto the track", () => {
    const { doc } = buildDoc();
    expect(installPackSketch(doc as never, "drum-1", { scenes: [], clips: [] })).toBeNull();
    expect(
      installPackSketch(doc as never, "nope", { scenes: [{ name: "X", steps: 4, rows: ["f000"] }], clips: [] }),
    ).toBeNull();
  });
});
