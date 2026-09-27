/**
 * PCM ring layout — the Node-side producer mirror of
 * src/audio-engine/pcmRing.ts (ADR 0018 wave 3). The byte layout is the
 * CONTRACT: 16 Int32 header words at 0..63, interleaved float32 data after.
 * tests/pcm-playback.test.ts runs a producer from THIS file against the TS
 * reader in the SAME SAB — layout drift breaks that test loudly.
 *
 * The bridge consumes PcmPipeSource "pcm" events and writes them into a ring
 * the RENDERER created (createPcmRingBuffer + init on the TS side, then the
 * SAB reaches the main process over IPC). The header's sampleRate is the
 * audio context's rate; a source at a different rate is an error — wave 3
 * has no resampler, the ASIO host is told what rate the context wants.
 */
const PCM_RING_MAGIC = 0x50434d31; /* "PCM1" */
const PCM_RING_HEADER_WORDS = 16;
const PCM_RING_HEADER_BYTES = PCM_RING_HEADER_WORDS * 4;

function ringDistance(later, earlier) {
  return (later - earlier) >>> 0;
}

/** Producer ring over an existing SAB (layout mirror of PcmRingWriter). */
class PcmRingNodeWriter {
  constructor(sab) {
    this.sab = sab;
    this.words = new Int32Array(sab, 0, PCM_RING_HEADER_WORDS);
    if (Atomics.load(this.words, 0) !== PCM_RING_MAGIC) {
      throw new Error("SAB is not an initialized PCM ring (renderer must create + init it)");
    }
    this.format = {
      channels: Atomics.load(this.words, 1),
      capacityFrames: Atomics.load(this.words, 2),
      sampleRate: Atomics.load(this.words, 3),
    };
    this.data = new Float32Array(sab, PCM_RING_HEADER_BYTES);
  }

  writeBlock(interleaved) {
    const ch = this.format.channels;
    const cap = this.format.capacityFrames;
    const writeIndex = Atomics.load(this.words, 4);
    const readIndex = Atomics.load(this.words, 5);
    const space = cap - ringDistance(writeIndex, readIndex);
    const wanted = interleaved.length / ch;
    const writable = Math.min(wanted, space);
    const base = writeIndex % cap;
    for (let n = 0; n < writable; n++) {
      const ringPos = (base + n) % cap;
      for (let c = 0; c < ch; c++) this.data[ringPos * ch + c] = interleaved[n * ch + c];
    }
    Atomics.store(this.words, 4, (writeIndex + writable) >>> 0);
    const dropped = wanted - writable;
    if (dropped > 0) Atomics.add(this.words, 6, dropped);
    return { written: writable, dropped };
  }
}

/**
 * Pipe → SAB bridge. `source` is a PcmPipeSource; every PCM block lands in
 * the ring. Rate mismatch (no resampler in wave 3) stops the bridge and
 * reports through onError — the caller decides whether to retry the source
 * at the context rate.
 */
class PcmPipeToSabBridge {
  constructor({ source, sab, onError } = {}) {
    if (!source || !sab) throw new Error("bridge needs a PcmPipeSource and a SharedArrayBuffer");
    this.writer = new PcmRingNodeWriter(sab);
    this.stopped = false;
    this.unsubscribers = [
      source.on("format", (format) => {
        if (format.rate !== this.writer.format.sampleRate) {
          this.stop();
          onError?.(`source rate ${format.rate} != context rate ${this.writer.format.sampleRate} — resampling is wave 3.5`);
        }
      }),
      source.on("pcm", (block) => {
        if (this.stopped) return;
        this.writer.writeBlock(block.samples);
      }),
    ];
  }

  stop() {
    this.stopped = true;
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }
}

module.exports = { PcmRingNodeWriter, PcmPipeToSabBridge, PCM_RING_MAGIC, PCM_RING_HEADER_BYTES };
