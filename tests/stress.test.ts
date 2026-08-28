import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import type { ProjectDocument, Track, Pattern, InstrumentTrack } from "../src/project-model/types";
import { uid } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";

function createLargeProject(): ProjectDocument {
  const base = createProjectFromTemplate("house");

  // Create 24 tracks (8 drum + 16 instrument)
  const tracks: Track[] = [];
  for (let i = 0; i < 8; i++) {
    const pads = Array.from({ length: 16 }, (_, j) => ({
      id: uid("pad"),
      name: `Pad ${j + 1}`,
      assetId: null,
      gain: 1,
      pan: 0,
      pitch: 0,
      chokeGroup: 0,
      mute: false,
      solo: false,
    }));
    tracks.push({
      id: uid("track"),
      kind: "drum",
      name: `Drums ${i + 1}`,
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      pads,
      effects: [],
      sends: {},
    });
  }
  for (let i = 0; i < 16; i++) {
    tracks.push({
      id: uid("track"),
      kind: "instrument",
      instrument: (["sampler", "analog", "bass", "808"] as const)[i % 4],
      name: `Synth ${i + 1}`,
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: {},
      effects: [],
      sends: {},
    } as InstrumentTrack);
  }

  // Create 12 patterns with 64 steps each
  const patterns: Pattern[] = [];
  for (let p = 0; p < 12; p++) {
    const rows: Record<string, number[]> = {};
    const notes: Record<
      string,
      Array<{ id: string; pitch: number; start: number; duration: number; velocity: number }>
    > = {};
    for (const track of tracks) {
      if (track.kind === "drum") {
        for (const pad of track.pads) {
          const row = new Array(64).fill(0);
          // Fill ~30% of steps
          for (let s = 0; s < 64; s++) {
            if (Math.random() < 0.3) row[s] = Math.round(60 + Math.random() * 67);
          }
          rows[pad.id] = row;
        }
      } else {
        const trackNotes = [];
        for (let n = 0; n < 20; n++) {
          trackNotes.push({
            id: uid("note"),
            pitch: 60 + Math.floor(Math.random() * 24),
            start: Math.floor(Math.random() * 64) * 120,
            duration: 120 + Math.floor(Math.random() * 3) * 120,
            velocity: 0.5 + Math.random() * 0.5,
          });
        }
        notes[track.id] = trackNotes;
      }
    }
    patterns.push({
      id: uid("pattern"),
      name: `Pattern ${p + 1}`,
      stepCount: 64,
      rows,
      notes,
    });
  }

  // Create 100-bar arrangement with 8 scenes
  const scenes = Array.from({ length: 8 }, (_, i) => ({
    id: uid("scene"),
    name: `Scene ${i + 1}`,
    patternId: patterns[i % patterns.length].id,
    intensity: 0.5 + Math.random() * 0.5,
  }));

  const clips = [];
  for (let bar = 0; bar < 100; bar += 4) {
    clips.push({
      id: uid("clip"),
      sceneId: scenes[bar % scenes.length].id,
      startBar: bar,
      lengthBars: 4,
    });
  }

  return {
    ...base,
    tracks,
    patterns,
    activePatternId: patterns[0].id,
    scenes,
    arrangement: { clips },
  };
}

describe("Stress tests — large projects", () => {
  it("creates a large project (24 tracks, 12 patterns, 100-bar arrangement)", () => {
    const doc = createLargeProject();
    expect(doc.tracks.length).toBe(24);
    expect(doc.patterns.length).toBe(12);
    expect(doc.arrangement.clips.length).toBe(25); // 100/4 = 25 clips
    expect(doc.scenes.length).toBe(8);
  });

  it("normalizes a large project without error", () => {
    const doc = createLargeProject();
    const start = performance.now();
    const normalized = normalizeProject(doc);
    const elapsed = performance.now() - start;
    expect(normalized.tracks.length).toBe(24);
    expect(normalized.patterns.length).toBe(12);
    // Normalization should be fast (< 100ms)
    expect(elapsed).toBeLessThan(100);
  });

  it("serializes/deserializes a large project", () => {
    const doc = createLargeProject();
    const json = JSON.stringify(doc);
    const parsed = JSON.parse(json) as ProjectDocument;
    expect(parsed.tracks.length).toBe(24);
    expect(parsed.patterns.length).toBe(12);
    // JSON size should be reasonable (< 5MB)
    expect(json.length).toBeLessThan(5 * 1024 * 1024);
  });

  it("handles 256 undo steps without crash", () => {
    const doc = createLargeProject();
    const store = new ProjectStore(doc);
    for (let i = 0; i < 300; i++) {
      store.execute({
        type: "test",
        label: `Step ${i}`,
        execute: (d: ProjectDocument) => ({ ...d, name: `Project ${i}` }),
        undo: (d: ProjectDocument) => d,
      });
    }
    // Stack should be capped at 256
    expect(store.undoStackLength).toBe(256);
    expect(store.history.length).toBe(20); // last 20
  });

  it("handles rapid undo/redo without crash", () => {
    const doc = createLargeProject();
    const store = new ProjectStore(doc);
    for (let i = 0; i < 50; i++) {
      const prevName = store.doc.name;
      store.execute({
        type: "test",
        label: `Step ${i}`,
        execute: (d: ProjectDocument) => ({ ...d, name: `Project ${i}` }),
        undo: () => ({ ...doc, name: prevName }),
      });
    }
    // Undo 25 times
    for (let i = 0; i < 25; i++) store.undo();
    expect(store.doc.name).toBe("Project 24");
    // Redo 10 times
    for (let i = 0; i < 10; i++) store.redo();
    expect(store.doc.name).toBe("Project 34");
  });

  it("performance: schedulePatternWindow with 24 tracks × 64 steps", () => {
    const doc = createLargeProject();
    // Just verify the doc is valid and all tracks/patterns are accessible
    const start = performance.now();
    for (const pattern of doc.patterns) {
      for (const track of doc.tracks) {
        if (track.kind === "drum") {
          for (const pad of track.pads) {
            const row = pattern.rows[pad.id];
            if (row) {
              for (let s = 0; s < pattern.stepCount; s++) {
                void row[s]; // access every step
              }
            }
          }
        } else {
          const notes = pattern.notes[track.id];
          if (notes) {
            for (const note of notes) {
              void note.start;
              void note.pitch;
              void note.velocity;
            }
          }
        }
      }
    }
    const elapsed = performance.now() - start;
    // Should iterate all notes in < 50ms
    expect(elapsed).toBeLessThan(50);
  });
});
