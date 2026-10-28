import { describe, expect, it } from "vitest";
import { createAudioTaggingAdapter, downmixToMono16k } from "../../src/analysis/adapters/audio-tagging";
import type { AudioAnalysisRequest } from "../../src/analysis/contract";
import { addAudioClip } from "../../src/commands/commands";
import type { ProjectDocument } from "../../src/project-model/types";
import { testDoc } from "../fixtures/doc";

/**
 * E-5 — the model-agnostic ADAPTER proof of concept (perception audit):
 * the on-device AST tagger behind the E-1 envelope, with labels +
 * confidence traveling in the SAME shape the deterministic analyzers use.
 *
 * The adapter is tested with an INJECTED classify function (the same
 * dependency-injection seam audio-reference.ts uses) — the on-device
 * inference itself stays behind the tagger's own gates (flag, manifest,
 * sha-256 pack, timeout + circuit breaker), which this wave leaves
 * UNCHANGED. In vitest the real worker never spawns, so the default
 * classifyAudio path degrades to null — which is exactly the
 * unavailable-tier contract the last spec pins.
 */

const SR = 44100;
const BAR = 1920;

function request(doc: ProjectDocument, trackId: string): AudioAnalysisRequest {
  return {
    projectId: doc.id,
    revision: 3,
    scope: { kind: "track", id: trackId },
    window: { startTick: 0, endTick: 4 * BAR },
    stage: "track",
    featureSet: "audio-labels",
  };
}

const labels = [
  { label: "Music", score: 0.91 },
  { label: "Electronic music", score: 0.74 },
  { label: "Drum kit", score: 0.41 },
];

describe("E-5: the audio-tagging adapter speaks the analysis envelope", () => {
  it("labels + confidence travel in the envelope with algorithm identity", async () => {
    const adapter = createAudioTaggingAdapter(async () => labels);
    const doc = testDoc();
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    const pcm = new Float32Array(SR * 8);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);

    const result = await adapter.run(doc, request(doc, trackId), [pcm, pcm], SR);

    expect(result.partial).toBeUndefined();
    expect(result.algorithm).toEqual({ name: "audio-tagging", version: "audio-tag.v1" });
    expect(result.confidence).toBe(0.91);
    const payload = result.payload as { labels: Array<{ label: string; score: number }>; modelId: string };
    expect(payload.modelId).toBe("audio-tag.v1");
    expect(payload.labels).toEqual(labels);
    expect(result.request).toEqual(request(doc, trackId));
    expect(result.producedAtRevision).toBe(3);
  });

  it("the window is MAPPED: the tagger receives the mono 16 kHz slice of the resolved window", async () => {
    const seen: Float32Array[] = [];
    const adapter = createAudioTaggingAdapter(async (mono) => {
      seen.push(mono);
      return labels;
    });
    // An explicit 120 BPM keeps the arithmetic exact: the window bars 0-4
    // is [0 s, 8 s), so an impulse at 4.5 s lands at mono index
    // round(4.5 × 16000) = 72000 exactly.
    let doc = { ...testDoc(), bpm: 120 };
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    doc = addAudioClip(doc, trackId, "factory.kick", 2, 4).execute(doc);
    const pcm = new Float32Array(SR * 8);
    pcm[Math.round(4.5 * SR)] = 1;

    await adapter.run(doc, request(doc, trackId), [pcm, pcm], SR);

    expect(seen).toHaveLength(1);
    const mono = seen[0]!;
    expect(mono.length).toBe(8 * 16000); // the 8 s window at 16 kHz
    const peakIndex = mono.indexOf(1);
    expect(Math.abs(peakIndex - 72000)).toBeLessThanOrEqual(16); // linear resample, ±1 ms
  });

  it("stereo downmix is the channel mean", () => {
    // At the TARGET rate the downmix is pure averaging (no resample).
    const mono = downmixToMono16k([new Float32Array([1, -1]), new Float32Array([0, 1])], 16000);
    expect([...mono]).toEqual([0.5, 0]);
  });

  it("an unavailable model is a PARTIAL envelope with the model-unavailable caveat — never a throw", async () => {
    const adapter = createAudioTaggingAdapter(async () => null);
    const doc = testDoc();
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    const result = await adapter.run(
      doc,
      request(doc, trackId),
      [new Float32Array(SR * 8), new Float32Array(SR * 8)],
      SR,
    );
    expect(result.partial?.reason).toBe("audio-tagging-unavailable");
    expect(result.confidence).toBeNull();
    expect(result.caveats.map((c) => c.code)).toContain("model-unavailable");
    // The audit's Phase-7 distinction: "analysis unavailable" must be
    // distinguishable from "no event detected" — the detail says so.
    expect(result.caveats.find((c) => c.code === "model-unavailable")?.detail).toMatch(/NOT 'no labels detected'/);
  });

  it("a throwing classify is contained by the adapter (never-throw tier)", async () => {
    const adapter = createAudioTaggingAdapter(async () => {
      throw new Error("worker exploded");
    });
    const doc = testDoc();
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    const result = await adapter.run(
      doc,
      request(doc, trackId),
      [new Float32Array(SR * 8), new Float32Array(SR * 8)],
      SR,
    );
    expect(result.partial?.reason).toBe("worker exploded");
    expect(result.confidence).toBeNull();
  });

  it("determinism: the same input yields the same envelope, twice", async () => {
    const adapter = createAudioTaggingAdapter(async () => labels);
    const doc = testDoc();
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    const pcm = new Float32Array(SR * 8);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const a = await adapter.run(doc, request(doc, trackId), [pcm, pcm], SR);
    const b = await adapter.run(doc, request(doc, trackId), [pcm, pcm], SR);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
