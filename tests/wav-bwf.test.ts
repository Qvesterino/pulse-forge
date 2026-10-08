import { describe, expect, it, vi } from "vitest";
import { MasterAnalysisAccumulator, analyzeMasterPcm } from "../src/mastering/analysis";
import { inspectEncodedMaster, inspectMasteringReferenceContainer } from "../src/mastering/encodedInspection";
import type { MasterProfile } from "../src/mastering/profiles";
import { MASTER_PROFILES } from "../src/mastering/profiles";
import {
  createBextMetadata,
  encodeWav,
  encodeWavAsync,
  encodeWavBlobAsync,
  type WavBextMetadata,
} from "../src/rendering/wav";

/**
 * BWF (Broadcast Wave) contract — EBU Tech 3285 `bext` chunk.
 *
 * The `bext` chunk is what makes a WAV interchange-grade: Pro Tools, Nuendo
 * and film workflows read originator, timestamp, sample-accurate time
 * reference and (v2) measured loudness from it. These tests pin the byte
 * layout, the fixed-point loudness scales, ASCII sanitation, chunk
 * word-alignment (pad byte) and the guarantee that metadata is opt-in —
 * every existing encode call keeps its legacy bytes.
 */

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

/** Walk RIFF chunks: id → body offset/size, honoring the word-alignment pad. */
function riffChunks(bytes: ArrayBuffer): { id: string; body: number; size: number }[] {
  const view = new DataView(bytes);
  const chunks: { id: string; body: number; size: number }[] = [];
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(pos),
      view.getUint8(pos + 1),
      view.getUint8(pos + 2),
      view.getUint8(pos + 3),
    );
    const size = view.getUint32(pos + 4, true);
    chunks.push({ id, body: pos + 8, size });
    pos += 8 + size + (size % 2);
  }
  return chunks;
}

function decodeWavPcmForReference(
  bytes: ArrayBuffer,
  dataOffset: number,
  bitDepth: 16 | 24 | 32,
  frameCount: number,
): Float32Array[] {
  const view = new DataView(bytes);
  const channels = [new Float32Array(frameCount), new Float32Array(frameCount)];
  const bytesPerSample = bitDepth / 8;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      const offset = dataOffset + frame * 2 * bytesPerSample + channel * bytesPerSample;
      let value: number;
      if (bitDepth === 16) {
        value = view.getInt16(offset, true) / 0x8000;
      } else if (bitDepth === 24) {
        let signed = view.getUint8(offset) | (view.getUint8(offset + 1) << 8);
        signed |= view.getUint8(offset + 2) << 16;
        if (signed & 0x800000) signed -= 0x1000000;
        value = signed / 0x800000;
      } else {
        value = view.getFloat32(offset, true);
      }
      channels[channel]![frame] = value;
    }
  }
  return channels;
}

class MasteringAnalysisWorkerHarness extends EventTarget {
  private jobId = 0;
  private frameCount = 0;
  private frameOffset = 0;
  private analyzer: MasterAnalysisAccumulator | null = null;
  private frameScratch = new Float64Array(2);
  private terminated = false;

  constructor(_scriptUrl: string | URL, _options?: WorkerOptions) {
    super();
  }

