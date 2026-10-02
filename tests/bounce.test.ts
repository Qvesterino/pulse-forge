import { describe, expect, it, vi } from "vitest";
import {
  buildAudioClipConsolidationDoc,
  buildBounceZoneDoc,
  buildTimeRangeConsolidationDoc,
} from "../src/rendering/bounce";
import { createDefaultProject } from "../src/project-model/schema";
import { addAudioClip, createScene } from "../src/commands/commands";
import { BAR_TICKS, PPQ } from "../src/project-model/types";
import { consolidateRangeToAudio } from "../src/services/rangeConsolidation";
import { renderProject } from "../src/rendering/renderer";

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

  it("moves absolute warp pins into the zone-relative render timeline", () => {
    let doc = createDefaultProject();
    const track = doc.tracks.find((candidate) => candidate.kind !== "group")!;
    doc = addAudioClip(doc, track.id, "audio.warped", 0, 8, {
      warpMarkers: [
        { timeSec: 0, tick: 0 },
        { timeSec: 2, tick: BAR_TICKS * 4 },
        { timeSec: 4, tick: BAR_TICKS * 8 },
      ],
    }).execute(doc);

    const bounced = buildBounceZoneDoc(doc, [track.id], { startBar: 2, lengthBars: 4 });
    expect(bounced.arrangement.audioClips?.[0]?.warpMarkers?.map((marker) => marker.tick)).toEqual([
      -BAR_TICKS * 2,
      BAR_TICKS * 2,
      BAR_TICKS * 6,
    ]);
  });

  it("builds a full-mix consolidation zone while preserving source mute state", () => {
    let doc = createDefaultProject();
    const scene = doc.scenes[0]!;
    const tracks = doc.tracks.filter((track) => track.kind !== "group");
    const mutedTrackId = tracks[0]!.id;
    const audioTrackId = tracks[1]!.id;
    doc = {
      ...doc,
      tracks: doc.tracks.map((track) => (track.id === mutedTrackId ? { ...track, mute: true } : track)),
      arrangement: {
        ...doc.arrangement,
        clips: [{ id: "inside", sceneId: scene.id, startBar: 4, lengthBars: 4 }],
      },
    };
    doc = addAudioClip(doc, audioTrackId, "audio.inside", 5, 1).execute(doc);

    const plan = buildTimeRangeConsolidationDoc(doc, BAR_TICKS * 4, BAR_TICKS * 8);
    expect(plan).toMatchObject({ startBar: 4, lengthBars: 4 });
    expect(plan.project.tracks).toHaveLength(doc.tracks.length);
    expect(plan.project.tracks.find((track) => track.id === mutedTrackId)?.mute).toBe(true);
    expect(plan.project.arrangement.clips[0]).toMatchObject({ startBar: 0, lengthBars: 4 });
    expect(plan.project.arrangement.audioClips?.[0]).toMatchObject({ startBar: 1, lengthBars: 1 });
  });

  it("rejects ranges crossing clip boundaries and ranges rendered with Solo active", () => {
    const base = createDefaultProject();
    const scene = base.scenes[0]!;
    const crossingClip = {
      ...base,
      arrangement: {
        ...base.arrangement,
        clips: [{ id: "crossing", sceneId: scene.id, startBar: 0, lengthBars: 8 }],
      },
    };
    expect(() => buildTimeRangeConsolidationDoc(crossingClip, BAR_TICKS * 4, BAR_TICKS * 8)).toThrow(
      /arrangement clip crosses/u,
    );

    const track = base.tracks.find((candidate) => candidate.kind !== "group")!;
    const crossingAudio = addAudioClip(base, track.id, "audio.crossing", 2, 4).execute(base);
    expect(() => buildTimeRangeConsolidationDoc(crossingAudio, BAR_TICKS * 4, BAR_TICKS * 8)).toThrow(
      /audio clip crosses/u,
    );

    const solo = { ...base, tracks: base.tracks.map((candidate) => ({ ...candidate, solo: true })) };
    expect(() => buildTimeRangeConsolidationDoc(solo, BAR_TICKS * 2, BAR_TICKS * 4)).toThrow(/turn off solo/i);
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

describe("buildAudioClipConsolidationDoc", () => {
  it("isolates selected clips, clears musical content and renders without track processing", () => {
    let doc = createDefaultProject();
    const track = doc.tracks.find((candidate) => candidate.kind !== "group");
    if (!track) throw new Error("default project has no audio-capable track");
    doc = {
      ...doc,
      tracks: doc.tracks.map((candidate) =>
        candidate.id === track.id ? { ...candidate, gain: 0.4, pan: 0.6, sends: { return1: 0.8 } } : candidate,
      ),
    };
    doc = addAudioClip(doc, track.id, "audio.first", 0, 1).execute(doc);
    doc = addAudioClip(doc, track.id, "audio.second", 1, 1).execute(doc);
    doc = addAudioClip(doc, track.id, "audio.unselected", 4, 1).execute(doc);
    const clipIds = doc.arrangement.audioClips!.slice(0, 2).map((clip) => clip.id);
    const originalClips = doc.arrangement.audioClips;

    const plan = buildAudioClipConsolidationDoc(doc, clipIds);
    const renderedTrack = plan.project.tracks.find((candidate) => candidate.id === track.id);

    expect(plan).toMatchObject({ trackId: track.id, startBar: 0, lengthBars: 2 });
    expect(plan.project.arrangement.audioClips?.map((clip) => clip.bufferId)).toEqual(["audio.first", "audio.second"]);
    expect(renderedTrack).toMatchObject({ gain: 1, pan: 0, mute: false, solo: false, effects: [], sends: {} });
    expect(plan.project.patterns.every((pattern) => Object.keys(pattern.rows).length === 0)).toBe(true);
    expect(plan.project.patterns.every((pattern) => Object.keys(pattern.notes ?? {}).length === 0)).toBe(true);
    expect(plan.project.returns).toEqual([]);
    expect(plan.project.automation).toEqual([]);
    expect(plan.project.sceneAutomation).toEqual([]);
    expect(doc.arrangement.audioClips).toBe(originalClips);
    expect(doc.arrangement.audioClips).toHaveLength(3);
  });

  it("rejects selections spanning multiple take lanes", () => {
    let doc = createDefaultProject();
    const track = doc.tracks[0];
    if (!track) throw new Error("default project has no track");
    doc = addAudioClip(doc, track.id, "audio.take-a", 0, 1).execute(doc);
    doc = addAudioClip(doc, track.id, "audio.take-b", 1, 1).execute(doc);
    const clips = doc.arrangement.audioClips ?? [];
    doc = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: clips.map((clip, index) => ({ ...clip, takeGroupId: "takes", takeId: `take-${index}` })),
        takeGroups: [{ id: "takes", trackId: track.id, activeTakeId: "take-0" }],
      },
    };

    expect(() =>
      buildAudioClipConsolidationDoc(
        doc,
        clips.map((clip) => clip.id),
      ),
    ).toThrow("Consolidate clips from one take lane at a time");
  });
});

