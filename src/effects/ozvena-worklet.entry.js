/**
 * Ozvena AudioWorklet entry — bundled by scripts/build-ozvena-worklet.mjs
 * into a single classic-script file (public/ozvena-worklet.js) that the
 * loader feeds to AudioWorklet.addModule().
 *
 * Thin wrapper: all DSP lives in the vendored ozvena-core (parity-checked
 * against upstream fixtures, see tests/ozvena-golden.test.ts). The wrapper
 * owns block copying, dotted-path state updates and latency reporting.
 */
import { createOzvenaProcessor } from "./ozvena-core/core/ozvenaProcessor.ts";
import { defaultOzvenaStateV1 } from "./ozvena-core/v2/types.ts";
import { capUserIrFrames } from "./ozvena-params.ts";
import { validatePrecomputedIrSet } from "./ozvena-core/dsp/fftPartitioned.ts";

const MAX_BLOCK = 128;
const CHANNELS = 2;

/** Factory IR ids accepted by the off-thread provider (the keys of the
 *  upstream IR_SPECS/IR4_SPECS catalogues — hardcoded here like
 *  ENUM_BY_PATH; anything else clears the convolution instead of looping
 *  an async request). */
const FACTORY_IR_IDS = new Set([
  "vocal-booth",
  "plate",
  "hall",
  "cathedral",
  "plate-wide",
  "chamber-wide",
]);

/** Validate a delivered precomputed-sets payload against the IR length
 *  cap; returns the checked array or null. */
function checkedIrSets(rawSets, sampleRate) {
  if (!Array.isArray(rawSets) || rawSets.length === 0) return null;
  const frames = rawSets[0]?.irLengthSamples;
  if (!(frames > 0) || frames !== capUserIrFrames(frames, sampleRate)) return null;
  const sets = rawSets.map(validatePrecomputedIrSet);
  if (sets.some((s) => s === null)) return null;
  return sets;
}

/** Numeric-index → string-enum mapping, keyed by full dotted path. The UI
 *  ships enums as indices; the DSP state carries them as strings. Keying by
 *  full path (not leaf name) keeps e.g. engines.e3.algo inside its own
 *  largeChamber/hall list — an E2 index would produce an invalid E3 algo
 *  that throws inside the engine's recompute(). */
const ENUM_BY_PATH = {
  "engines.e2.algo": ["room", "mediumChamber", "plate"],
  "engines.e3.algo": ["largeChamber", "hall"],
  "blendPad.engine2Algo": ["room", "mediumChamber", "plate"],
  "mod.mode": ["randomFat", "pitch"],
  "convolution.mode": ["algorithmic", "hybrid", "convolution"],
  "global.quality": ["eco", "standard", "high", "render"],
};

/**
 * Return a NEW state with `id` (dotted path) set to `value`, cloning only
 * the objects along the path (structural sharing). The vendored processor
 * detects changes by section REFERENCE (pushStateToModules compares
 * `state.preDelay !== prev.preDelay` etc.), so mutating the state in place
 * makes loadState(sameRef) a silent no-op — every section-based param
 * (engine time, EQ bands, pre-delay, mod…) would be dropped. Params must
 * land as fresh section objects. The current value's type is preserved:
 * booleans via >= 0.5, enum paths via index, numbers coerced.
 */
function setPath(state, id, value) {
  const parts = id.split(".");
  const write = (node, depth) => {
    if (depth === parts.length - 1) {
      const key = parts[depth];
      const current = node[key];
      // Boundary validation: a non-finite numeric value (or a missing one)
      // must never enter DSP state. NaN gains poison the wet bus (the
      // output limiter does not reject them), and an enum index of NaN
      // yields `list[NaN] === undefined`, which THROWS inside the engine's
      // recompute() — on the real audio thread that kills the processor.
      // Drop the update and keep the last valid value instead.
      if (typeof value === "number" && !Number.isFinite(value)) return node;
      if (value === undefined || value === null) return node;
      let next;
      if (typeof current === "boolean") next = value >= 0.5;
      else if (typeof current === "string" && typeof value === "number") {
        const list = ENUM_BY_PATH[id];
        if (list) {
          next = list[Math.max(0, Math.min(list.length - 1, Math.round(value)))];
        } else {
          // A numeric update to a NON-enum string leaf (e.g. a corrupt
          // document writing preDelay.syncNote = 1e9) must be dropped —
          // String(value) coercion used to install garbage like "1000000000"
          // as the sync note. String leaves are set with string payloads.
          return node;
        }
      } else if (typeof current === "number") {
        next = typeof value === "number" ? value : Number(value);
        // Coerced garbage (Number("abc") → NaN) is dropped like NaN above.
        if (!Number.isFinite(next)) return node;
      } else {
        next = value;
      }
      if (next === current) return node;
      return { ...node, [key]: next };
    }
    const child = node[parts[depth]];
    if (!child || typeof child !== "object") return node;
    const updated = write(child, depth + 1);
    if (updated === child) return node;
    return { ...node, [parts[depth]]: updated };
  };
  return write(state, 0);
}