  postMessage(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    const jobId = message.jobId;
    const type = message.type;
    if (typeof jobId !== "number" || typeof type !== "string") return;
    if (type === "MASTER_ANALYSIS_START") {
      this.jobId = jobId;
      this.frameCount = Number(message.frameCount);
      this.frameOffset = 0;
      this.frameScratch = new Float64Array(Number(message.channelCount));
      this.analyzer = new MasterAnalysisAccumulator(
        Number(message.sampleRate),
        Number(message.channelCount),
        message.profile as MasterProfile,
      );
      queueMicrotask(() => this.emit("MASTER_ANALYSIS_READY"));
      return;
    }
    if (jobId !== this.jobId || !this.analyzer) return;
    if (type === "MASTER_ANALYSIS_CHUNK") {
      const channels = message.channels as Float32Array[];
      const offset = Number(message.offset);
      const length = channels[0]?.length ?? 0;
      for (let frame = 0; frame < length; frame++) {
        for (let channel = 0; channel < channels.length; channel++) {
          this.frameScratch[channel] = channels[channel]![frame]!;
        }
        this.analyzer.processFrame(this.frameScratch);
      }
      this.frameOffset += length;
      queueMicrotask(() =>
        this.emit("MASTER_ANALYSIS_CHUNK_ACK", {
          offset,
          length,
          progress: this.frameOffset / this.frameCount,
        }),
      );
      return;
    }
    if (type === "MASTER_ANALYSIS_FINISH") {
      const analysis = this.analyzer.finish();
      queueMicrotask(() => this.emit("MASTER_ANALYSIS_RESULT", { analysis }));
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(type: string, details: Record<string, unknown> = {}): void {
    if (this.terminated) return;
    this.dispatchEvent(new MessageEvent("message", { data: { jobId: this.jobId, type, ...details } }));
  }
}

class UnsupportedMp3WorkerHarness extends EventTarget {
  private terminated = false;

  constructor(_scriptUrl: string | URL, _options?: WorkerOptions) {
    super();
  }

  postMessage(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    if (typeof message.jobId !== "number" || message.type !== "MP3_ANALYSIS_START") return;
    queueMicrotask(() => {
      if (this.terminated) return;
      this.dispatchEvent(
        new MessageEvent("message", {
          data: {
            jobId: message.jobId,
            type: "MP3_ANALYSIS_UNSUPPORTED",
            reason: "This browser does not support MP3 through WebCodecs.",
          },
        }),
      );
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

function readFixed(view: DataView, offset: number, width: number): string {
  let out = "";
  for (let i = 0; i < width; i++) {
    const byte = view.getUint8(offset + i);
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

const SR = 44100;
const FRAMES = 1000;

function toneBuffer(): AudioBuffer {
  return fakeBuffer(2, SR, FRAMES, (ch, i) => 0.3 * Math.sin((2 * Math.PI * 440 * (i + ch)) / SR));
}

const FIXED_DATE = new Date(2026, 8, 26, 13, 37, 42);

function sampleBext(overrides: Partial<WavBextMetadata> = {}): WavBextMetadata {
  return createBextMetadata({
    description: "Test beat — master",
    date: FIXED_DATE,
    timeReference: 0,
    ...overrides,
  });
}

describe("WAV BWF bext chunk (EBU Tech 3285)", () => {
  it("default encode stays byte-compatible with the legacy layout (no bext, data at 44)", () => {
    const bytes = encodeWav(toneBuffer(), 16);
    const view = new DataView(bytes);
    const chunks = riffChunks(bytes);
    expect(chunks.map((c) => c.id)).toEqual(["fmt ", "data"]);
    expect(view.getUint32(40, true)).toBe(2 * 2 * FRAMES);
    expect(bytes.byteLength).toBe(44 + 2 * 2 * FRAMES);
  });

  it("bext sits between fmt and data with the spec base size (602) and version 1", () => {
    const bytes = encodeWav(toneBuffer(), 16, { bext: sampleBext() });
    const view = new DataView(bytes);
    const chunks = riffChunks(bytes);
    expect(chunks.map((c) => c.id)).toEqual(["fmt ", "bext", "data"]);
    const bext = chunks[1]!;
    expect(bext.size).toBe(602);
    expect(bext.body).toBe(44);
    // Version 1: no loudness fields supplied.
    expect(view.getUint16(bext.body + 346, true)).toBe(1);
    const data = chunks[2]!;
    expect(data.id).toBe("data");
    expect(data.size).toBe(2 * 2 * FRAMES);
    // 44 (fmt header block) + 8 + 602 body → data id at 654? No: chunk starts at
    // 36 → data id = 36 + 8 + 602 = 646, body at 654.
    expect(data.body).toBe(654);
    expect(bytes.byteLength).toBe(654 + data.size);
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
  });

  it("round-trips every v1 field, including the 64-bit sample timeReference", () => {
    const bytes = encodeWav(toneBuffer(), 16, {
      bext: sampleBext({
        originator: "KYX unit test",
        originatorReference: "vitest.local",
        timeReference: 48000 * 123456, // 5.9e9 — exercises the high word
      }),
    });
    const view = new DataView(bytes);
    const body = riffChunks(bytes)[1]!.body;
    expect(readFixed(view, body, 256)).toBe("Test beat — master".replace(/[^\x20-\x7e]/g, "?"));
    expect(readFixed(view, body + 256, 32)).toBe("KYX unit test");
    expect(readFixed(view, body + 288, 32)).toBe("vitest.local");
    expect(readFixed(view, body + 320, 10)).toBe("2026:09:26");
    expect(readFixed(view, body + 330, 8)).toBe("13:37:42");
    const time = view.getUint32(body + 342, true) * 0x100000000 + view.getUint32(body + 338, true);
    expect(time).toBe(48000 * 123456);
  });

  it("version 2: loudness uses the EBU Tech 3285 ×100 fixed-point scale", () => {
    const bytes = encodeWav(toneBuffer(), 16, {
      bext: sampleBext({
        loudness: {
          integratedLufs: -14.04,
          truePeakDbtp: -1.234,
          momentaryLufs: -8.5,
          shortTermLufs: -12,
          rangeLu: 7.5,
        },
      }),
    });
    const view = new DataView(bytes);
    const body = riffChunks(bytes)[1]!.body;
    expect(view.getUint16(body + 346, true)).toBe(2);
    expect(view.getInt16(body + 412, true)).toBe(-1404); // 0.01 LU
    expect(view.getInt16(body + 414, true)).toBe(750); // 0.01 LU
    expect(view.getInt16(body + 416, true)).toBe(-123); // 0.01 dBTP
    expect(view.getInt16(body + 418, true)).toBe(-850);
    expect(view.getInt16(body + 420, true)).toBe(-1200);
    expect(inspectMasteringReferenceContainer("wav", bytes).bext?.loudness).toEqual({
      integratedLufs: -14.04,
      rangeLu: 7.5,
      truePeakDbtp: -1.23,
      momentaryLufs: -8.5,
      shortTermLufs: -12,
    });
  });

  it("non-finite loudness uses the unavailable-value sentinel from the spec", () => {
    const bytes = encodeWav(toneBuffer(), 16, {
      bext: sampleBext({ loudness: { integratedLufs: Number.NaN, truePeakDbtp: Number.POSITIVE_INFINITY } }),
    });
    const view = new DataView(bytes);
    const body = riffChunks(bytes)[1]!.body;
    expect(view.getInt16(body + 412, true)).toBe(0x7fff);
    expect(view.getInt16(body + 416, true)).toBe(0x7fff);
    expect(inspectMasteringReferenceContainer("wav", bytes).bext?.loudness).toEqual({
      integratedLufs: null,
      rangeLu: null,
      truePeakDbtp: null,
      momentaryLufs: null,
      shortTermLufs: null,
    });
  });

  it("fixed-width fields are truncated and non-ASCII is replaced with '?'", () => {
    const bytes = encodeWav(toneBuffer(), 16, {
      bext: sampleBext({ description: "Nechaj to ľúbim 🔥 — " + "x".repeat(300) }),
    });
    const view = new DataView(bytes);
    const body = riffChunks(bytes)[1]!.body;
    // Each non-ASCII UTF-16 unit becomes one '?' — ľ, ú, the surrogate pair
    // of 🔥 and the em-dash. Still truncates to exactly 256 bytes.
    const description = readFixed(view, body, 256);
    expect(description).toBe(("Nechaj to ??bim ?? ? " + "x".repeat(300)).slice(0, 256));
    // The field is exactly full (256 bytes) — the next byte is the originator,
    // proving the writer never spills past the spec width.
    expect(readFixed(view, body + 256, 32)).toBe("KYX");
  });

  it("coding history is CRLF-normalized, chunk stays word-aligned, audio bytes unchanged", () => {
    const bext = sampleBext({ codingHistory: "A=PCM\nF=44100,W=16\nT=KYX" });
    const withBext = encodeWav(toneBuffer(), 16, { bext });
    const view = new DataView(withBext);
    const chunks = riffChunks(withBext);
    const bextChunk = chunks[1]!;
    // "A=PCM\r\nF=44100,W=16\r\nT=KYX" = 26 chars (even) → no pad byte needed.
    expect(bextChunk.size).toBe(602 + 26);
    expect(readFixed(view, bextChunk.body + 602, 26)).toBe("A=PCM\r\nF=44100,W=16\r\nT=KYX");
    expect(chunks[2]!.body).toBe(654 + 26);

    // Odd history → one pad byte after the chunk body, data still parseable.
    const odd = encodeWav(toneBuffer(), 16, { bext: sampleBext({ codingHistory: "A=PCM" }) });
    const oddChunks = riffChunks(odd);
    expect(oddChunks[1]!.size).toBe(607);
    expect(oddChunks[2]!.body).toBe(654 + 5 + 1);
    expect(oddChunks[2]!.size).toBe(2 * 2 * FRAMES);

    // Metadata must never touch the samples: data regions are byte-identical
    // (same seeded dither PRNG; data body position comes from the chunk walk).
    const plain = encodeWav(toneBuffer(), 16);
    expect(new Uint8Array(withBext).slice(chunks[2]!.body)).toEqual(new Uint8Array(plain).slice(44));
  });

  it("sync and async encoders stay byte-identical with bext", async () => {
    const bext = sampleBext({ loudness: { integratedLufs: -13.7, truePeakDbtp: -0.9 } });
    const sync = encodeWav(toneBuffer(), 16, { bext });
    const asyncBytes = await encodeWavAsync(toneBuffer(), 16, { bext });
    expect(new Uint8Array(asyncBytes)).toEqual(new Uint8Array(sync));
  });

  it.each([16, 24, 32] as const)(
    "Blob-backed %i-bit encoding stays byte-identical to the contiguous encoder",
    async (depth) => {
      const bext = sampleBext({ loudness: { integratedLufs: -13.7, truePeakDbtp: -0.9 } });
      const contiguous = await encodeWavAsync(toneBuffer(), depth, { bext, integerOverflowPolicy: "reject" });
      const streamed = await encodeWavBlobAsync(toneBuffer(), depth, { bext, integerOverflowPolicy: "reject" });
      expect(streamed.type).toBe("audio/wav");
      expect(new Uint8Array(await streamed.arrayBuffer())).toEqual(new Uint8Array(contiguous));
    },
  );

  it("32-bit float path honors the shifted data offset", () => {
    const bytes = encodeWav(toneBuffer(), 32, { bext: sampleBext() });
    const view = new DataView(bytes);
    const chunks = riffChunks(bytes);
    expect(view.getUint16(chunks[0]!.body, true)).toBe(3); // fmt audioFormat tag = IEEE float
    const data = chunks[2]!;
    expect(data.size).toBe(4 * 2 * FRAMES);
    expect(Number.isFinite(view.getFloat32(data.body, true))).toBe(true);
  });

  it("rejects a truncated or internally corrupted RIFF before accepting a master file", () => {
    const valid = encodeWav(toneBuffer(), 24, { bext: sampleBext() });
    const truncated = valid.slice(0, valid.byteLength - 16);
    expect(() => inspectMasteringReferenceContainer("wav", truncated)).toThrow(/RIFF size extends beyond/);

    const corruptChunk = valid.slice(0);
    const view = new DataView(corruptChunk);
    // Locate the data chunk after fmt + bext, then claim that its payload
    // extends beyond the RIFF boundary.
    const dataChunk = riffChunks(corruptChunk).find((chunk) => chunk.id === "data");
    expect(dataChunk).toBeDefined();
    view.setUint32(dataChunk!.body - 4, 0xfffffff0, true);
    expect(() => inspectMasteringReferenceContainer("wav", corruptChunk)).toThrow(/data chunk extends beyond/);
  });

  it("createBextMetadata fills KYX defaults and formats the EBU clock", () => {
    const meta = createBextMetadata({ description: "d", date: FIXED_DATE });
    expect(meta.originator).toBe("KYX");
    expect(meta.originationDate).toBe("2026:09:26");
    expect(meta.originationTime).toBe("13:37:42");
    expect(meta.timeReference).toBe(0);
    expect(meta.loudness).toBeUndefined();
  });
});

describe("large encoded WAV mastering inspection", () => {
  it.each([16, 24, 32] as const)(
    "streams %i-bit PCM through the canonical worker analyzer and matches decoded sample measurements",
    async (bitDepth) => {
      const sampleRate = 44_100;
      const frameCount = sampleRate * 3 + 1_234;
      const source = fakeBuffer(
        2,
        sampleRate,
        frameCount,
        (channel, frame) =>
          (channel === 0 ? 0.31 : 0.23) * Math.sin((2 * Math.PI * (221 + channel) * frame) / sampleRate),
      );
      const profile = MASTER_PROFILES.find((candidate) => candidate.id === "streaming")!;
      const originalAnalysis = analyzeMasterPcm(
        [source.getChannelData(0), source.getChannelData(1)],
        sampleRate,
        profile,
      );
      const encoded = encodeWav(source, bitDepth, { bext: sampleBext() });
      const dataChunk = riffChunks(encoded).find((chunk) => chunk.id === "data");
      expect(dataChunk).toBeDefined();
      // This independent decode serves as the numeric reference for the bytes
      // the exporter actually wrote, including the shifted BWF data offset.
      const decodedChannels = decodeWavPcmForReference(encoded, dataChunk!.body, bitDepth, frameCount);
      const expected = analyzeMasterPcm(decodedChannels, sampleRate, profile);

      // Force the >96 MiB branch on a small fixture so the unit test exercises
      // chunk decoding and worker handoff without allocating a 100 MiB test file.
      Object.defineProperty(encoded, "byteLength", {
        configurable: true,
        value: 96 * 1024 * 1024 + 1,
      });
      vi.stubGlobal("Worker", MasteringAnalysisWorkerHarness as unknown as typeof Worker);
      try {
        const inspection = await inspectEncodedMaster({
          format: "wav",
          bytes: encoded,
          expectedDurationSeconds: frameCount / sampleRate,
          sourceMeasurements: originalAnalysis.measurements,
          profile,
        });
        expect(inspection.decode.status).toBe("measured");
        if (inspection.decode.status !== "measured")
          throw new Error("Expected the streamed PCM result to be measured.");
        expect(inspection.decode.decoder).toBe("KYX WAV PCM reader");
        expect(inspection.decode.sampleRate).toBe(sampleRate);
        expect(inspection.decode.channels).toBe(2);
        expect(inspection.file.wavEncoding).toBe(bitDepth === 32 ? "ieee-float" : "pcm");
        expect(inspection.fileDelivery?.checks.find((check) => check.line.includes("WAV uses"))?.status).toBe(
          bitDepth === 32 ? "fail" : "pass",
        );
        expect(inspection.decode.durationSeconds).toBeCloseTo(frameCount / sampleRate, 9);
        expect(inspection.decode.measurements?.rmsDb).toBeCloseTo(expected.measurements.rmsDb, 5);
        expect(inspection.decode.measurements?.truePeakDb).toBeCloseTo(expected.measurements.truePeakDb, 5);
        expect(inspection.decode.measurements?.lufsIntegrated).toBeCloseTo(expected.measurements.lufsIntegrated, 5);
        expect(inspection.decode.measurements?.loudnessRangeLu).toBeCloseTo(expected.measurements.loudnessRangeLu!, 5);
      } finally {
        Reflect.deleteProperty(encoded, "byteLength");
        vi.unstubAllGlobals();
      }
    },
    15_000,
  );

  it("inspects a large Blob-backed WAV from a bounded header and PCM slices", async () => {
    const sampleRate = 44_100;
    const frameCount = sampleRate * 3 + 1_234;
    const source = fakeBuffer(
      2,
      sampleRate,
      frameCount,
      (channel, frame) =>
        (channel === 0 ? 0.31 : 0.23) * Math.sin((2 * Math.PI * (221 + channel) * frame) / sampleRate),
    );
    const profile = MASTER_PROFILES.find((candidate) => candidate.id === "streaming")!;
    const originalAnalysis = analyzeMasterPcm(
      [source.getChannelData(0), source.getChannelData(1)],
      sampleRate,
      profile,
    );
    const blob = new Blob([await encodeWavAsync(source, 24, { bext: sampleBext() })], { type: "audio/wav" });
    Object.defineProperty(blob, "size", {
      configurable: true,
      value: 96 * 1024 * 1024 + 1,
    });
    vi.stubGlobal("Worker", MasteringAnalysisWorkerHarness as unknown as typeof Worker);
    try {
      const inspection = await inspectEncodedMaster({
        format: "wav",
        bytes: blob,
        expectedDurationSeconds: frameCount / sampleRate,
        sourceMeasurements: originalAnalysis.measurements,
        profile,
      });
      expect(inspection.decode.status).toBe("measured");
      if (inspection.decode.status !== "measured") throw new Error("Expected the streamed WAV Blob to be measured.");
      expect(inspection.decode.decoder).toBe("KYX WAV PCM reader");
      expect(inspection.decode.measurements?.rmsDb).toBeCloseTo(originalAnalysis.measurements.rmsDb, 5);
      expect(inspection.decode.measurements?.truePeakDb).toBeCloseTo(originalAnalysis.measurements.truePeakDb, 5);
    } finally {
      Reflect.deleteProperty(blob, "size");
      vi.unstubAllGlobals();
    }
  }, 15_000);
});

describe("large encoded MP3 mastering inspection", () => {
  it("keeps the report explicitly not measured when WebCodecs has no MP3 decoder", async () => {
    const frame = new Uint8Array(417);
    frame.set([0xff, 0xfb, 0x90, 0x64]); // MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo
    const blob = new Blob([frame], { type: "audio/mpeg" });
    Object.defineProperty(blob, "size", { configurable: true, value: 12 * 1024 * 1024 + 1 });
    const profile = MASTER_PROFILES.find((candidate) => candidate.id === "streaming")!;
    const source = fakeBuffer(
      2,
      44_100,
      44_100,
      (channel, frameIndex) => 0.2 * Math.sin((2 * Math.PI * (220 + channel) * frameIndex) / 44_100),
    );
    const sourceAnalysis = analyzeMasterPcm(
      [source.getChannelData(0), source.getChannelData(1)],
      source.sampleRate,
      profile,
    );
    vi.stubGlobal("Worker", UnsupportedMp3WorkerHarness as unknown as typeof Worker);
    try {
      const inspection = await inspectEncodedMaster({
        format: "mp3",
        bytes: blob,
        expectedDurationSeconds: 1,
        sourceMeasurements: sourceAnalysis.measurements,
        profile,
      });
      expect(inspection.decode.status).toBe("not-measured");
      expect(inspection.decode.decoder).toBe("WebCodecs MP3 worker");
      expect(inspection.decode.reason).toContain("does not support MP3 through WebCodecs");
      expect(inspection.file.durationAccuracy).toBe("estimated");
      expect(inspection.fileDelivery?.status).toBe("warn");
      expect(inspection.fileDelivery?.checks[0]?.line).toContain("MP3 is not listed");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
