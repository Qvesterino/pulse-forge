import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { addAudioClip, updateAudioClip } from "../src/commands/commands";
import { normalizeProject, migrateProject, SCHEMA_VERSION } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";
import { TriggerEngine } from "../src/audio-engine/triggerEngine";
import { testDoc } from "./fixtures/doc";
import { StretchDialog } from "../src/ui/StretchDialog";

function docWithAudioClip() {
  const doc = testDoc();
  const trackId = doc.tracks.find((track) => track.kind !== "group")!.id;
  const next = addAudioClip(doc, trackId, "audio.pitch-test", 0, 2, {}).execute(doc);
  const clipId = next.arrangement.audioClips![0]!.id;
  return { doc: next, clipId, trackId };
}

describe("independent AudioClip pitch", () => {
  it("stores a semitone offset as one undoable clip edit and clamps its range", () => {
    const { doc, clipId } = docWithAudioClip();
    const command = updateAudioClip(doc, clipId, { pitchSemitones: 7 });
    const next = command.execute(doc);
    expect(next.arrangement.audioClips![0]!.pitchSemitones).toBe(7);
    expect(command.undo(next).arrangement.audioClips![0]!.pitchSemitones).toBeUndefined();

    expect(
      updateAudioClip(doc, clipId, { pitchSemitones: 30 }).execute(doc).arrangement.audioClips![0]!.pitchSemitones,
    ).toBe(24);
    expect(
      updateAudioClip(doc, clipId, { pitchSemitones: -30 }).execute(doc).arrangement.audioClips![0]!.pitchSemitones,
    ).toBe(-24);
    expect(
      updateAudioClip(doc, clipId, { pitchSemitones: 0 }).execute(doc).arrangement.audioClips![0]!.pitchSemitones,
    ).toBeUndefined();
  });

  it("sanitizes persisted pitch and migrates existing projects with neutral pitch", () => {
    const { doc, clipId } = docWithAudioClip();
    const clip = doc.arrangement.audioClips![0]!;
    const malformed: ProjectDocument = {
      ...doc,
      arrangement: { ...doc.arrangement, audioClips: [{ ...clip, pitchSemitones: 30 }] },
    };
    expect(normalizeProject(malformed).arrangement.audioClips![0]!.pitchSemitones).toBe(24);

    const legacy: ProjectDocument = {
      ...doc,
      schemaVersion: 36,
      arrangement: {
        ...doc.arrangement,
        audioClips: [{ ...clip, pitchSemitones: Number.NaN }],
      },
    };
    const migrated = migrateProject(legacy);
    expect(SCHEMA_VERSION).toBe(37);
    expect(migrated.schemaVersion).toBe(37);
    expect(
      migrated.arrangement.audioClips!.find((candidate) => candidate.id === clipId)!.pitchSemitones,
    ).toBeUndefined();
  });

  it("renders and reuses a same-duration pitch variant in the clip trigger", () => {
    const { doc, trackId } = docWithAudioClip();
    const sourceBuffer = makeAudioBuffer(1, 44100, 44100);
    const clip = { ...doc.arrangement.audioClips![0]!, pitchSemitones: 7 };
    const sources: Array<{ buffer: ReturnType<typeof makeAudioBuffer> | null }> = [];
    const cache = new Map<string, ReturnType<typeof makeAudioBuffer>>();
    const ctx = {
      createBuffer: makeAudioBuffer,
      createBufferSource: () => {
        const source = {
          buffer: null as ReturnType<typeof makeAudioBuffer> | null,
          playbackRate: { value: 1 },
          loop: false,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null as (() => void) | null,
        };
        sources.push(source);
        return source;
      },
      createGain: () => ({
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          setValueCurveAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
    };
    const warp = {
      isFrozen: () => false,
      getStretched: (key: string) => cache.get(key),
      storeStretched: (key: string, value: ReturnType<typeof makeAudioBuffer>) => cache.set(key, value),
      getWarp: () => null,
      warmWarp: vi.fn(),
      warpCacheKey: () => "unused",
    };
    const trackInput = { connect: vi.fn(), disconnect: vi.fn() };
    const deps = {
      ctx: () => ctx,
      doc: () => doc,
      bank: () => ({ get: (id: string) => (id === clip.bufferId ? sourceBuffer : null) }),
      currentTime: () => 0,
      trackNodes: new Map([[trackId, { input: trackInput }]]),
      groupNodes: new Map(),
      instrumentStates: new Map(),
      warp,
      trackOneShot: vi.fn(),
      releaseOneShot: vi.fn(),
      missAsset: vi.fn(),
    };
    const engine = new TriggerEngine(deps as never, warp as never);

    engine.triggerAudioClip(clip, 0, 1);
    engine.triggerAudioClip(clip, 1, 1);
    const first = sources[0]!.buffer!;
    const second = sources[1]!.buffer!;
    expect(first).not.toBe(sourceBuffer);
    expect(first.duration).toBe(sourceBuffer.duration);
    expect(first).toBe(second);
    expect(first.getChannelData(0)).not.toEqual(sourceBuffer.getChannelData(0));
  });

  it("exposes independent pitch in the stretch dialog and applies it with the timing settings", () => {
    const onApply = vi.fn();
    render(
      <StretchDialog
        clipName="Loop"
        sourceSec={4}
        initialRate={1}
        initialMode="stretch"
        initialPitch={0}
        detectedBpm={120}
        projectBpm={120}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("slider", { name: "Pitch shift in semitones" }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(1, "stretch", 5);
  });
});

function makeAudioBuffer(channels: number, length: number, sampleRate: number) {
  const data = Array.from({ length: channels }, (_, channel) => {
    const out = new Float32Array(length);
    for (let index = 0; index < length; index++) {
      out[index] = Math.sin((2 * Math.PI * (220 + channel * 20) * index) / sampleRate);
    }
    return out;
  });
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (channel: number) => data[channel]!,
  };
}
