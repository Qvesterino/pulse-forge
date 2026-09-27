/**
 * SPSC PCM ring over a SharedArrayBuffer — the wave 3 playback transport
 * (ADR 0018). The producer (desktop bridge writing pipe frames) and the
 * consumer (AudioWorkletProcessor on the audio thread) share one SAB:
 *
 *   bytes 0..63   header, Int32 words:
 *     0 magic (0x50434d31 "PCM1")
 *     1 channels
 *     2 capacityFrames (power of two)
 *     3 sampleRate
 *     4 writeIndex   (total frames ever written, wraps at 2^32)
 *     5 readIndex    (total frames ever consumed)
 *     6 overruns     (frames the producer dropped because the ring was full)
 *     7 underruns    (reads that wanted more frames than available)
 *   bytes 64..     interleaved float32 data (channels × capacityFrames)
 *
 * Single-producer/single-consumer: the producer DROPS the newest frames when
 * the ring is full (queued audio is never rewritten), the consumer never
 * passes the writer (underruns output silence and count an underrun). The
 * identical layout is mirrored in desktop/pcm-ring-layout.cjs — the interop
 * test in tests/pcm-playback.test.ts keeps the two honest against each other.
 */

export const PCM_RING_MAGIC = 0x50434d31; /* "PCM1" */
export const PCM_RING_HEADER_WORDS = 16;
/** Header byte size — 64 keeps the float data 8-aligned. */
export const PCM_RING_HEADER_BYTES = PCM_RING_HEADER_WORDS * 4;

export interface PcmRingFormat {
  channels: number;
  capacityFrames: number;
  sampleRate: number;
}

export class PcmRingUnsupportedError extends Error {
  constructor() {
    super("SharedArrayBuffer unavailable — the PCM playback ring needs cross-origin isolation or Electron");
    this.name = "PcmRingUnsupportedError";
  }
}

export function pcmRingBytes(format: PcmRingFormat): number {
  return PCM_RING_HEADER_BYTES + format.channels * format.capacityFrames * 4;
}

/** Create a SAB laid out for the ring with the given format. */
export function createPcmRingBuffer(format: PcmRingFormat): SharedArrayBuffer {
  if (typeof SharedArrayBuffer === "undefined") throw new PcmRingUnsupportedError();
  const cap = format.capacityFrames;
  if ((cap & (cap - 1)) !== 0 || cap < 256) throw new Error("capacityFrames must be a power of two >= 256");
  return new SharedArrayBuffer(pcmRingBytes(format));
}

/** Shared header accessor used by both sides (producer + consumer). */
export class PcmRingHeader {
  readonly words: Int32Array;

  constructor(readonly sab: SharedArrayBuffer) {
    this.words = new Int32Array(sab, 0, PCM_RING_HEADER_WORDS);
  }

  init(format: PcmRingFormat): void {
    Atomics.store(this.words, 0, PCM_RING_MAGIC);
    Atomics.store(this.words, 1, format.channels);
    Atomics.store(this.words, 2, format.capacityFrames);
    Atomics.store(this.words, 3, format.sampleRate);
    Atomics.store(this.words, 4, 0);
    Atomics.store(this.words, 5, 0);
    Atomics.store(this.words, 6, 0);
    Atomics.store(this.words, 7, 0);
  }

  readFormat(): PcmRingFormat {
    return {
      channels: Atomics.load(this.words, 1),
      capacityFrames: Atomics.load(this.words, 2),
      sampleRate: Atomics.load(this.words, 3),
    };
  }
}

/** Frames between two monotonic counters (2^32 wrap-safe for sane backlogs). */
export function ringDistance(later: number, earlier: number): number {
  return (later - earlier) >>> 0;
}

/** Producer side: writes interleaved frames, drops the newest when full. */
export class PcmRingWriter {
  private readonly data: Float32Array;
  private readonly header: PcmRingHeader;
  readonly format: PcmRingFormat;

  constructor(sab: SharedArrayBuffer, format?: PcmRingFormat) {
    if (typeof SharedArrayBuffer === "undefined") throw new PcmRingUnsupportedError();
    this.header = new PcmRingHeader(sab);
    this.format = format ?? this.header.readFormat();
    this.data = new Float32Array(sab, PCM_RING_HEADER_BYTES);
  }

  /** Write interleaved frames. Returns {written, dropped} — never overwrites. */
  writeBlock(interleaved: Float32Array): { written: number; dropped: number } {
    const ch = this.format.channels;
    const cap = this.format.capacityFrames;
    const writeIndex = Atomics.load(this.header.words, 4);
    const readIndex = Atomics.load(this.header.words, 5);
    const queued = ringDistance(writeIndex, readIndex);
    const space = cap - queued;
    const wanted = interleaved.length / ch;
    const writable = Math.min(wanted, space);
    const base = writeIndex % cap;
    for (let n = 0; n < writable; n++) {
      const ringPos = (base + n) % cap;
      for (let c = 0; c < ch; c++) this.data[ringPos * ch + c] = interleaved[n * ch + c];
    }
    Atomics.store(this.header.words, 4, (writeIndex + writable) >>> 0);
    const dropped = wanted - writable;
    if (dropped > 0) Atomics.add(this.header.words, 6, dropped);
    return { written: writable, dropped };
  }
}

/** Consumer side (audio thread): never blocks, underruns output silence. */
export class PcmRingReader {
  private readonly data: Float32Array;
  private readonly header: PcmRingHeader;
  readonly format: PcmRingFormat;

  constructor(sab: SharedArrayBuffer) {
    if (typeof SharedArrayBuffer === "undefined") throw new PcmRingUnsupportedError();
    this.header = new PcmRingHeader(sab);
    this.format = this.header.readFormat();
    this.data = new Float32Array(sab, PCM_RING_HEADER_BYTES);
  }

  /**
   * Read up to `wanted` interleaved frames into `out`. Returns frames read;
   * when fewer are available the rest of `out` is zeroed (silence) and an
   * underrun is counted.
   */
  readInto(out: Float32Array, wanted: number): number {
    const ch = this.format.channels;
    const cap = this.format.capacityFrames;
    const writeIndex = Atomics.load(this.header.words, 4);
    const readIndex = Atomics.load(this.header.words, 5);
    const available = Math.min(wanted, ringDistance(writeIndex, readIndex));
    const base = readIndex % cap;
    for (let n = 0; n < available; n++) {
      const ringPos = (base + n) % cap;
      for (let c = 0; c < ch; c++) out[n * ch + c] = this.data[ringPos * ch + c];
    }
    for (let n = available * ch; n < wanted * ch; n++) out[n] = 0;
    Atomics.store(this.header.words, 5, (readIndex + available) >>> 0);
    if (available < wanted) Atomics.add(this.header.words, 7, 1);
    return available;
  }

  underruns(): number {
    return Atomics.load(this.header.words, 7);
  }

  overruns(): number {
    return Atomics.load(this.header.words, 6);
  }
}

/** Deinterleave an interleaved block into per-channel outputs (worklet core). */
export function deinterleaveToChannels(
  interleaved: Float32Array,
  channels: number,
  outputs: Float32Array[],
): void {
  const frames = interleaved.length / channels;
  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < channels; c++) outputs[c][n] = interleaved[n * channels + c];
  }
}
