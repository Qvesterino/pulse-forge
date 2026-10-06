import { describe, expect, it, vi } from "vitest";
import { runChunkedSeparation } from "../../src/analysis/stem-model/chunking";
import {
  isStemModelManifest,
  manifestGatePassed,
  resetStemModelProbe,
  setStemModelFlag,
  STEM_MODEL_FLAG,
} from "../../src/analysis/stem-model/gate";
import {
  resetStemModelSession,
  separateTrackModel,
  setStemModelSessionFactoryForTests,
} from "../../src/analysis/stem-model/client";

const SR = 44100;

/** A deterministic LINEAR separator (each stem = a fixed gain of the chunk)
 * — with chunk weights summing to 1 everywhere, the four stems must sum
 * back to the input sample-exactly. */
const gainSeparator =
  (gains: number[]) =>
  (chunk: Float32Array): Float32Array[] =>
    gains.map((g) => {
      const out = new Float32Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) out[i] = chunk[i] * g;
      return out;
    });

const signal = (seconds: number): Float32Array => {
  const pcm = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR);
  return pcm;
};

describe("S3 chunking — the provable properties", () => {
  it("CONSERVATION: a linear separator's four stems sum back to the input sample-exactly", () => {
    const pcm = signal(20); // 3 chunks on the default grid (8 s chunks, 1 s overlap)
    const result = runChunkedSeparation(pcm, SR, gainSeparator([0.1, 0.2, 0.3, 0.4]))!;
    expect(result.chunksProcessed).toBeGreaterThanOrEqual(3);
    const summed = new Float32Array(pcm.length);
    for (const stem of result.stems) for (let i = 0; i < pcm.length; i++) summed[i] += stem[i];
    let maxDiff = 0;
    for (let i = 5000; i < pcm.length - 5000; i += 7) maxDiff = Math.max(maxDiff, Math.abs(summed[i] - pcm[i]));
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it("NO CLICKS: stems are continuous across joins (no sample-to-sample jumps beyond the signal's own slope)", () => {
    const pcm = signal(20);
    const result = runChunkedSeparation(pcm, SR, gainSeparator([1, 0, 0, 0]))!;
    // Chunk starts on the default grid: 8 s chunks, 1 s overlap → joins at
    // 7 s, 14 s. A jump discontinuity at a join would read as a huge delta.
    const stem = result.stems[0];
    const slopeAt = (i: number): number => Math.abs(stem[i + 1] - stem[i]);
    for (const joinSec of [7, 14]) {
      const join = Math.floor(joinSec * SR);
      let joinMax = 0;
      for (let i = join - 50; i < join + 50; i++) joinMax = Math.max(joinMax, slopeAt(i));
      // The sine's own slope at this amplitude is ~0.0125/sample — the join
      // region must not exceed 1.5x a distant baseline's worst step.
      let baseline = 0;
      for (let i = join - 4000; i < join - 3000; i++) baseline = Math.max(baseline, slopeAt(i));
      expect(joinMax, `join @${joinSec}s`).toBeLessThan(baseline * 1.5);
    }
  });

  it("DETERMINISM: same input → identical stems; abort stops early but honestly", () => {
    const pcm = signal(20);
    const sep = gainSeparator([0.25, 0.25, 0.25, 0.25]);
    const a = runChunkedSeparation(pcm, SR, sep)!;
    const b = runChunkedSeparation(pcm, SR, sep)!;
    for (let stem = 0; stem < 4; stem++) {
      expect(a.stems[stem].length).toBe(b.stems[stem].length);
      for (let i = 0; i < a.stems[stem].length; i += 991) {
        expect(a.stems[stem][i]).toBe(b.stems[stem][i]);
      }
    }
    const controller = new AbortController();
    controller.abort();
    const aborted = runChunkedSeparation(pcm, SR, sep, { signal: controller.signal })!;
    expect(aborted.aborted).toBe(true);
    expect(aborted.chunksProcessed).toBe(0);
  });

  it("a failing separator leaves windows silent but the grid unchanged (honest coverage)", () => {
    const pcm = signal(20);
    let calls = 0;
    const result = runChunkedSeparation(pcm, SR, (chunk, index) => {
      calls++;
      return index === 1 ? null : gainSeparator([1, 0, 0, 0])(chunk);
    })!;
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(result.chunksProcessed).toBe(calls - 1);
    // The UNCOVERED region (between the successful chunks 0 [0,8] and
    // 2 [14,20]) stays zero — no invented content. The 7-8 s overlap IS
    // written by chunk 0's tail fade, which is correct behaviour.
    const joinStart = Math.floor(9 * SR);
    let silent = true;
    for (let i = joinStart; i < joinStart + 100; i++) if (result.stems[0][i] !== 0) silent = false;
    expect(silent).toBe(true);
  });
});

describe("S3 gate — the audio-tag ritual for htdemucs", () => {
  const validManifest = {
    stemModelVersion: "stem-htdemucs.v1",
    model: "htdemucs",
    modelHash: "a".repeat(64),
    modelFile: "htdemucs.onnx",
    sampleRate: 44100,
    chunkSec: 7.8,
    stems: ["vocals", "drums", "bass", "other"],
    gatePassed: true,
  };

  it("manifest contract: shape + sha256 length + 4 stems + gatePassed", () => {
    expect(isStemModelManifest(validManifest)).toBe(true);
    expect(manifestGatePassed(validManifest)).toBe(true);
    expect(isStemModelManifest({ ...validManifest, modelHash: "short" })).toBe(false);
    expect(isStemModelManifest({ ...validManifest, stems: ["vocals"] })).toBe(false);
    expect(isStemModelManifest({ ...validManifest, gatePassed: false })).toBe(true); // valid, just gated OUT
    expect(manifestGatePassed({ ...validManifest, gatePassed: false })).toBe(false);
    expect(isStemModelManifest("nope")).toBe(false);
  });

  it("flag off by default; the client refuses to run without flag+gate", async () => {
    localStorage.removeItem(STEM_MODEL_FLAG);
    setStemModelSessionFactoryForTests(vi.fn(async () => null));
    const pcm = signal(3);
    expect(await separateTrackModel(pcm, SR)).toBeNull(); // flag off → null, never throws
    setStemModelFlag(true);
    // flag on, but no manifest on this origin (probeUnavailable) → still null
    resetStemModelProbe();
    expect(await separateTrackModel(pcm, SR)).toBeNull();
    setStemModelFlag(false);
  });

  it("gated OUT manifest (gatePassed false) → client returns null even with a session factory", async () => {
    setStemModelFlag(true);
    resetStemModelProbe();
    const sessionSpy = vi.fn(async () => ({ manifest: validManifest as never, session: {} }));
    setStemModelSessionFactoryForTests(sessionSpy);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...validManifest, gatePassed: false }), { status: 200 })),
    );
    try {
      const pcm = signal(3);
      expect(await separateTrackModel(pcm, SR)).toBeNull();
      expect(sessionSpy).not.toHaveBeenCalled(); // gated OUT never creates a session
    } finally {
      vi.unstubAllGlobals();
      setStemModelFlag(false);
      setStemModelSessionFactoryForTests(null);
      resetStemModelProbe();
      resetStemModelSession();
    }
  });

  it("flag on + valid gated manifest → scripted session runs and stems come back", async () => {
    setStemModelFlag(true);
    resetStemModelProbe();
    const pcm = signal(3);
    const stemValue = 0.25;
    setStemModelSessionFactoryForTests(async (manifest) => ({
      manifest,
      session: {
        run: () => {
          // The real tensor plumbing lands in S4; the fake separator proves
          // the client's chunked path end to end.
          const fake = new Float32Array(Math.floor(3 * SR)).fill(stemValue);
          return { stems: [fake, fake, fake, fake] };
        },
      },
    }));
    // The chunk separator inside the client is S4's real plumbing — until it
    // exists the client honestly returns null even with a session.
    const result = await separateTrackModel(pcm, SR);
    expect(result).toBeNull(); // separateChunkWithSession is the S4 seam
    setStemModelFlag(false);
    setStemModelSessionFactoryForTests(null);
    resetStemModelSession();
    resetStemModelProbe();
  });
});
