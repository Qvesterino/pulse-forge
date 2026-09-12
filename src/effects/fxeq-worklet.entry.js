/**
 * FXEQ AudioWorklet entry — bundled by scripts/build-fxeq-worklet.mjs into a
 * single classic-script file (public/fxeq-worklet.js) that the loader feeds
 * to AudioWorklet.addModule().
 *
 * Thin wrapper: all DSP lives in the vendored fxeq-core (bit-exact with the
 * VocalForge oracle, see tests/fxeq-golden.test.ts). The wrapper owns only
 * the worklet plumbing — block copying and parameter messaging.
 */
import { createFxEqProcessor } from "./fxeq-core/core/fxEqProcessor.ts";

const MAX_BLOCK = 128;
const CHANNELS = 2;

class FxEqWorkletProcessor extends AudioWorkletProcessor {
  // `proc` never allocates inside process() — scratch is preallocated in prepare().
  proc;
  /** Processing scratch (in-place DSP), copied to/from the graph buffers. */
  scratch = [new Float32Array(MAX_BLOCK), new Float32Array(MAX_BLOCK)];
  /** Band-peak metering: gated by the host panel, throttled to ~20 Hz. */
  metersEnabled = false;
  blockCount = 0;
  meterDivider = Math.max(1, Math.round((sampleRate / MAX_BLOCK) / 20));
  // Port messages have no render-time semantics. Keep automation events in
  // the audio thread and apply them at the block that reaches their timestamp
  // so FXEQ exports/playback do not collapse every point to the last value.
  pendingParams = [];

  constructor(options) {
    super();
    const initial = options?.processorOptions?.params;
    const rawSeed = options?.processorOptions?.seed;
    const seed = Number.isFinite(rawSeed) ? (rawSeed >>> 0) || 0x1 : undefined;
    this.proc = createFxEqProcessor(initial, seed === undefined ? undefined : { seed });
    this.proc.prepare(sampleRate, CHANNELS, MAX_BLOCK);
    this.lastLatencyPosted = -1;
    // Report DSP latency (oversampled bands add delay) so the host's PDC
    // can compensate — sent on init and whenever params change it.
    this.postLatency();
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === "params") {
        this.pendingParams.length = 0;
        this.proc.loadParameters(msg.params);
        this.postLatency();
      } else if (msg.type === "param") {
        const now = currentTime;
        // Manual control supersedes future automation for this id. Compact
        // the queue IN PLACE — the old Array#filter allocated a fresh array
        // on the render thread for every knob move.
        const q = this.pendingParams;
        let w = 0;
        for (let i = 0; i < q.length; i++) {
          const ev = q[i];
          if (ev.id !== msg.id || ev.when <= now) q[w++] = ev;
        }
        q.length = w;
        this.proc.setParameter(msg.id, msg.value);
        this.postLatency();
      } else if (msg.type === "paramAt") {
        const when = Number(msg.when);
        if (!Number.isFinite(when)) {
          this.proc.setParameter(msg.id, msg.value);
          this.postLatency();
          return;
        }
        const q = this.pendingParams;
        let i = q.length;
        while (i > 0 && q[i - 1].when > when) i--;
        q.splice(i, 0, { id: msg.id, value: msg.value, when });
      } else if (msg.type === "reset") {
        this.pendingParams.length = 0;
        this.proc.reset();
      } else if (msg.type === "bpm") {
        // Q2 tempo sync — latency is unaffected, no re-report needed.
        this.proc.setTempo(msg.bpm);
      } else if (msg.type === "setMetersEnabled") {
        this.metersEnabled = !!msg.enabled;
      }
    };
  }

  applyDueParams(horizon) {
    const q = this.pendingParams;
    if (q.length === 0 || q[0].when > horizon) return;
    // Consume the due PREFIX by index and compact in place — shift() is
    // O(n) per event, which made dense automation queues O(n²) per block.
    let i = 0;
    while (i < q.length && q[i].when <= horizon) {
      const ev = q[i];
      this.proc.setParameter(ev.id, ev.value);
      i++;
    }
    const remaining = q.length - i;
    for (let j = 0; j < remaining; j++) q[j] = q[j + i];
    q.length = remaining;
    this.postLatency();
  }

  postLatency() {
    const samples = this.proc.getLatencySamples();
    if (samples !== this.lastLatencyPosted) {
      this.lastLatencyPosted = samples;
      this.port.postMessage({ type: "latency", samples });
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const frames = Math.min(MAX_BLOCK, output[0].length);
    const input = inputs[0];

    this.applyDueParams(currentTime + frames / sampleRate);

    // Stage the block into scratch (input or silence), process in place,
    // copy back. Deterministic regardless of how the host wires channels.
    for (let c = 0; c < CHANNELS; c++) {
      const buf = this.scratch[c];
      const inCh = input?.[c];
      if (inCh && inCh.length >= frames) buf.set(inCh.subarray(0, frames));
      else buf.fill(0, 0, frames);
    }
    this.proc.process(this.scratch, frames);
    // Latency can change INSIDE process(): the oversampled saturation path
    // engages on the first processed block after its drive/quality crosses
    // the oversampling threshold (the factor also rides block-smoothed
    // drive, so the crossing lands many blocks after the param message).
    // postLatency() is change-guarded, so this is one integer compare per
    // block and the host's PDC sees the transition the moment it happens.
    this.postLatency();
    for (let c = 0; c < CHANNELS; c++) {
      const outCh = output[c];
      if (outCh) outCh.set(this.scratch[c].subarray(0, frames));
    }
    // Band-peak metering for the panel — gated (closed panel costs zero)
    // and throttled to ~20 Hz. getBandPeaks() reads the per-band peaks the
    // DSP already tracked during process(); no extra analysis on the audio
    // thread.
    if (this.metersEnabled && this.blockCount++ % this.meterDivider === 0) {
      this.port.postMessage({ type: "bandPeaks", peaks: this.proc.getBandPeaks() });
    }
    return true;
  }
}

registerProcessor("fxeq-processor", FxEqWorkletProcessor);