class OzvenaWorkletProcessor extends AudioWorkletProcessor {
  proc = createOzvenaProcessor();
  state = defaultOzvenaStateV1();
  scratch = [new Float32Array(MAX_BLOCK), new Float32Array(MAX_BLOCK)];
  lastLatencyPosted = -1;
  blockCount = 0;
  disposed = false;
  // Time-stamped parameter events (setParameterAt — automation lanes and
  // offline renders), sorted ascending by `when`. Applied from process()
  // when the render clock reaches them — port messages alone have no
  // timing, so without this queue an offline export would hear every
  // automation point at the moment it was POSTED, not at its project time.
  pendingParams = [];

  constructor(options) {
    super();
    // Factory-IR generation moves OFF the audio thread: generating an IR
    // (noise + envelope over up to 3 s × 4 channels) inside the port
    // handler — which runs on the audio rendering thread — was a
    // few-millisecond dropout on the first selection of every (IR, rate).
    // The provider answers from cache, asks the main thread otherwise, and
    // the core keeps the current IR audible until the payload lands.
    this.pendingIrRequests = new Set();
    this.proc.setFactoryIrProvider((irId, sr) => {
      if (!FACTORY_IR_IDS.has(irId)) return null;
      // Every delivery must contain a fresh mutable input-spectrum ring. A
      // worklet-scope cache can safely share immutable IR spectra, but cannot
      // share blockSpectra between convolver instances or reloads. Ask the
      // main thread for a new transferable payload on every cache hit; its
      // immutable spectra template avoids repeating the expensive FFT batch.
      const requestKey = `${irId}:${sr}`;
      if (!this.pendingIrRequests.has(requestKey)) {
        this.pendingIrRequests.add(requestKey);
        this.port.postMessage({ type: "irNeeded", irId, sampleRate: sr });
      }
      return "pending";
    });
    const bpmRaw = Number(options?.processorOptions?.bpm);
    const bpm = Number.isFinite(bpmRaw) ? Math.min(300, Math.max(20, bpmRaw)) : 120;
    this.proc.prepare(sampleRate, CHANNELS, bpm, MAX_BLOCK);
    const initial = options?.processorOptions?.params;
    if (initial) {
      for (const [id, value] of Object.entries(initial)) this.state = setPath(this.state, id, value);
    }
    // Always load (even without processorOptions) — a null state makes the
    // core's process() return silently, i.e. a muted effect.
    this.proc.loadState(this.state);
    // Pulse Forge consumes no spectrum/AutoCut/Unmask/masking taps — skip
    // the nine per-block analyzer ring writes (≈10–20 µs + cache pressure).
    // Upstream hosts simply never call this; taps stay live by default.
    this.proc.setAnalyzersEnabled(false);
    this.postLatency();
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === "param") {
        // A manual value cancels still-pending automation for the same
        // parameter (user touch overrides the future), matching how the
        // engine treats AudioParam.cancelScheduledValues on takeover.
        // Compact the queue IN PLACE — Array#filter allocates a fresh array
        // on the render thread for every knob move.
        const now = currentTime;
        const q = this.pendingParams;
        if (q.length > 0) {
          let w = 0;
          for (let i = 0; i < q.length; i++) {
            const ev = q[i];
            if (ev.id !== msg.id || ev.when <= now) q[w++] = ev;
          }
          q.length = w;
        }
        this.state = setPath(this.state, msg.id, msg.value);
        this.proc.loadState(this.state);
        this.postLatency();
      } else if (msg.type === "paramAt") {
        const when = Number(msg.when);
        if (!Number.isFinite(when)) {
          // Defensive: a malformed timestamp degrades to an immediate set.
          this.state = setPath(this.state, msg.id, msg.value);
          this.proc.loadState(this.state);
          this.postLatency();
          return;
        }
        // Keep the queue sorted ascending by `when`; events usually arrive
        // in order, so scan back from the end.
        const q = this.pendingParams;
        let i = q.length;
        while (i > 0 && q[i - 1].when > when) i--;
        q.splice(i, 0, { id: msg.id, value: msg.value, when });
      } else if (msg.type === "loadIr") {
        // Roadmap O7: user IR. Preferred payload: PRECOMPUTED frequency-
        // domain partitions (the FFT batch ran on the MAIN thread — the
        // inline batch was a 2–8 ms audio-thread stall per load). Legacy
        // shape: interleaved samples at the host rate, re-clamped here.
        // (Reconciled from Pulse Forge hardening audit, 2026-09-09.)
        const channels = msg.channels === 4 ? 4 : msg.channels === 2 ? 2 : 1;
        const sets = checkedIrSets(msg.sets, sampleRate);
        if (sets) {
          this.proc.loadPrecomputedIr(sets, channels);
          this.postLatency();
          return;
        }
        const frames = capUserIrFrames(
          (msg.samples?.length ?? 0) / channels,
          sampleRate,
        );
        if (msg.samples && frames > 0) {
          this.proc.loadUserIr(msg.samples.subarray(0, frames * channels), channels);
          this.postLatency();
        }
      } else if (msg.type === "factoryIr") {
        // Main-thread generation reply (see the provider in the
        // constructor). Preferred payload: PRECOMPUTED frequency-domain
        // partitions — the per-partition FFT batch ran on the MAIN thread,
        // so arming the convolver here does no FFT work and no large
        // allocation (the old inline batch was a 2–8 ms audio-thread stall
        // on the first selection of every IR). Malformed payloads are
        // dropped — the selection stays "pending" and a later convolution
        // change re-requests.
        this.pendingIrRequests.delete(`${msg.irId}:${sampleRate}`);
        const channels = msg.channels === 4 ? 4 : msg.channels === 2 ? 2 : 1;
        const sets = checkedIrSets(msg.sets, sampleRate);
        if (sets) {
          // Load only if the selection still points here. Stale replies are
          // deliberately not cached in the worklet: the next selection must
          // receive a fresh mutable blockSpectra ring from the main thread.
          if (this.state.convolution?.irId === msg.irId) {
            this.proc.loadPrecomputedIr(sets, channels);
            this.postLatency();
          }
          return;
        }
        // Legacy time-domain payload (direct hosts, tests): interleaved
        // samples at the host rate. The convolver's FFT batch runs here —
        // acceptable only as a compatibility path.
        const samples = msg.samples;
        if (!(samples instanceof Float32Array) || samples.length === 0) return;
        if (channels > 1 && samples.length % channels !== 0) return;
        if (this.state.convolution?.irId === msg.irId) {
          this.proc.loadUserIr(samples, channels);
          this.postLatency();
        }
      } else if (msg.type === "clearIr") {
        this.proc.clearUserIr();
        this.postLatency();
      } else if (msg.type === "bpm") {
        // Live tempo changes must reach the tempo-synced pre-delay — the
        // core clamps to 20..300 itself.
        const bpm = Number(msg.bpm);
        if (Number.isFinite(bpm)) this.proc.setBpm(bpm);
      } else if (msg.type === "reset") {
        this.pendingParams.length = 0;
        this.state = defaultOzvenaStateV1();
        this.proc.loadState(this.state);
        this.proc.reset();
        this.pendingIrRequests.clear();
      } else if (msg.type === "dispose") {
        // Terminal teardown from the main thread (node.dispose): release
        // the module-global IPC peer registry entry + subscription that
        // would otherwise pin this processor (and its delay buffers)
        // forever. dispose() also unprepares the core, so audio stops.
        this.proc.dispose();
        this.disposed = true;
      }
    };
  }

  /** Apply every queued event whose project time has arrived (the render
   *  clock granularity is one 128-frame quantum ≈ 2.7 ms). */
  applyDueParams(horizon) {
    const q = this.pendingParams;
    if (q.length === 0 || q[0].when > horizon) return;
    // Consume the due PREFIX by index and compact in place — shift() is
    // O(n) per event, which made dense automation queues O(n²) per block.
    let applied = 0;
    while (applied < q.length && q[applied].when <= horizon) {
      this.state = setPath(this.state, q[applied].id, q[applied].value);
      applied++;
    }
    if (applied > 0) {
      const remaining = q.length - applied;
      for (let j = 0; j < remaining; j++) q[j] = q[j + applied];
      q.length = remaining;
      this.proc.loadState(this.state);
      this.postLatency();
    }
  }

  postLatency() {
    const samples = this.proc.getLatencySamples();
    if (samples !== this.lastLatencyPosted) {
      this.lastLatencyPosted = samples;
      this.port.postMessage({ type: "latency", samples });
    }
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const output = outputs[0];
    if (!output || !output[0] || !output[1]) return true;
    const total = output[0].length;
    // `currentTime` is the first sample of this quantum; events up to the
    // end of the block are applied now (≤ one quantum early).
    this.applyDueParams(currentTime + total / sampleRate);
    const input = inputs[0];

    // Ozvena is stereo and requires both channels — stage into scratch
    // (input or silence), process in 128-frame chunks, copy back. The render
    // quantum is 128 everywhere today, but the spec allows larger buffers;
    // a single pass would leave samples beyond frame 128 stale (the previous
    // block's audio repeated) exactly like the Ultina entry's fixed bug.
    for (let offset = 0; offset < total; offset += MAX_BLOCK) {
      const frames = Math.min(MAX_BLOCK, total - offset);
      for (let c = 0; c < CHANNELS; c++) {
        const buf = this.scratch[c];
        const inCh = input && input[c];
        if (inCh && inCh.length >= offset + frames) {
          buf.set(inCh.subarray(offset, offset + frames));
        } else if (inCh && inCh.length >= frames) {
          buf.set(inCh.subarray(0, frames));
        } else {
          buf.fill(0, 0, frames);
        }
      }
      this.proc.process(this.scratch, frames);
      for (let c = 0; c < CHANNELS; c++) {
        output[c].set(this.scratch[c].subarray(0, frames), offset);
      }
    }
    return true;
  }
}

registerProcessor("ozvena-processor", OzvenaWorkletProcessor);
