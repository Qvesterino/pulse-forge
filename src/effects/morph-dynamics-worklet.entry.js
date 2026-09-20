/**
 * MORPH DYNAMICS AudioWorklet entry — bundled by
 * scripts/build-morph-dynamics-worklet.mjs into a single classic-script
 * file (public/morph-dynamics-worklet.js) that the loader feeds to
 * AudioWorklet.addModule().
 *
 * Thin wrapper: all DSP lives in morph-dynamics-core (typed, first-party).
 * The wrapper owns block copying, parameter messaging (immediate +
 * time-stamped automation queue) and meter posting. Protocol mirrors the
 * ultina entry so the node wrapper and engine treat both identically.
 */
import { MorphDynamicsProcessor } from "./morph-dynamics-core/dsp/morphDynamicsProcessor.ts";

const MAX_BLOCK = 128;
const CHANNELS = 2;
// Meter cadence target (~20 Hz), derived from the ACTUAL render rate.
const METERS_DIVIDER = Math.max(1, Math.round(sampleRate / MAX_BLOCK / 20));
// Automation queue bound (mirrors ultina): a pathological finite `when`
// must not turn every later insertion into an O(n) render-thread scan.
const PENDING_PARAMS_CAP = 4096;

class MorphDynamicsWorkletProcessor extends AudioWorkletProcessor {
  proc = new MorphDynamicsProcessor();
  scratch = [new Float32Array(MAX_BLOCK), new Float32Array(MAX_BLOCK)];
  lastLatencyPosted = -1;
  blockCount = 0;
  metersEnabled = true;
  disposed = false;
  pendingParams = [];

  constructor(options) {
    super();
    this.proc.prepare(sampleRate, CHANNELS, MAX_BLOCK, 1); // normal quality
    const initial = options?.processorOptions?.params;
    if (initial) this.proc.loadState(initial);
    this.postLatency();
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === "params") {
        this.proc.loadState(msg.params);
        this.postLatency();
      } else if (msg.type === "param") {
        // A manual value cancels still-pending automation for the same
        // parameter (user touch overrides the future). In-place compaction
        // — this handler runs on the render thread.
        if (this.pendingParams.length > 0) {
          const now = currentTime;
          const q = this.pendingParams;
          let w = 0;
          for (let i = 0; i < q.length; i++) {
            const ev = q[i];
            if (ev.id !== msg.id || ev.when <= now) q[w++] = ev;
          }
          q.length = w;
        }
        this.proc.setParameter(msg.id, msg.value);
      } else if (msg.type === "paramAt") {
        const when = Number(msg.when);
        if (!Number.isFinite(when)) {
          this.proc.setParameter(msg.id, msg.value);
          return;
        }
        // Keep sorted ascending by `when`; at the cap the INCOMING event is
        // dropped (already-queued lanes keep exact ordering, growth bounded).
        const q = this.pendingParams;
        if (q.length >= PENDING_PARAMS_CAP) return;
        let i = q.length;
        while (i > 0 && q[i - 1].when > when) i--;
        q.splice(i, 0, { id: msg.id, value: msg.value, when });
      } else if (msg.type === "reset") {
        this.pendingParams.length = 0;
        this.proc.reset();
      } else if (msg.type === "setMeters") {
        // Metering gate: with no panel attached the host disables the port
        // posting so per-instance cost stays flat. (The control engine itself
        // keeps running — the mod matrix must not freeze when a panel closes.)
        this.metersEnabled = msg.enabled !== false;
        this.proc.setMetersEnabled(this.metersEnabled);
      } else if (msg.type === "dispose") {
        this.proc.dispose();
        this.disposed = true;
      }
    };
  }

  postLatency() {
    const samples = this.proc.getLatencySamples();
    if (samples !== this.lastLatencyPosted) {
      this.lastLatencyPosted = samples;
      this.port.postMessage({ type: "latency", samples });
    }
  }

  applyDueParams(horizon) {
    const q = this.pendingParams;
    if (q.length === 0 || q[0].when > horizon) return;
    // Consume the due PREFIX by index and compact in place — shift() would
    // make dense automation queues O(n²) per block.
    let applied = 0;
    while (applied < q.length && q[applied].when <= horizon) {
      const ev = q[applied];
      this.proc.setParameter(ev.id, ev.value);
      applied++;
    }
    if (applied > 0) {
      const remaining = q.length - applied;
      for (let j = 0; j < remaining; j++) q[j] = q[j + applied];
      q.length = remaining;
    }
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const output = outputs[0];
    if (!output || !output[0] || !output[1]) return true;
    const input = inputs[0];
    const total = output[0].length;
    // Events up to the end of the block apply now (≤ one quantum early).
    this.applyDueParams(currentTime + total / sampleRate);

    // The render quantum is 128 everywhere today, but the spec allows larger
    // buffers — loop internal MAX_BLOCK chunks so every sample is written.
    for (let offset = 0; offset < total; offset += MAX_BLOCK) {
      const frames = Math.min(MAX_BLOCK, total - offset);
      for (let c = 0; c < CHANNELS; c++) {
        const buf = this.scratch[c];
        const inCh = input && input[c];
        if (inCh && inCh.length >= offset + frames) {
          buf.set(inCh.subarray(offset, offset + frames));
        } else {
          buf.fill(0, 0, frames);
        }
      }
      this.proc.process(this.scratch, frames);
      for (let c = 0; c < CHANNELS; c++) {
        output[c].set(this.scratch[c].subarray(0, frames), offset);
      }
    }
    // Meters snapshot ≈20 Hz — skipped entirely while the host has the gate
    // off (no panel attached).
    if (this.metersEnabled && this.blockCount++ % METERS_DIVIDER === 0) {
      this.port.postMessage({ type: "meters", meters: this.proc.getMeters() });
    }
    this.postLatency();
    return true;
  }
}

registerProcessor("morphdynamics-processor", MorphDynamicsWorkletProcessor);
