// Audit E-02: the export must not silently lose a sound.
//
// A clip whose audio asset is missing is DROPPED by the trigger engine. Before
// this guard the render completed, the file was written and the status said
// "exported" — a master that quietly lost a part, with nothing to notice it.
//
// The teeth probe: make `assertExportAssetsPresent` return early (or drop the
// `missAsset` call in the trigger engine) and the RED cases below go green
// again — which is the point: the guard is the only thing standing between a
// missing sample and a file that lies.

import { describe, expect, it, vi } from "vitest";
import { assertExportAssetsPresent } from "../src/rendering/renderer";
import { TriggerEngine, type TriggerEngineDeps } from "../src/audio-engine/triggerEngine";
import { createDefaultProject } from "../src/project-model/schema";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";
import type { SampleBank } from "../src/sample-library/factory";

function bankWith(ids: string[]): SampleBank {
  const present = new Set(ids);
  return {
    has: (id: string | null) => (id ? present.has(id) : false),
    get: (id: string | null) => (id && present.has(id) ? ({} as AudioBuffer) : undefined),
  } as unknown as SampleBank;
}

function makeClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "clip-1",
    trackId: "track-1",
    bufferId: "asset-1",
    startBar: 0,
    lengthBars: 1,
    offsetSec: 0,
    trimStart: 0,
    trimEnd: 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    stretchRate: 1,
    reverse: false,
    ...overrides,
  };
}

/** A default project with one audio clip on the first track. */
function projectWithClip(clip: AudioClip): ProjectDocument {
  const base = createDefaultProject();
  const track = base.tracks[0]!;
  return {
    ...base,
    tracks: base.tracks.map((candidate) => (candidate.id === track.id ? { ...candidate, name: "VOCALS" } : candidate)),
    arrangement: { ...base.arrangement, audioClips: [{ ...clip, trackId: track.id }] },
  };
}

describe("export assets (audit E-02)", () => {
  it("REFUSES an export whose clip asset is missing, and names the asset", () => {
    const doc = projectWithClip(makeClip({ bufferId: "user.missing-take" }));

    let thrown: unknown = null;
    try {
      assertExportAssetsPresent(doc, bankWith([]), "song");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("user.missing-take");
    expect(message).toContain("clip-1");
    expect(message).toContain("VOCALS");
  });

  it("lets an export through when every clip asset is present", () => {
    const doc = projectWithClip(makeClip({ bufferId: "user.take-1" }));
    expect(() => assertExportAssetsPresent(doc, bankWith(["user.take-1"]), "song")).not.toThrow();
  });

  it("does NOT block the export for a clip on a muted track (the sound was inaudible anyway)", () => {
    const base = createDefaultProject();
    const track = base.tracks[0]!;
    const doc: ProjectDocument = {
      ...base,
      tracks: base.tracks.map((candidate) => (candidate.id === track.id ? { ...candidate, mute: true } : candidate)),
      arrangement: {
        ...base.arrangement,
        audioClips: [makeClip({ trackId: track.id, bufferId: "user.missing-take" })],
      },
    };

    expect(() => assertExportAssetsPresent(doc, bankWith([]), "song")).not.toThrow();
  });

  it("does NOT block a pattern-mode export (no arrangement audio is rendered)", () => {
    const doc = projectWithClip(makeClip({ bufferId: "user.missing-take" }));
    expect(() => assertExportAssetsPresent(doc, bankWith([]), "pattern")).not.toThrow();
  });

  it("does NOT block the export for a clip-level muted clip (playback skips it entirely)", () => {
    const doc = projectWithClip(makeClip({ bufferId: "user.missing-take", muted: true }));
    expect(() => assertExportAssetsPresent(doc, bankWith([]), "song")).not.toThrow();
  });

  it("the trigger engine REPORTS the dropped clip instead of dropping it silently", () => {
    const doc = projectWithClip(makeClip({ bufferId: "user.missing-take" }));
    const trackId = doc.tracks[0]!.id;
    const missAsset = vi.fn();
    const deps: TriggerEngineDeps = {
      ctx: () => ({}) as BaseAudioContext,
      doc: () => doc,
      bank: () => bankWith([]),
      currentTime: () => 0,
      trackNodes: new Map([[trackId, { input: {} as GainNode }]]),
      groupNodes: new Map(),
      instrumentStates: new Map(),
      warp: { isFrozen: () => false } as unknown as ConstructorParameters<typeof TriggerEngine>[1],
      trackOneShot: () => {},
      releaseOneShot: () => {},
      missAsset,
    };

    const engine = new TriggerEngine(deps, deps.warp);
    engine.triggerAudioClip(makeClip({ trackId, bufferId: "user.missing-take" }), 0);

    expect(missAsset).toHaveBeenCalledWith("user.missing-take");
  });
});
