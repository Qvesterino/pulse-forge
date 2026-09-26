import { describe, expect, it } from "vitest";
import { createBextMetadata, encodeWav, encodeWavAsync, type WavBextMetadata } from "../src/rendering/wav";

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

  it("version 2: loudness uses the EBU fixed-point scales and clamps to int16", () => {
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
    expect(view.getInt16(body + 412, true)).toBe(-140); // 0.1 LU
    expect(view.getInt16(body + 414, true)).toBe(75); // 0.1 LU
    expect(view.getInt16(body + 416, true)).toBe(-123); // 0.01 dBTP
    expect(view.getInt16(body + 418, true)).toBe(-85);
    expect(view.getInt16(body + 420, true)).toBe(-120);
  });

  it("non-finite loudness collapses to 0 (undefined per spec) instead of poisoning the chunk", () => {
    const bytes = encodeWav(toneBuffer(), 16, {
      bext: sampleBext({ loudness: { integratedLufs: Number.NaN, truePeakDbtp: Number.POSITIVE_INFINITY } }),
    });
    const view = new DataView(bytes);
    const body = riffChunks(bytes)[1]!.body;
    expect(view.getInt16(body + 412, true)).toBe(0);
    expect(view.getInt16(body + 416, true)).toBe(0); // not NaN, not a clamped absurdity
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
    expect(readFixed(view, body + 256, 32)).toBe("KYX (Pulse Forge)");
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

  it("32-bit float path honors the shifted data offset", () => {
    const bytes = encodeWav(toneBuffer(), 32, { bext: sampleBext() });
    const view = new DataView(bytes);
    const chunks = riffChunks(bytes);
    expect(view.getUint16(chunks[0]!.body, true)).toBe(3); // fmt audioFormat tag = IEEE float
    const data = chunks[2]!;
    expect(data.size).toBe(4 * 2 * FRAMES);
    expect(Number.isFinite(view.getFloat32(data.body, true))).toBe(true);
  });

  it("createBextMetadata fills KYX defaults and formats the EBU clock", () => {
    const meta = createBextMetadata({ description: "d", date: FIXED_DATE });
    expect(meta.originator).toBe("KYX (Pulse Forge)");
    expect(meta.originationDate).toBe("2026:09:26");
    expect(meta.originationTime).toBe("13:37:42");
    expect(meta.timeReference).toBe(0);
    expect(meta.loudness).toBeUndefined();
  });
});
