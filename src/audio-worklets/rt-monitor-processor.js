/**
 * RT Monitor — audio-thread load / xrun probe (release-gate hardening).
 *
 * A 0-output sink processor fed from the post-limiter master bus. It exists
 * so the audio thread keeps pulling it every render quantum; each quantum it
 * measures the WALL time the callback took and the wall gap between
 * consecutive callbacks, then posts a summary over the port.
 *
 * What it can honestly measure:
 *   - blockMs: wall time spent inside process() for one quantum. The audio
 *     budget is 128/sampleRate ms (≈2.9 ms at 44.1 kHz); a sustained average
 *     above that means the thread cannot keep up.
 *   - callGapMs: wall time between the END of one callback and the START of
 *     the next. Under healthy operation this is near zero (the thread sleeps
 *     between quanta). A gap well above the quantum duration means quanta
 *     were dropped — the closest in-process proxy for a device xrun.
 *   - xruns: count of callbacks whose gap exceeded 2× the quantum.
 *
 * `performance.now()` is not in the AudioWorklet minimal scope but is exposed
 * by Chrome and Firefox; where it is missing the processor reports
 * `available: false` instead of fabricating numbers.
 *
 * NOTE: served RAW inside core-worklet.js — plain JavaScript, no imports.
 */
class RtMonitorProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const reportEvery = Number(opts.reportEveryBlocks);
    this.reportEvery = Number.isFinite(reportEvery) && reportEvery >= 1 ? Math.floor(reportEvery) : 64;
    this.quantumMs = (128 / (globalThis.sampleRate || 48000)) * 1000;
    this.available = typeof performance !== "undefined" && typeof performance.now === "function";
    this.blocks = 0;
    this.xruns = 0;
    this.maxBlockMs = 0;
    this.sumBlockMs = 0;
    this.maxGapMs = 0;
    this.lastCallEnd = 0;
  }

  static get parameterDescriptors() {
    return [];
  }

  post(reset) {
    this.port.postMessage({
      type: "rt",
      available: this.available,
      blocks: this.blocks,
      xruns: this.xruns,
      maxBlockMs: this.available ? this.maxBlockMs : 0,
      avgBlockMs: this.available && this.blocks > 0 ? this.sumBlockMs / this.blocks : 0,
      maxGapMs: this.available ? this.maxGapMs : 0,
      quantumMs: this.quantumMs,
    });
    if (reset) {
      this.blocks = 0;
      this.xruns = 0;
      this.maxBlockMs = 0;
      this.sumBlockMs = 0;
      this.maxGapMs = 0;
    }
  }

  process(_inputs, _outputs) {
    let start = 0;
    if (this.available) {
      start = performance.now();
      if (this.lastCallEnd > 0) {
        const gap = start - this.lastCallEnd;
        if (gap > this.maxGapMs) this.maxGapMs = gap;
        if (gap > this.quantumMs * 2) this.xruns++;
      }
    }
    // Sink processor: no audio work to do. Expose the probe as a no-op input
    // drain so the graph keeps the node on the critical path.
    this.blocks++;
    if (this.blocks % this.reportEvery === 0) this.post(false);
    if (this.available) {
      const end = performance.now();
      const blockMs = end - start;
      if (blockMs > this.maxBlockMs) this.maxBlockMs = blockMs;
      this.sumBlockMs += blockMs;
      this.lastCallEnd = end;
    }
    return true;
  }
}

registerProcessor("rt-monitor-processor", RtMonitorProcessor);
