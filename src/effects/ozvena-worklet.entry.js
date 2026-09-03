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

const MAX_BLOCK = 128;
const CHANNELS = 2;

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
      let next;
      if (typeof current === "boolean") next = value >= 0.5;
      else if (typeof current === "string" && typeof value === "number") {
        const list = ENUM_BY_PATH[id];
        next = list
          ? list[Math.max(0, Math.min(list.length - 1, Math.round(value)))]
          : String(value);
      } else if (typeof current === "number") {
        next = typeof value === "number" ? value : Number(value);
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
        const now = currentTime;
        if (this.pendingParams.length > 0) {
          this.pendingParams = this.pendingParams.filter(
            (ev) => ev.id !== msg.id || ev.when <= now,
          );
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
    let applied = 0;
    while (q.length > 0 && q[0].when <= horizon) {
      const ev = q.shift();
      this.state = setPath(this.state, ev.id, ev.value);
      applied++;
    }
    if (applied > 0) {
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
    const frames = Math.min(MAX_BLOCK, output[0].length);
    // `currentTime` is the first sample of this quantum; events up to the
    // end of the block are applied now (≤ one quantum early).
    this.applyDueParams(currentTime + frames / sampleRate);
    const input = inputs[0];

    // Ozvena is stereo and requires both channels — stage into scratch
    // (input or silence), process in place, copy back.
    for (let c = 0; c < CHANNELS; c++) {
      const buf = this.scratch[c];
      const inCh = input && input[c];
      if (inCh && inCh.length >= frames) buf.set(inCh.subarray(0, frames));
      else buf.fill(0, 0, frames);
    }
    this.proc.process(this.scratch, frames);
    for (let c = 0; c < CHANNELS; c++) {
      output[c].set(this.scratch[c].subarray(0, frames));
    }
    return true;
  }
}

registerProcessor("ozvena-processor", OzvenaWorkletProcessor);
