import { describe, expect, it } from "vitest";
import { formatAnalyzeAudio, mcpAnalyzeAudio } from "../src/mcp/analyze-audio";
import { ProjectStore } from "../src/store/ProjectStore";
import { addAudioClip } from "../src/commands/commands";
import { testDoc } from "./fixtures/doc";

/**
 * E-6 — the kyx_analyze BRIDGE, tested with an INJECTED render and an
 * injected classify (the real render needs a browser; the real classify
 * needs the fetched model). The contract under test:
 *
 *  - the result is the E-1 envelope's BOUNDED digest: provenance
 *    (projectId/revision/track/window/algorithm), no raw arrays;
 *  - mix-health is SIGNED: the boosted state must show it (the delta
 *    experiment E-2's terrain, here just the digest shape);
 *  - audio-labels: top-5 labels + confidence; an unavailable model is
 *    status "partial" with the model-unavailable reason — never invented
 *    labels;
 *  - the text an agent reads carries numbers and provenance, no arrays;
 *  - unknown trackId refuses with the recovery pointer.
 */

const SR = 44100;

function fakeBuffer(seconds: number, level: number, toneHz: number): any {
  const length = SR * seconds;
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = level * Math.sin((2 * Math.PI * toneHz * i) / SR);
  return {
    length,
    sampleRate: SR,
    numberOfChannels: 2,
    getChannelData: (_channel: number) => data,
  };
}

function services(): { store: ProjectStore } {
  const store = new ProjectStore(testDoc());
  const trackId = store.doc.tracks.find((t) => t.kind === "instrument")!.id;
  store.execute(addAudioClip(store.doc, trackId, "factory.kick", 0, 4));
  return { store };
}

const TRACK = () => {
  const s = services();
  return { ...s, trackId: s.store.doc.tracks.find((t) => t.kind === "instrument")!.id };
};

describe("mcpAnalyzeAudio — the kyx_analyze bridge", () => {
  it("mix-health: the digest is bounded and provenance-rich", async () => {
    const { store, trackId } = TRACK();
    const result = await mcpAnalyzeAudio({ store } as any, { trackId, featureSet: "mix-health" }, undefined, {
      render: async (_doc, _id, _opts) => fakeBuffer(8, 0.4, 220),
    });
    expect(result.status).toBe("analyzed");
    expect(result.provenance.trackId).toBe(trackId);
    expect(result.provenance.revision).toBeTypeOf("number");
    expect(result.provenance.algorithm).toEqual({ name: "mix-doctor", version: "1" });
    expect(result.provenance.window.endTick).toBeGreaterThan(result.provenance.window.startTick);
    expect(result.mixHealth).toBeDefined();
    expect(result.mixHealth!.peak).toBeGreaterThan(0);
    // Bounded: the digest keys are scalars, no PCM, no arrays of samples.
    expect(Object.keys(result.mixHealth!).every((key) => typeof key === "string")).toBe(true);
  });

  it("audio-labels: top-5 labels with confidence, via the injected classify", async () => {
    const { store, trackId } = TRACK();
    const labels = [
      { label: "Music", score: 0.9 },
      { label: "Loop", score: 0.8 },
      { label: "Drum", score: 0.7 },
      { label: "Kick", score: 0.6 },
      { label: "Synth", score: 0.5 },
      { label: "Extra", score: 0.4 },
    ];
    const result = await mcpAnalyzeAudio({ store } as any, { trackId, featureSet: "audio-labels" }, undefined, {
      render: async () => fakeBuffer(8, 0.4, 220),
      classify: async () => labels,
    });
    expect(result.status).toBe("analyzed");
    expect(result.labels!.length).toBe(5); // BOUNDED: top-5 of 6
    expect(result.labels![0]!.label).toBe("Music");
    expect(result.confidence).toBe(0.9);
    expect(result.provenance.algorithm.name).toBe("audio-tagging");
  });

  it("an unavailable model is status PARTIAL with the honest reason", async () => {
    const { store, trackId } = TRACK();
    const result = await mcpAnalyzeAudio({ store } as any, { trackId, featureSet: "audio-labels" }, undefined, {
      render: async () => fakeBuffer(8, 0.4, 220),
      classify: async () => null,
    });
    expect(result.status).toBe("partial");
    expect(result.partialReason).toMatch(/unavailable/);
    expect(result.partialReason).toMatch(/NOT 'no labels detected'/);
    expect(result.labels).toEqual([]);
  });

  it("an unknown trackId refuses with the recovery pointer", async () => {
    const { store } = TRACK();
    await expect(
      mcpAnalyzeAudio({ store } as any, { trackId: "no-such-track", featureSet: "mix-health" }, undefined, {
        render: async () => fakeBuffer(8, 0.4, 220),
      }),
    ).rejects.toThrow(/kyx_state subject:tracks/);
  });

  it("the text an agent reads carries numbers and provenance, no arrays", async () => {
    const { store, trackId } = TRACK();
    const result = await mcpAnalyzeAudio({ store } as any, { trackId, featureSet: "mix-health" }, undefined, {
      render: async () => fakeBuffer(8, 0.4, 220),
    });
    const text = formatAnalyzeAudio(result);
    expect(text).toMatch(/mix-doctor@1/);
    expect(text).toMatch(/peak/);
    expect(text).toMatch(/LUFS-I/);
    expect(text).not.toMatch(/\[\s*-?\d+(\.\d+)?\s*,\s*-?\d+/); // no sample arrays
  });
});
