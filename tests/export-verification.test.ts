import { describe, expect, it } from "vitest";
import { encodeWav, encodeWavAsync, sanitizeFilename } from "../src/rendering/wav";
import { resolveRenderTailSeconds } from "../src/rendering/renderer";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";
import { FLAC_SUPPORTED_SAMPLE_RATES, isFlacSampleRateSupported } from "../src/export/flac-capabilities";
import {
  assertFlacOutputChunkRange,
  assertFlacExportWorkingSetBudget,
  estimateFlacOutputWorkingSetBytes,
  MAX_FLAC_EXPORT_WORKING_SET_BYTES,
  MAX_FLAC_OUTPUT_BYTES,
} from "../src/export/flac-limits";
import {
  assertWavExportWorkingSetBudget,
  canDecodeWavAsAudioBuffer,
  estimateWavExportAdditionalWorkingSetBytes,
  estimateWavEncodedFileBytes,
  MAX_WAV_DECODE_BYTES,
  MAX_WAV_DECODE_PCM_BYTES,
  MAX_WAV_EXPORT_WORKING_SET_BYTES,
  WAV_DELIVERY_RUNTIME_RESERVE_BYTES,
} from "../src/export/wav-limits";
import {
  assertMp3ExportWorkingSetBudget,
  estimateMp3ExportAdditionalWorkingSetBytes,
  MAX_MP3_DECODE_BYTES,
  MAX_MP3_DECODE_PCM_BYTES,
  MP3_DELIVERY_RUNTIME_RESERVE_BYTES,
  MAX_MP3_EXPORT_WORKING_SET_BYTES,
} from "../src/export/mp3-limits";
import { parseFlac } from "../src/mastering/encodedInspection";

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
function fakeBuffer(
  channels: number,
  sampleRate: number,
  frames: number,
  fill: (ch: number, i: number) => number,
): AudioBuffer {
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

function makeMinimalFlac(sampleRate = 44_100, channels = 2, bitDepth = 24, frames = 44_100): ArrayBuffer {
  const bytes = new Uint8Array(48);
  bytes.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
  const packed =
    (BigInt(sampleRate) << 44n) | (BigInt(channels - 1) << 41n) | (BigInt(bitDepth - 1) << 36n) | BigInt(frames);
  for (let index = 0; index < 8; index++) {
    bytes[18 + index] = Number((packed >> BigInt((7 - index) * 8)) & 0xffn);
  }
  bytes.set([0xff, 0xf8, 0, 0, 0, 0], 42);
  return bytes.buffer;
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
  return {
    riff,
    riffSize,
    dataSize,
    peak,
    rms: count > 0 ? Math.sqrt(sumSquares / count) : 0,
    fileBytes: bytes.byteLength,
  };
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

  it("async encoder aborts during its yielded UI turn before encoding another block", async () => {
    const controller = new AbortController();
    const buffer = fakeBuffer(2, SR, 200_000, () => 0.5);
    const progress: number[] = [];
    const result = await encodeWavAsync(buffer, 16, {
      onProgress: (fraction) => {
        progress.push(fraction);
        if (progress.length === 1) setTimeout(() => controller.abort(), 0);
      },
      signal: controller.signal,
    }).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );

    expect(result.error).toBeInstanceOf(DOMException);
    expect((result.error as DOMException).name).toBe("AbortError");
    expect(progress).toHaveLength(1);
  });
});

describe("FLAC mastering sample-rate contract", () => {
  it("supports 96 kHz delivery and rejects rates the encoder cannot represent", () => {
    expect(FLAC_SUPPORTED_SAMPLE_RATES).toContain(96_000);
    expect(isFlacSampleRateSupported(96_000)).toBe(true);
    expect(isFlacSampleRateSupported(44_100)).toBe(true);
    expect(isFlacSampleRateSupported(88_201)).toBe(false);
    expect(isFlacSampleRateSupported(96_000.5)).toBe(false);
  });
});

