/**
 * Ultina AudioWorklet entry — bundled by scripts/build-ultina-worklet.mjs
 * into a single classic-script file (public/ultina-worklet.js) that the
 * loader feeds to AudioWorklet.addModule().
 *
 * Thin wrapper: all DSP lives in the vendored ultina-core (bit-exact with
 * the VocalForge vectors, see tests/ultina-vectors.test.ts). The wrapper
 * owns block copying, parameter messaging and latency reporting.
 */
import { UltinaProcessor } from "./ultina-core/dsp/ultinaProcessor.ts";
import { registerCoreModules } from "./ultina-core/dsp/moduleFactories.ts";
import { MODULE_TYPES } from "./ultina-core/contracts/moduleTypes.ts";

const MAX_BLOCK = 128;
const CHANNELS = 2;
// Meters cadence target (~20 Hz), derived from the ACTUAL render rate — a
// hardcoded 16-quantum mask posted at ~47 Hz @96 kHz / ~94 Hz @192 kHz
// (the fxeq entry already derived this; divergence found in audit).
const METERS_DIVIDER = Math.max(1, Math.round(sampleRate / MAX_BLOCK / 20));
// Automation queue bound: a pathological finite `when` (broken tempo map,
// 1e300) would otherwise sit in the sorted queue forever, turning every
// later insertion into an O(n) render-thread scan.
const PENDING_PARAMS_CAP = 4096;

class UltinaWorkletProcessor extends AudioWorkletProcessor {
  proc = new UltinaProcessor();
  scratch = [new Float32Array(MAX_BLOCK), new Float32Array(MAX_BLOCK)];
  lastLatencyPosted = -1;
  blockCount = 0;
  metersEnabled = true;
  disposed = false;
  // Time-stamped parameter events (setParameterAt — automation lanes and
  // offline renders), sorted ascending by `when`. Applied from process()
  // when the render clock reaches them — port messages alone have no
  // timing, so without this queue an offline export would hear every
  // automation point at the moment it was POSTED (the last one wins),
  // collapsing the lane to a constant.
  pendingParams = [];

