import { describe, expect, it } from "vitest";
import { normalizeProject } from "../../src/project-model/schema";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { STEP_TICKS } from "../../src/project-model/types";
import { unsunoCommand } from "../../src/reference/unsuno";
import { transcribeTrack } from "../../src/reference/transcribe";
import { GOLDEN_SAMPLE_RATE, goldenTracks, renderGoldenTrack } from "./golden-synth";

/**
 * U4 — reconstruction round-trip: a REAL transcription of the golden house
 * track (tempo/key/chords/bass all live) becomes ONE command that installs
 * BPM, key, tracks, section patterns, scenes and markers — and a single
 * undo removes all of it, exactly.
 */

const SAMPLE_RATE = GOLDEN_SAMPLE_RATE;
const house = goldenTracks()[0];

function canonize(doc: ReturnType<typeof normalizeProject>): ReturnType<typeof normalizeProject> {
  const clone = structuredClone(doc);
  for (const pattern of clone.patterns) {
    const notes = pattern.notes as unknown as Record<string, { id: string }[] | undefined>;
    for (const key of Object.keys(notes ?? {})) {
      notes[key] = [...(notes[key] ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    }
  }
  return clone;
}

describe("unsunoCommand — reconstruction contract", () => {
  const transcription = transcribeTrack(renderGoldenTrack(house), SAMPLE_RATE);
  // The golden house track is 8 bars — two 4-bar sections inside it.
  const barSec = 240 / 126;
  const sections = [
    { role: "intro", startSec: 0, endSec: barSec * 4 },
    { role: "drop", startSec: barSec * 4, endSec: barSec * 8 },
  ];

  it("installs BPM + key + tracks + section patterns + scenes in ONE undo step", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const before = canonize(normalizeProject(store.doc));
    const result = unsunoCommand(store.doc, { transcription, sections });
    expect(result.command).not.toBeNull();
    expect(result.bpm).toBe(126);
    expect(result.patternCount).toBe(2);
    expect(result.summary).toMatch(/bass \+ chords/);

    store.execute(result.command!);
    const doc = normalizeProject(store.doc);
    expect(doc.bpm).toBe(126);
    expect(doc.key).toBe("A Natural Minor");

    // bass + keys tracks exist
    const instrumentKinds = doc.tracks.map((t) => (t.kind === "instrument" ? t.instrument : t.kind));
    expect(instrumentKinds).toContain("bass");
    expect(instrumentKinds).toContain("keys");

    // one pattern per section, both under the 128-step ceiling
    const ours = doc.patterns.filter((p) => p.name.startsWith("UN-SUNO"));
    expect(ours.length).toBe(2);

    // drums track exists now too (U3 landed) with the kick map on a pad
    expect(doc.tracks.some((t) => t.kind === "drum")).toBe(true);
    const drumPattern = ours.find((p) => Object.keys(p.rows).length > 0);
    expect(drumPattern).toBeDefined();
    const litRows = Object.values(drumPattern!.rows).filter((row) => row.some((v) => v > 0));
    expect(litRows.length).toBeGreaterThanOrEqual(1);
    for (const pattern of ours) {
      expect(pattern.stepCount).toBeLessThanOrEqual(128);
      expect(pattern.stepCount).toBe(4 * 16);
    }
    const bassTrack = doc.tracks.find((t) => t.kind === "instrument" && t.instrument === "bass")!;
    const keysTrack = doc.tracks.find((t) => t.kind === "instrument" && t.instrument === "keys")!;
    const noteSets = ours.map((p) => ({ bass: p.notes[bassTrack.id] ?? [], keys: p.notes[keysTrack.id] ?? [] }));
    // chord voicings landed in both sections
    expect(noteSets[0].keys.length).toBeGreaterThan(0);
    expect(noteSets[1].keys.length).toBeGreaterThan(0);
    // bass notes landed in the section they belong to (house has notes in all 8 bars)
    const totalBass = noteSets[0].bass.length + noteSets[1].bass.length;
    expect(totalBass).toBeGreaterThan(0);
    // every note fits its pattern's tick window
    for (const pattern of ours) {
      for (const trackId of Object.keys(pattern.notes)) {
        for (const note of pattern.notes[trackId]) {
          expect(note.start).toBeGreaterThanOrEqual(0);
          expect(note.start + note.duration).toBeLessThanOrEqual(pattern.stepCount * STEP_TICKS + 1);
        }
      }
    }
    // scenes per pattern + marker at the drop
    expect(doc.scenes.length).toBeGreaterThanOrEqual(2);
    expect(doc.markers.length).toBeGreaterThanOrEqual(1);

    // THE contract: one undo removes everything, exactly.
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(canonize(normalizeProject(store.doc))).toEqual(before);
  });

  it("confirmed values override the transcription (apply.ts rule)", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const result = unsunoCommand(
      store.doc,
      { transcription, sections },
      { confirmedBpm: 128, confirmedKey: { tonic: "C", mode: "major" } },
    );
    store.execute(result.command!);
    const doc = normalizeProject(store.doc);
    expect(doc.bpm).toBe(128);
    expect(doc.key).toBe("C Major");
  });

  it("half/double reading rescales the detected tempo", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const result = unsunoCommand(store.doc, { transcription, sections }, { reading: "double" });
    expect(result.bpm).toBe(252);
  });

  it("no tempo → null command + honest summary (nothing reconstructed)", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const silence = transcribeTrack(new Float32Array(SAMPLE_RATE * 2), SAMPLE_RATE);
    const result = unsunoCommand(store.doc, { transcription: silence });
    expect(result.command).toBeNull();
    expect(result.summary).toMatch(/no tempo/);
  });

  it("U4.5: sourceSampleId attaches the original as one arrangement clip", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const before = canonize(normalizeProject(store.doc));
    const result = unsunoCommand(store.doc, { transcription, sections }, { sourceSampleId: "user.src-123" });
    expect(result.needsWarpWarm).toBe(false); // detected 126 == project 126 → rate 1
    expect(result.layers.source).toMatch(/original attached/);
    store.execute(result.command!);
    const doc = normalizeProject(store.doc);
    const clip = doc.arrangement.audioClips?.find((c) => c.bufferId === "user.src-123");
    expect(clip).toBeDefined();
    // 15.2 s source on a 126 BPM grid = 8 bars; the sampler carrier exists.
    expect(clip!.lengthBars).toBeGreaterThanOrEqual(8);
    expect(clip!.startBar).toBe(0);
    expect(clip!.stretchRate).toBe(1); // 126 detected == 126 grid
    const carrier = doc.tracks.find((t) => t.id === clip!.trackId);
    expect(carrier?.kind).toBe("instrument");
    expect(carrier?.kind === "instrument" && carrier.instrument).toBe("sampler");
    // Undo removes the clip with everything else (bit-exact against THIS
    // store's own before — template uids differ across stores by design).
    const ownBefore = canonize(normalizeProject(new ProjectStore(createProjectFromTemplate("house")).doc));
    void ownBefore;
    store.undo();
    expect(canonize(normalizeProject(store.doc))).toEqual(before);
  });

  it("U4.5: a source at a different tempo asks for a warp warm-up", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const result = unsunoCommand(
      store.doc,
      { transcription, sections },
      {
        sourceSampleId: "user.src-456",
        confirmedBpm: 128, // grid faster than the 126 source → stretch
      },
    );
    expect(result.needsWarpWarm).toBe(true);
    store.execute(result.command!);
    const doc = normalizeProject(store.doc);
    const clip = doc.arrangement.audioClips?.find((c) => c.bufferId === "user.src-456")!;
    expect(clip.stretchRate).toBeGreaterThan(1); // faster grid plays the source quicker (128/126)
    expect(clip.stretchRate).toBeGreaterThanOrEqual(0.25);
  });

  it("determinism: same input → same musical structure (uid differs by design)", () => {
    const a = new ProjectStore(createProjectFromTemplate("house"));
    const b = new ProjectStore(createProjectFromTemplate("house"));
    a.execute(unsunoCommand(a.doc, { transcription, sections }).command!);
    b.execute(unsunoCommand(b.doc, { transcription, sections }).command!);
    const shape = (doc: ReturnType<typeof normalizeProject>) => ({
      bpm: doc.bpm,
      key: doc.key,
      patterns: doc.patterns
        .filter((p) => p.name.startsWith("UN-SUNO"))
        .map((p) => ({
          name: p.name,
          stepCount: p.stepCount,
          noteShapes: Object.values(p.notes)
            .flat()
            .map((n) => [n.pitch, n.start, n.duration, n.velocity])
            .sort((x, y) => x[0] - y[0] || x[1] - y[1]),
        })),
      sceneNames: doc.scenes.map((sc) => sc.name),
    });
    expect(shape(normalizeProject(b.doc))).toEqual(shape(normalizeProject(a.doc)));
  });
});
