/**
 * PCM playback processor (ADR 0018 wave 3) — reads the shared ring written
 * by the desktop bridge and renders it as output audio.
 *
 * Contract: the main world posts {sab, rate} once; the processor verifies the
 * ring's rate against the context's, then on every render quantum reads
 * interleaved frames from the ring and deinterleaves them into the output
 * channels. Underrun = silence for that quantum (counted in the ring header,
 * visible to any diagnostics surface via PcmRingReader).
 */
import { PcmRingReader, deinterleaveToChannels } from "../audio-engine/pcmRing";

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.reader = null;
    this.scratch = null;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "attach" && data.sab instanceof SharedArrayBuffer) {
        try {
          this.reader = new PcmRingReader(data.sab);
          this.scratch = new Float32Array(128 * this.reader.format.channels);
        } catch {
          this.reader = null;
        }
      } else if (data.type === "detach") {
        this.reader = null;
        this.scratch = null;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!this.reader || !this.scratch || output.length === 0) {
      // No attached source yet — output silence (128-frame quantum, single
      // channel semantics don't apply: stay silent on every channel).
      for (const channel of output) channel.fill(0);
      return true;
    }
    const channels = Math.min(this.reader.format.channels, output.length);
    const frames = output[0].length;
    if (this.scratch.length < frames * channels) this.scratch = new Float32Array(frames * channels);
    const read = this.reader.readInto(this.scratch, frames);
    deinterleaveToChannels(this.scratch.subarray(0, read * channels), channels, output);
    for (let c = 0; c < output.length; c++) {
      if (c >= channels) output[c].fill(0);
      else if (read < frames) output[c].fill(0, read);
    }
    return true;
  }
}

registerProcessor("pcm-playback", PcmPlaybackProcessor);