  constructor(options) {
    super();
    registerCoreModules(this.proc);
    this.proc.prepare({
      sampleRate,
      channelCount: CHANNELS,
      maxBlockSize: MAX_BLOCK,
      qualityMode: 1, // "mix" — matches the vector harness
    });
    const initial = options?.processorOptions?.params;
    if (initial) this.proc.loadState(initial);
    this.syncGraphFromParams();
    this.postLatency();
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === "params") {
        this.proc.loadState(msg.params);
        this.syncGraphFromParams();
        this.postLatency();
      } else if (msg.type === "param") {
        // A manual value cancels still-pending automation for the same
        // parameter (user touch overrides the future), matching how the
        // engine treats AudioParam.cancelScheduledValues on takeover.
        // In-place compaction: this handler runs on the render thread, so
        // filter()'s fresh array would be an audio-thread allocation per
        // message during a live knob drag.
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
        // Module on/off travels as a regular "<module>.enabled" param, but
        // the audio thread walks the module GRAPH — a toggle must be mirrored
        // there or the module never enters the active chain.
        if (typeof msg.id === "string" && msg.id.endsWith(".enabled")) {
          this.syncGraphFromParams();
        }
        // Latency-affecting params are not just ".enabled": crossover mode,
        // band count, per-module oversampling and the global quality mode
        // all change module latency (hybrid FIR group delay, HQ oversampler
        // delay). postLatency() no-ops unless the value changed.
        this.postLatency();
      } else if (msg.type === "paramAt") {
        const when = Number(msg.when);
        if (!Number.isFinite(when)) {
          // Defensive: a malformed timestamp degrades to an immediate set.
          this.proc.setParameter(msg.id, msg.value);
          if (typeof msg.id === "string" && msg.id.endsWith(".enabled")) {
            this.syncGraphFromParams();
          }
          this.postLatency();
          return;
        }
        // Keep the queue sorted ascending by `when`; events usually arrive
        // in order, so scan back from the end. At the cap the INCOMING event
        // is dropped: already-queued lanes keep their exact ordering, and a
        // pathological sender cannot grow the queue unboundedly (a finite
        // huge `when` would otherwise sit here for the page's lifetime).
        const q = this.pendingParams;
        if (q.length >= PENDING_PARAMS_CAP) return;
        let i = q.length;
        while (i > 0 && q[i - 1].when > when) i--;
        q.splice(i, 0, { id: msg.id, value: msg.value, when });
      } else if (msg.type === "reset") {
        this.pendingParams.length = 0;
        this.proc.reset();
      } else if (msg.type === "setMeters") {
        // Metering gate: with no panel attached the host disables the whole
        // analysis path (spectrum FFT, 32-band analyzer, waveform, snapshot
        // posting) so per-instance audio-thread cost stays flat.
        this.metersEnabled = msg.enabled !== false;
        this.proc.setMetersEnabled(this.metersEnabled);
      } else if (msg.type === "dispose") {
        // Node teardown: unregister from the cross-instance spectral
        // registry. AudioWorkletProcessor has no destruction hook, so this
        // message is the only signal — without it every instance ever
        // created leaks a stale registry entry for the page's lifetime.
        this.proc.dispose();
        // Stop DSP + latency posts for any quantum pulled between this
        // message and the main thread's node.disconnect() (mirrors Ozvena).
        this.disposed = true;
      }
    };
  }

  /** Mirror the host-facing "<module>.enabled" params into the module graph.
   * The graph boots ALL-DISABLED and nothing else syncs it — without this,
   * the active chain stays empty forever and every module (EQ/Comp/Gate/…)
   * is silent DSP while the UI happily reports it on. */
  syncGraphFromParams() {
    const graph = this.proc.getGraphRuntime();
    for (const type of MODULE_TYPES) {
      graph.setModuleEnabled(type, this.proc.getParameter(`${type}.enabled`) >= 0.5);
    }
  }

  postLatency() {
    const samples = this.proc.getLatencySamples();
    if (samples !== this.lastLatencyPosted) {
      this.lastLatencyPosted = samples;
      this.port.postMessage({ type: "latency", samples });
    }
  }

  /** Apply every queued event whose project time has arrived (the render
   *  clock granularity is one 128-frame quantum ≈ 2.7 ms). */
  applyDueParams(horizon) {
    const q = this.pendingParams;
    if (q.length === 0 || q[0].when > horizon) return;
    // Consume the due PREFIX by index and compact in place — shift() is
    // O(n) per event, which made dense automation queues O(n²) per block.
    let applied = 0;
    let enabledToggled = false;
    while (applied < q.length && q[applied].when <= horizon) {
      const ev = q[applied];
      this.proc.setParameter(ev.id, ev.value);
      if (typeof ev.id === "string" && ev.id.endsWith(".enabled")) {
        enabledToggled = true;
      }
      applied++;
    }
    if (applied > 0) {
      const remaining = q.length - applied;
      for (let j = 0; j < remaining; j++) q[j] = q[j + applied];
      q.length = remaining;
      if (enabledToggled) this.syncGraphFromParams();
      this.postLatency();
    }
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const output = outputs[0];
    if (!output || !output[0] || !output[1]) return true;
    const input = inputs[0];
    const total = output[0].length;
    // `currentTime` is the first sample of this quantum; events up to the
    // end of the block are applied now (≤ one quantum early) so the whole
    // block processes with one coherent parameter set.
    this.applyDueParams(currentTime + total / sampleRate);

    // The render quantum is 128 everywhere today, but the spec allows a host
    // to supply larger buffers — loop the internal MAX_BLOCK chunks so EVERY
    // output sample is written (a single 128-frame pass would leave samples
    // beyond it stale, duplicating the previous block's audio).
    for (let offset = 0; offset < total; offset += MAX_BLOCK) {
      const frames = Math.min(MAX_BLOCK, total - offset);
      for (let c = 0; c < CHANNELS; c++) {
        const buf = this.scratch[c];
        const inCh = input && input[c];
        if (inCh && inCh.length >= offset + frames) {
          buf.set(inCh.subarray(offset, offset + frames));
        } else {
          // Input unavailable for this chunk (no channel, or shorter than
          // the output quantum at this offset — the old `subarray(0, frames)`
          // fallback here would re-copy the input HEAD into every later
          // chunk, duplicating audio; per spec inputs always match the
          // quantum, so this is belt-and-braces silence).
          buf.fill(0, 0, frames);
        }
      }
      this.proc.process(this.scratch, frames);
      for (let c = 0; c < CHANNELS; c++) {
        output[c].set(this.scratch[c].subarray(0, frames), offset);
      }
    }
    // Meters snapshot ≈20 Hz (rate-derived divider) — spectrum/LUFS/waveform/
    // GR for the panel. Entirely skipped while the host has metering disabled.
    if (this.metersEnabled && this.blockCount++ % METERS_DIVIDER === 0) {
      this.port.postMessage({ type: "meters", meters: this.proc.getMeters() });
    }
    // Modules configure their crossover (and thus DSP latency) on their
    // first processed block — re-report latency here so the host PDC picks
    // up hybrid-mode delay that was unknown at construction time. Runs
    // REGARDLESS of metering (change-guarded: one compare per block) —
    // gating it on meters left latency stale whenever the panel was closed.
    this.postLatency();
    return true;
  }
}

registerProcessor("ultina-processor", UltinaWorkletProcessor);