describe("FLAC STREAMINFO parser", () => {
  it("reads exact sample rate, channel count, bit depth, and duration", () => {
    expect(parseFlac(makeMinimalFlac(96_000, 2, 24, 288_000))).toMatchObject({
      sampleRate: 96_000,
      channels: 2,
      bitDepth: 24,
      durationSeconds: 3,
      durationAccuracy: "exact",
    });
  });

  it.each([
    [
      "a damaged marker",
      () => {
        const bytes = new Uint8Array(makeMinimalFlac());
        bytes[0] = 0;
        return bytes.buffer;
      },
      /missing its marker/,
    ],
    [
      "STREAMINFO that is not the first block",
      () => {
        const bytes = new Uint8Array(makeMinimalFlac());
        bytes[4] = 0x81;
        return bytes.buffer;
      },
      /must begin with a 34-byte STREAMINFO/,
    ],
    [
      "metadata extending past the file",
      () => {
        const bytes = new Uint8Array(makeMinimalFlac());
        bytes[7] = 0xff;
        return bytes.buffer;
      },
      /metadata block extends beyond the file/,
    ],
    [
      "a duplicate STREAMINFO block",
      () => {
        const original = new Uint8Array(makeMinimalFlac());
        const bytes = new Uint8Array(original.length + 38);
        bytes.set(original.subarray(0, 42));
        bytes[4] = 0;
        bytes.set([0x80, 0, 0, 34], 42);
        bytes.set(original.subarray(8, 42), 46);
        bytes.set(original.subarray(42), 80);
        return bytes.buffer;
      },
      /invalid or duplicated/,
    ],
    ["a zero sample rate", () => makeMinimalFlac(0), /audio fields are invalid/],
    ["an unknown frame count", () => makeMinimalFlac(44_100, 2, 24, 0), /do not include a known duration/],
    ["a missing audio frame", () => makeMinimalFlac().slice(0, 42), /not followed by an audio frame/],
  ])("rejects %s before decoder startup", (_label, makeBytes, message) => {
    expect(() => parseFlac(makeBytes())).toThrow(message);
  });
});

