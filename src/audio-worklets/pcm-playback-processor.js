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
import { PcmRingReader } from "../audio-engine/pcmRing";

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.reader = null;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "attach" && data.sab instanceof SharedArrayBuffer) {
        try {
          this.reader = new PcmRingReader(data.sab);
        } catch {
          this.reader = null;
        }
      } else if (data.type === "detach") {
        this.reader = null;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }
    if (!this.reader) {
      // No attached source yet — output silence (128-frame quantum, single
      // channel semantics don't apply: stay silent on every channel).
      for (let channel = 0; channel < output.length; channel++) output[channel].fill(0);
      return true;
    }
    const frames = output[0].length;
    this.reader.readIntoChannels(output, frames);
    return true;
  }
}

registerProcessor("pcm-playback", PcmPlaybackProcessor);
