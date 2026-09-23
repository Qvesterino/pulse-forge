import { describe, expect, it } from "vitest";
import { encodeWav, encodeWavAsync, sanitizeFilename } from "../src/rendering/wav";
import { resolveRenderTailSeconds } from "../src/rendering/renderer";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * AUDIT 11 Wave 4 — export verification without a browser.
 *
 * encodeWav only needs an AudioBuffer-LIKE (getChannelData/length/
 * numberOfChannels/sampleRate), so the full encode→parse pipeline is
 * verifiable in vitest against a synthetic buffer. This pins the export
 * contract the reliability waves promised: correct duration, non-silence,
 * byte-identical sync/async encoders, RIFF integrity, tail estimation.
 */

/** Minimal AudioBuffer stand-in (encodeWav touches exactly these members). */
function fakeBuffer(channels: number, sampleRate: number, frames: number, fill: (ch: number, i: number) => number): AudioBuffer {
  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const arr = new Float32Array(frames);
    for (let i = 0; i < frames; i++) arr[i] = fill(ch, i);
    data.push(arr);
  }
  return {
    numberOfChannels: channels,
    sampleRate,
    length: frames,
    duration: frames / sampleRate,
    getChannelData: (ch: number) => data[ch]!,
  } as unknown as AudioBuffer;
}

/** Parse RIFF header fields back out of an encoded buffer. */
function parseWav(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const riffSize = view.getUint32(4, true);
  const dataOffset = 44;
  const dataSize = view.getUint32(40, true);
  let peak = 0;
  let sumSquares = 0;
  let count = 0;
  for (let i = 0; i + 2 <= dataSize; i += 2) {
    const s = view.getInt16(dataOffset + i, true) / 0x8000;
    peak = Math.max(peak, Math.abs(s));
    sumSquares += s * s;
    count++;
  }
  return { riff, riffSize, dataSize, peak, rms: count > 0 ? Math.sqrt(sumSquares / count) : 0, fileBytes: bytes.byteLength };
}

describe("export verification — WAV encode contract (audit 11 wave 4)", () => {
  const SR = 44100;
  const FRAMES = SR; // 1 second
  it("encodes a non-silent 1-second buffer with exact duration and RIFF integrity", () => {
    const buffer = fakeBuffer(2, SR, FRAMES, (ch, i) => 0.3 * Math.sin((2 * Math.PI * 440 * (i + ch)) / SR));
    const bytes = encodeWav(buffer, 16);
    const parsed = parseWav(bytes);
    expect(parsed.riff).toBe("RIFF");
    // 2ch × 16-bit × 44100 frames = 176400 data bytes → file = 176444.
    expect(parsed.dataSize).toBe(2 * 2 * FRAMES);
    expect(parsed.fileBytes).toBe(44 + parsed.dataSize);
    // Real content, not digital silence.
    expect(parsed.rms).toBeGreaterThan(0.1);
    expect(parsed.peak).toBeLessThanOrEqual(1);
  });

  it("all-silent input produces a VALID noise-floor file (dither ±1 LSB, by design)", () => {
    const buffer = fakeBuffer(2, SR, FRAMES, () => 0);
    const bytes = encodeWav(buffer, 16);
    const parsed = parseWav(bytes);
    expect(parsed.riff).toBe("RIFF");
    // TPDF dither on digital silence yields ±1 LSB noise (3.05e-5) — the
    // anti-digital-silence policy, NOT a bug. Assert the noise floor stays
    // inaudible rather than demanding exact zero.
    expect(parsed.peak).toBeLessThan(1 / 8000);
  });

  it("32-bit float path preserves over-range headroom (no soft-clip bake-in)", () => {
    const buffer = fakeBuffer(1, SR, 8, (_ch, i) => (i === 0 ? 1.8 : 0.1));
    const bytes = encodeWav(buffer, 32);
    const view = new DataView(bytes);
    // First sample (i=0, over-range 1.8) must survive raw — the mastering
    // path must not bake a soft-clip knee into float exports.
    const first = view.getFloat32(44, true);
    expect(first).toBeCloseTo(1.8, 5);
  });

  it("async encoder is byte-identical to the sync encoder (same dither PRNG)", async () => {
    const buffer = fakeBuffer(2, 22050, 5000, (ch, i) => Math.sin((2 * Math.PI * 220 * (i + 3 * ch)) / 22050) * 0.8);
    const sync = encodeWav(buffer, 16);
    const async = await encodeWavAsync(buffer, 16);
    expect(new Uint8Array(async)).toEqual(new Uint8Array(sync));
  });

  it("async encoder honors abort and progress (reliability wave)", async () => {
    const controller = new AbortController();
    const buffer = fakeBuffer(2, SR, 200_000, () => 0.5);
    const progress: number[] = [];
    let aborted = false;
    const promise = encodeWavAsync(buffer, 16, {
      onProgress: (f) => progress.push(f),
      signal: controller.signal,
    }).catch((err) => {
      aborted = err instanceof DOMException && err.name === "AbortError";
      return null;
    });
    controller.abort();
    const result = await promise;
    expect(aborted, "abort must surface as AbortError").toBe(true);
    expect(result).toBeNull();
    expect(progress.length).toBeGreaterThan(0);
  });
});

describe("tail estimation — dynamic export tail (audit 11 wave 2a)", () => {
  it("reverb decay extends the tail; effect-free tracks keep the 2 s fallback", () => {
    const base = createProjectFromTemplate("house");
    const withReverb = normalizeProject({
      ...base,
      tracks: base.tracks.map((t, i) =>
        i === 0
          ? {
              ...t,
              effects: [{ id: "fx-rev", type: "reverb" as const, params: { decay: 5, mix: 0.4 } }],
            }
          : t,
      ),
    } as ProjectDocument);
    expect(resolveRenderTailSeconds(withReverb)).toBeCloseTo(5 * 1.1 + 0.5, 5);
    // A doc with NO effects anywhere keeps the 2 s fallback.
    const plain = normalizeProject({
      ...createProjectFromTemplate("house"),
      tracks: base.tracks.map((t) => ({ ...t, effects: [] })),
      returns: base.returns.map((r) => ({ ...r, effects: [] })),
    });
    expect(resolveRenderTailSeconds(plain)).toBe(2);
  });
});

describe("sanitizeFilename — path hygiene (audit 10 D4 sibling)", () => {
  it("strips separators and control-ish characters from imported names", () => {
    expect(sanitizeFilename("../../evil")).not.toContain("/");
    expect(sanitizeFilename("my: weird*name")).not.toContain("*");
  });
});
