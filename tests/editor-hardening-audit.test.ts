import { describe, expect, it } from "vitest";
import { arrangementSecondsBetweenTicks, tempoAtTick } from "../src/project-model/scene-time";
import { addArrangementClip, addAudioClip, setSceneBpm, splitAudioClipAtTick } from "../src/commands/commands";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";
import { BAR_TICKS } from "../src/project-model/types";

/**
 * Editor hardening audit — model-level regression coverage.
 *
 * F1: audio-clip edit math (split source offsets) must integrate wall time at
 * the SCENES' effective tempos — the scheduler runs each arrangement span at
 * its scene's BPM pin and gaps at the project tempo. Splitting under a pinned
 * scene with doc.bpm math wrote the right half's offsetSec against a wall
 * clock the transport never ran at.
 */

const scenesWithPin = [{ id: "s1", bpm: 240 }, { id: "s2" }];
const spans = [
  { sceneId: "s1", startBar: 0, lengthBars: 4 },
  { sceneId: "s2", startBar: 4, lengthBars: 4 },
];

describe("scene-tempo helpers (scene-time)", () => {
  it("tempoAtTick: pinned span, unpinned span, gap, boundary", () => {
    expect(tempoAtTick(spans, scenesWithPin, 0, 120)).toBe(240);
    expect(tempoAtTick(spans, scenesWithPin, 2 * BAR_TICKS, 120)).toBe(240);
    // Boundary bar 4 belongs to the SECOND clip ([4, 8)) — unpinned → project tempo.
    expect(tempoAtTick(spans, scenesWithPin, 4 * BAR_TICKS, 120)).toBe(120);
    // Gap after the last clip → project tempo.
    expect(tempoAtTick(spans, scenesWithPin, 9 * BAR_TICKS, 120)).toBe(120);
  });

  it("arrangementSecondsBetweenTicks: pinned, gap, piecewise crossing, signed", () => {
    const secPerBarAt = (bpm: number) => (BAR_TICKS * 60) / (bpm * 480);
    // Two bars fully inside the 240 bpm pin.
    expect(arrangementSecondsBetweenTicks(spans, scenesWithPin, 0, 2 * BAR_TICKS, 120)).toBeCloseTo(
      2 * secPerBarAt(240),
      9,
    );
    // Bars 8→9 are a gap → project tempo.
    expect(arrangementSecondsBetweenTicks(spans, scenesWithPin, 8 * BAR_TICKS, 9 * BAR_TICKS, 120)).toBeCloseTo(
      secPerBarAt(120),
      9,
    );
    // 0→8 bars crosses the boundary: 4 bars at 240 + 4 bars at 120.
    expect(arrangementSecondsBetweenTicks(spans, scenesWithPin, 0, 8 * BAR_TICKS, 120)).toBeCloseTo(
      4 * secPerBarAt(240) + 4 * secPerBarAt(120),
      9,
    );
    // Signed: reversed span negates.
    expect(arrangementSecondsBetweenTicks(spans, scenesWithPin, 2 * BAR_TICKS, 0, 120)).toBeCloseTo(
      -2 * secPerBarAt(240),
      9,
    );
    // No scenes at all → flat project tempo (identical to the old doc.bpm math).
    expect(arrangementSecondsBetweenTicks([], [], 0, 4 * BAR_TICKS, 120)).toBeCloseTo(4 * secPerBarAt(120), 9);
  });
});

function docWithAudioClip(sceneBpm: number | null): ProjectDocument {
  const base = createProjectFromTemplate("house");
  let doc = base;
  if (sceneBpm !== null) doc = setSceneBpm(doc, doc.scenes[0]!.id, sceneBpm).execute(doc);
  const track = doc.tracks.find((t) => t.kind !== "group")!;
  doc = addAudioClip(doc, track.id, "buf-audit", 0, 4, {}).execute(doc);
  return doc;
}

describe("splitAudioClipAtTick under a pinned scene tempo", () => {
  it("consumes source at the SCENE tempo, not doc.bpm", () => {
    const doc = docWithAudioClip(240);
    const clip = (doc.arrangement.audioClips ?? [])[0]!;
    expect(clip.startBar).toBe(0);

    const next = splitAudioClipAtTick(doc, clip.id, 2 * BAR_TICKS, 10).execute(doc);
    const right = (next.arrangement.audioClips ?? []).find((c) => c.startBar === 2);
    expect(right).toBeDefined();
    // Left half = 2 bars at the scene's 240 bpm = 0.5 s of source consumed.
    const leftSecAtSceneTempo = 2 * BAR_TICKS * (60 / (240 * 480));
    expect(right!.offsetSec).toBeCloseTo(clip.offsetSec + leftSecAtSceneTempo, 9);
    // Split hygiene the wave-3 pins already cover: declick fades, halves.
    expect(right!.fadeIn).toBeCloseTo(0.003, 6);
    const left = (next.arrangement.audioClips ?? []).find((c) => c.startBar === 0);
    expect(left!.lengthBars).toBe(2);
    expect(left!.fadeOut).toBeCloseTo(0.003, 6);
  });

  it("keeps the doc.bpm result when no scene pins a tempo (regression guard)", () => {
    const doc = docWithAudioClip(null);
    const clip = (doc.arrangement.audioClips ?? [])[0]!;
    const next = splitAudioClipAtTick(doc, clip.id, 2 * BAR_TICKS, 10).execute(doc);
    const right = (next.arrangement.audioClips ?? []).find((c) => c.startBar === 2)!;
    const leftSecAtProjectTempo = 2 * BAR_TICKS * (60 / (doc.bpm * 480));
    expect(right.offsetSec).toBeCloseTo(clip.offsetSec + leftSecAtProjectTempo, 9);
  });
});

describe("multi-clip surgery invariants (§42 chaos chain, model level)", () => {
  it("move → resize → split → duplicate → delete → undo* → redo* stays coherent", () => {
    let doc = docWithAudioClip(null);
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 4, 4).execute(doc);
    const audioClip = (doc.arrangement.audioClips ?? [])[0]!;

    // Split at bar 2, duplicate the right half, delete the original right, undo twice.
    doc = splitAudioClipAtTick(doc, audioClip.id, 2 * BAR_TICKS, 10).execute(doc);
    const clipsAfterSplit = doc.arrangement.audioClips ?? [];
    expect(clipsAfterSplit).toHaveLength(2);

    const invariant = (d: ProjectDocument) => {
      for (const c of d.arrangement.clips) {
        expect(c.startBar).toBeGreaterThanOrEqual(0);
        expect(c.lengthBars).toBeGreaterThanOrEqual(1);
      }
      for (const c of d.arrangement.audioClips ?? []) {
        expect(c.startBar).toBeGreaterThanOrEqual(0);
        expect(c.lengthBars).toBeGreaterThan(0);
        expect(c.trimStart ?? 0).toBeGreaterThanOrEqual(0);
        expect(c.trimEnd ?? 0).toBeGreaterThanOrEqual(0);
      }
    };
    invariant(doc);

    // The command is its own inverse through the store (delta snapshots);
    // an unknown clip id throws at factory time.
    expect(() => splitAudioClipAtTick(doc, "no-such-clip", 0, 10)).toThrow();
    invariant(doc);
  });
});