describe("consolidateRangeToAudio", () => {
  it("renders, persists, and applies the range print as one undoable command", async () => {
    const initial = createDefaultProject();
    const sourceDoc = {
      ...initial,
      arrangement: {
        ...initial.arrangement,
        clips: [{ id: "print-source", sceneId: initial.scenes[0]!.id, startBar: 0, lengthBars: 1 }],
      },
    };
    let currentDoc = sourceDoc;
    const buffer = fakeAudioBuffer();
    const render = vi.fn<typeof renderProject>().mockResolvedValue(buffer);
    const bank = { add: vi.fn(), remove: vi.fn() };
    const userSamples = { save: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    const runtime = {
      store: {
        getDoc: () => currentDoc,
        execute: vi.fn((command: import("../src/commands/types").Command) => {
          currentDoc = command.execute(currentDoc);
        }),
      },
      engine: { getLiveAudioContext: () => ({ sampleRate: 48000 }) as AudioContext },
      bank: bank as never,
      userSamples: userSamples as never,
    };

    const command = await consolidateRangeToAudio(runtime, { fromTick: 0, toTick: BAR_TICKS }, () => true, render);

    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0]?.[2]).toMatchObject({
      mode: "song",
      sampleRate: 48000,
      tailSeconds: 0,
      masterProcessing: false,
      minimumDurationTicks: BAR_TICKS,
      arrangementOnly: true,
    });
    expect(userSamples.save).toHaveBeenCalledOnce();
    expect(bank.add).toHaveBeenCalledOnce();
    expect(runtime.store.execute).toHaveBeenCalledOnce();
    expect(currentDoc.arrangement.audioClips).toHaveLength(1);
    expect(command.undo(currentDoc)).toEqual(sourceDoc);
  });

  it("discards a completed render if the project changes before the commit", async () => {
    const initial = createDefaultProject();
    const sourceDoc = {
      ...initial,
      arrangement: {
        ...initial.arrangement,
        clips: [{ id: "print-source", sceneId: initial.scenes[0]!.id, startBar: 0, lengthBars: 1 }],
      },
    };
    let currentDoc = sourceDoc;
    const userSamples = { save: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    const render = vi.fn<typeof renderProject>().mockImplementation(async () => {
      currentDoc = { ...sourceDoc, name: "concurrent edit" };
      return fakeAudioBuffer();
    });
    const runtime = {
      store: { getDoc: () => currentDoc, execute: vi.fn() },
      engine: { getLiveAudioContext: () => null },
      bank: { add: vi.fn(), remove: vi.fn() } as never,
      userSamples: userSamples as never,
    };

    await expect(
      consolidateRangeToAudio(runtime, { fromTick: 0, toTick: BAR_TICKS }, () => true, render),
    ).rejects.toThrow(/changed while rendering/u);
    expect(userSamples.save).not.toHaveBeenCalled();
    expect(runtime.store.execute).not.toHaveBeenCalled();
  });
});

function fakeAudioBuffer(): AudioBuffer {
  const channels = [new Float32Array([0.1, -0.2, 0.3, -0.4]), new Float32Array([0.2, -0.1, 0.4, -0.3])];
  return {
    length: 4,
    numberOfChannels: channels.length,
    sampleRate: 44100,
    duration: 4 / 44100,
    getChannelData: (channel: number) => channels[channel]!,
  } as unknown as AudioBuffer;
}