describe("FLAC in-memory output file cap", () => {
  it("accepts the exact 96 MiB boundary and rejects the first byte beyond it", () => {
    expect(assertFlacOutputChunkRange(MAX_FLAC_OUTPUT_BYTES - 1, 1)).toBe(MAX_FLAC_OUTPUT_BYTES);
    expect(() => assertFlacOutputChunkRange(MAX_FLAC_OUTPUT_BYTES - 1, 2)).toThrow(
      /exceeded KYX's 96 MiB in-memory export limit/,
    );
  });

  it("fails closed for invalid stream positions and chunk sizes", () => {
    expect(() => assertFlacOutputChunkRange(-1, 1)).toThrow(/exceeded KYX's 96 MiB/);
    expect(() => assertFlacOutputChunkRange(0, Number.NaN)).toThrow(/exceeded KYX's 96 MiB/);
    expect(() => assertFlacOutputChunkRange(Number.MAX_SAFE_INTEGER, 2)).toThrow(/exceeded KYX's 96 MiB/);
  });
});

describe("FLAC export working-set guard", () => {
  it("accepts the exact 512 MiB boundary and rejects the first byte over it", () => {
    const outputBytes = estimateFlacOutputWorkingSetBytes({ length: 48_000, numberOfChannels: 2 }, 24);
    expect(outputBytes).toBeGreaterThan(0);
    expect(() =>
      assertFlacExportWorkingSetBudget(MAX_FLAC_EXPORT_WORKING_SET_BYTES - outputBytes, outputBytes),
    ).not.toThrow();
    expect(() =>
      assertFlacExportWorkingSetBudget(MAX_FLAC_EXPORT_WORKING_SET_BYTES - outputBytes + 1, outputBytes),
    ).toThrow(/above KYX's 512 MiB working-set limit/);
  });

  it("accounts for the measured high-entropy FLAC encoder peak before export starts", () => {
    const frames = 7 * 60 * 44_100;
    const sourcePcmBytes = frames * 2 * Float32Array.BYTES_PER_ELEMENT;
    const outputWorkingSetBytes = estimateFlacOutputWorkingSetBytes({ length: frames, numberOfChannels: 2 }, 24);

    expect(outputWorkingSetBytes).toBeGreaterThan(MAX_FLAC_EXPORT_WORKING_SET_BYTES);
    expect(() => assertFlacExportWorkingSetBudget(sourcePcmBytes, outputWorkingSetBytes)).toThrow(
      /above KYX's 512 MiB working-set limit/,
    );
  });

  it("fails closed when PCM dimensions or byte estimates are invalid", () => {
    expect(estimateFlacOutputWorkingSetBytes({ length: 0, numberOfChannels: 2 }, 24)).toBe(Number.POSITIVE_INFINITY);
    expect(estimateFlacOutputWorkingSetBytes({ length: Number.MAX_SAFE_INTEGER, numberOfChannels: 2 }, 24)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(() => assertFlacExportWorkingSetBudget(Number.NaN, 1)).toThrow(/could not estimate the memory/);
    expect(() => assertFlacExportWorkingSetBudget(0.5, 1)).toThrow(/could not estimate the memory/);
    expect(() => assertFlacExportWorkingSetBudget(0, Number.POSITIVE_INFINITY)).toThrow(
      /could not estimate the memory/,
    );
  });
});

describe("WAV mastering export working-set guard", () => {
  it("requires both an encoded-file and decoded-PCM budget for whole-file read-back", () => {
    expect(canDecodeWavAsAudioBuffer(MAX_WAV_DECODE_BYTES, MAX_WAV_DECODE_PCM_BYTES)).toBe(true);
    expect(canDecodeWavAsAudioBuffer(MAX_WAV_DECODE_BYTES + 1, 1)).toBe(false);
    expect(canDecodeWavAsAudioBuffer(1, MAX_WAV_DECODE_PCM_BYTES + 1)).toBe(false);
    expect(canDecodeWavAsAudioBuffer(Number.POSITIVE_INFINITY, 1)).toBe(false);

    const renderPcmBytes = 80 * 1024 * 1024;
    const fileBytes = estimateWavEncodedFileBytes(renderPcmBytes, 24);
    expect(fileBytes).toBeLessThan(MAX_WAV_DECODE_BYTES);
    expect(canDecodeWavAsAudioBuffer(fileBytes, renderPcmBytes)).toBe(false);
    expect(estimateWavExportAdditionalWorkingSetBytes(renderPcmBytes, 24, 1)).toBe(
      fileBytes + WAV_DELIVERY_RUNTIME_RESERVE_BYTES + 2 * 1024 * 1024,
    );
  });

  it("counts the WAV output, download copy and small-file read-back at the exact budget boundary", () => {
    const renderPcmBytes = 48_000 * 2 * Float32Array.BYTES_PER_ELEMENT;
    const projectAdditional = estimateWavExportAdditionalWorkingSetBytes(renderPcmBytes, 24);
    const externalAdditional = estimateWavExportAdditionalWorkingSetBytes(renderPcmBytes, 24, 1);
    const outputAlreadyReserved = estimateWavExportAdditionalWorkingSetBytes(renderPcmBytes, 24, 0);
    expect(projectAdditional).toBeGreaterThan(externalAdditional);
    expect(projectAdditional - externalAdditional).toBeGreaterThan(0);
    expect(externalAdditional - outputAlreadyReserved).toBeGreaterThan(0);
    expect(() =>
      assertWavExportWorkingSetBudget(MAX_WAV_EXPORT_WORKING_SET_BYTES - projectAdditional, projectAdditional),
    ).not.toThrow();
    expect(() =>
      assertWavExportWorkingSetBudget(MAX_WAV_EXPORT_WORKING_SET_BYTES - projectAdditional + 1, projectAdditional),
    ).toThrow(/above KYX's 512 MiB working-set limit/);
  });

  it("omits a decoded AudioBuffer for WAV files that use the streaming analyzer", () => {
    const renderPcmBytes = 200 * 1024 * 1024;
    const encodedFileBytes = renderPcmBytes / 2 + 64 * 1024;
    expect(encodedFileBytes).toBeGreaterThan(MAX_WAV_DECODE_BYTES);
    const boundedInspectionReserve = WAV_DELIVERY_RUNTIME_RESERVE_BYTES + 2 * 1024 * 1024;
    expect(estimateWavExportAdditionalWorkingSetBytes(renderPcmBytes, 16)).toBe(
      encodedFileBytes * 2 + boundedInspectionReserve,
    );
    expect(estimateWavExportAdditionalWorkingSetBytes(renderPcmBytes, 16, 1)).toBe(
      encodedFileBytes + boundedInspectionReserve,
    );
    expect(estimateWavExportAdditionalWorkingSetBytes(renderPcmBytes, 16, 0)).toBe(boundedInspectionReserve);
  });

  it("keeps twelve-minute 16/24-bit delivery under the guard and blocks 32-bit float above it", () => {
    const renderPcmBytes = Math.round(726 * 44_100 * 2 * Float32Array.BYTES_PER_ELEMENT);
    for (const bitDepth of [16, 24, 32] as const) {
      const fileBytes = estimateWavEncodedFileBytes(renderPcmBytes, bitDepth);
      const encodedCopies = canDecodeWavAsAudioBuffer(fileBytes, renderPcmBytes) ? 2 : 1;
      const additionalBytes = estimateWavExportAdditionalWorkingSetBytes(renderPcmBytes, bitDepth, encodedCopies);
      if (bitDepth === 32) {
        expect(() => assertWavExportWorkingSetBudget(renderPcmBytes, additionalBytes)).toThrow(
          /above KYX's 512 MiB working-set limit/,
        );
      } else {
        expect(() => assertWavExportWorkingSetBudget(renderPcmBytes, additionalBytes)).not.toThrow();
      }
    }
  });

  it("fails closed for invalid PCM sizes and budget inputs", () => {
    expect(estimateWavExportAdditionalWorkingSetBytes(7, 24)).toBe(Number.POSITIVE_INFINITY);
    expect(estimateWavExportAdditionalWorkingSetBytes(Number.MAX_SAFE_INTEGER, 32)).toBe(Number.POSITIVE_INFINITY);
    expect(() => assertWavExportWorkingSetBudget(Number.NaN, 1)).toThrow(/could not estimate the memory/);
    expect(() => assertWavExportWorkingSetBudget(0, Number.POSITIVE_INFINITY)).toThrow(/could not estimate the memory/);
  });
});

describe("MP3 mastering export working-set guard", () => {
  it("includes encoder PCM, encoded copies and full decode memory for small deliveries", () => {
    const renderPcmBytes = 2 * 60 * 44_100 * 2 * Float32Array.BYTES_PER_ELEMENT;
    const additionalBytes = estimateMp3ExportAdditionalWorkingSetBytes(renderPcmBytes, 44_100, 192, 2);

    expect(additionalBytes).toBeGreaterThan(renderPcmBytes);
    expect(additionalBytes).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("uses bounded inspection memory for large MP3 deliveries above the whole-file decode threshold", () => {
    const renderPcmBytes = 8 * 60 * 48_000 * 2 * Float32Array.BYTES_PER_ELEMENT;
    const additionalBytes = estimateMp3ExportAdditionalWorkingSetBytes(renderPcmBytes, 48_000, 320, 2);
    const estimatedEncodedBytes = (8 * 60 * 320_000) / 8;

    expect(estimatedEncodedBytes).toBeGreaterThan(MAX_MP3_DECODE_BYTES);
    expect(additionalBytes - MP3_DELIVERY_RUNTIME_RESERVE_BYTES).toBeLessThan(renderPcmBytes);
  });

  it("uses bounded worker inspection when a small MP3 would decode to more than 64 MiB of PCM", () => {
    const renderPcmBytes = 4 * 60 * 44_100 * 2 * Float32Array.BYTES_PER_ELEMENT;
    const additionalBytes = estimateMp3ExportAdditionalWorkingSetBytes(renderPcmBytes, 44_100, 320, 2);
    const estimatedEncodedBytes = (4 * 60 * 320_000) / 8;

    expect(estimatedEncodedBytes).toBeLessThan(MAX_MP3_DECODE_BYTES);
    expect(renderPcmBytes).toBeGreaterThan(MAX_MP3_DECODE_PCM_BYTES);
    expect(additionalBytes - MP3_DELIVERY_RUNTIME_RESERVE_BYTES).toBeLessThan(renderPcmBytes + 16 * 1024 * 1024);
  });

  it("accepts a four-minute external master and rejects a seven-minute MP3 before allocation", () => {
    const estimateSessionDelivery = (minutes: number) => {
      const renderPcmBytes = minutes * 60 * 44_100 * 2 * Float32Array.BYTES_PER_ELEMENT;
      const sessionResidentBytes = renderPcmBytes * 3;
      const outputBytes = estimateMp3ExportAdditionalWorkingSetBytes(renderPcmBytes, 44_100, 320, 2);
      return { outputBytes, sessionResidentBytes };
    };
    const fourMinute = estimateSessionDelivery(4);
    const fiveMinute = estimateSessionDelivery(5);
    const sevenMinute = estimateSessionDelivery(7);
    const fourMinuteTotalBytes = fourMinute.sessionResidentBytes + fourMinute.outputBytes;

    expect(() =>
      assertMp3ExportWorkingSetBudget(fourMinute.sessionResidentBytes, fourMinute.outputBytes),
    ).not.toThrow();
    expect(fourMinuteTotalBytes).toBeGreaterThan(480 * 1024 * 1024);
    expect(fourMinuteTotalBytes).toBeLessThan(MAX_MP3_EXPORT_WORKING_SET_BYTES);
    expect(() => assertMp3ExportWorkingSetBudget(fiveMinute.sessionResidentBytes, fiveMinute.outputBytes)).toThrow(
      /above KYX's 512 MiB working-set limit/,
    );
    expect(() => assertMp3ExportWorkingSetBudget(sevenMinute.sessionResidentBytes, sevenMinute.outputBytes)).toThrow(
      /above KYX's 512 MiB working-set limit/,
    );
  });

  it("accepts the exact 512 MiB boundary and rejects one byte over", () => {
    const outputBytes = estimateMp3ExportAdditionalWorkingSetBytes(48_000 * 2 * 4, 48_000, 192, 2);
    expect(() =>
      assertMp3ExportWorkingSetBudget(MAX_MP3_EXPORT_WORKING_SET_BYTES - outputBytes, outputBytes),
    ).not.toThrow();
    expect(() =>
      assertMp3ExportWorkingSetBudget(MAX_MP3_EXPORT_WORKING_SET_BYTES - outputBytes + 1, outputBytes),
    ).toThrow(/above KYX's 512 MiB working-set limit/);
  });

  it("fails closed for invalid PCM dimensions, sample rates, bitrates and budget values", () => {
    expect(estimateMp3ExportAdditionalWorkingSetBytes(0, 44_100, 192)).toBe(Number.POSITIVE_INFINITY);
    expect(estimateMp3ExportAdditionalWorkingSetBytes(7, 44_100, 192)).toBe(Number.POSITIVE_INFINITY);
    expect(estimateMp3ExportAdditionalWorkingSetBytes(Number.MAX_SAFE_INTEGER, 44_100, 192)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(estimateMp3ExportAdditionalWorkingSetBytes(48_000 * 2 * 4, 96_000, 192)).toBe(Number.POSITIVE_INFINITY);
    expect(estimateMp3ExportAdditionalWorkingSetBytes(48_000 * 2 * 4, 48_000, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(() => assertMp3ExportWorkingSetBudget(Number.NaN, 1)).toThrow(/could not estimate the memory/);
    expect(() => assertMp3ExportWorkingSetBudget(0, Number.POSITIVE_INFINITY)).toThrow(/could not estimate the memory/);
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
