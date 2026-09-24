import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { resolveVocalTake, pickVocalClip, downmixBuffer } from "../src/vocal/resolve";
import type { SampleBank } from "../src/sample-library/factory";
import type { AudioClip, ProjectDocument } from "../src/project-model/types";

/**
 * VOCAL TAKE RESOLVER — arrangement clip + bank buffer → analyzer PCM.
 * All audio is synthesized stubs (fake bank + fake AudioBuffers); no IDB,
 * no audio context. The resolver is pure slicing math over injected state.
 */

const SR = 44100;

function fakeBuffer(channels: Float32Array[]): {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData: (channel: number) => Float32Array;
} {
  const length = Math.max(...channels.map((c) => c.length));
  return {
    numberOfChannels: channels.length,
    length,
    sampleRate: SR,
    getChannelData: (channel: number) => channels[channel] ?? new Float32Array(length),
  };
}

function fakeBank(buffers: Record<string, ReturnType<typeof fakeBuffer>>): SampleBank {
  return {
    get: (id: string | null) => (id ? (buffers[id] as unknown as AudioBuffer) : undefined),
    has: (id: string | null) => (id ? id in buffers : false),
  } as unknown as SampleBank;
}

function clipWith(overrides: Partial<AudioClip>): AudioClip {
  return {
    id: "clip-v1",
    trackId: "track-1",
    bufferId: "vocal.take1",
    startBar: 0,
    lengthBars: 4,
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

function docWithClips(clips: AudioClip[]): ProjectDocument {
  const doc = testDoc();
  return { ...doc, arrangement: { ...doc.arrangement, audioClips: clips } };
}

describe("downmixBuffer (never mutates the bank buffer)", () => {
  it("averages stereo to mono", () => {
    const left = new Float32Array([1, 1, 1, 1]);
    const right = new Float32Array([0, 0, 0, 0]);
    const mono = downmixBuffer(fakeBuffer([left, right]));
    expect(Array.from(mono)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(left[0]).toBe(1); // source untouched
  });
});

describe("pickVocalClip", () => {
  it("prefers the explicit clipId, falls back to the longest clip", () => {
    const doc = docWithClips([clipWith({ id: "short", lengthBars: 2 }), clipWith({ id: "long", lengthBars: 8 })]);
    expect(pickVocalClip(doc, "short")?.id).toBe("short");
    expect(pickVocalClip(doc)?.id).toBe("long");
    expect(pickVocalClip(doc, "ghost")).toBeNull();
    expect(pickVocalClip(testDoc())?.id ?? null).toBeNull();
  });
});

describe("resolveVocalTake", () => {
  it("resolves clip → buffer → mono PCM with ids attached", () => {
    const bank = fakeBank({ "vocal.take1": fakeBuffer([new Float32Array([0.2, 0.4, 0.6])]) });
    const result = resolveVocalTake(docWithClips([clipWith({})]), bank, { clipId: "clip-v1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.take.clipId).toBe("clip-v1");
    expect(result.take.bufferId).toBe("vocal.take1");
    expect(result.take.sampleRate).toBe(SR);
    expect(Array.from(result.take.pcm).map((v) => Math.round(v * 1000) / 1000)).toEqual([0.2, 0.4, 0.6]);
  });

  it("honors the trim window and gain", () => {
    const data = new Float32Array(10 * SR).fill(0.8);
    const bank = fakeBank({ "vocal.take1": fakeBuffer([data]) });
    const doc = docWithClips([clipWith({ trimStart: 2, trimEnd: 1, gain: 0.5 })]);
    const result = resolveVocalTake(doc, bank, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.take.pcm.length).toBe(7 * SR); // 10 − 2 − 1
    expect(result.take.pcm[0]).toBeCloseTo(0.4, 5); // 0.8 × 0.5
  });

  it("fails honestly: no clips, unknown clip, missing buffer, empty window", () => {
    const bank = fakeBank({});
    expect(resolveVocalTake(testDoc(), bank, {}).ok).toBe(false);
    const doc = docWithClips([clipWith({})]);
    const unstaged = resolveVocalTake(doc, bank, {});
    expect(unstaged.ok).toBe(false);
    if (!unstaged.ok) expect(unstaged.error).toContain("not loaded");
    expect(resolveVocalTake(doc, bank, { clipId: "ghost" }).ok).toBe(false);
    const emptyWindow = docWithClips([clipWith({ trimStart: 99, trimEnd: 0 })]);
    const richBank = fakeBank({ "vocal.take1": fakeBuffer([new Float32Array(SR).fill(0.5)]) });
    expect(resolveVocalTake(emptyWindow, richBank, {}).ok).toBe(false);
  });

  it("end-to-end: resolved PCM analyzes to a measured profile", async () => {
    const { buildVocalProfile } = await import("../src/vocal/analyze");
    const data = new Float32Array(4 * SR);
    for (let i = 0; i < data.length; i++) {
      data[i] = 0.4 * Math.sin((2 * Math.PI * 261.63 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 329.63 * i) / SR);
    }
    const bank = fakeBank({ "vocal.take1": fakeBuffer([data]) });
    const resolved = resolveVocalTake(docWithClips([clipWith({})]), bank, {});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const profile = buildVocalProfile({ pcm: resolved.take.pcm, sampleRate: resolved.take.sampleRate, bpm: 120 });
    expect(profile.measured).toBe(true);
  });
});
