/**
 * RT Ticker — audio-clock tick source for the scheduler (Wave 3).
 *
 * The scheduler's event planning ran on a 25 ms setInterval: a main-thread
 * timer that inherits every bit of main-thread jank (React render, GC,
 * layout) and browser timer clamping. When a tick lands late, the 120 ms
 * lookahead window erodes and events are scheduled late — audible timing
 * damage during foreground load, exactly when a DAW is busiest.
 *
 * This processor is pulled by the AUDIO DEVICE at render-quantum cadence
 * and posts one message every `intervalBlocks` quanta. The messages are
 * still delivered as main-thread tasks, but the CADENCE and the timestamps
 * come from the audio clock, and a stalled main thread produces a burst of
 * queued messages (which the scheduler absorbs by planning from transport
 * position) instead of a silently-clamped timer.
 *
 * It outputs silence and does no DSP — the node exists so the audio thread
 * keeps pulling it while the context runs.
 *
 * NOTE: this file is served RAW inside core-worklet.js — plain JavaScript,
 * no imports, no TypeScript syntax.
 */
class RtTickerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const blocks = Number(opts.intervalBlocks);
    // 8 quanta ≈ 21.3 ms @48k — cadence comparable to the legacy 25 ms
    // timer, well inside the 120 ms lookahead. Hard floor of 1 block.
    this.intervalBlocks = Number.isFinite(blocks) && blocks >= 1 ? Math.floor(blocks) : 8;
    this.counter = 0;
    this.ticks = 0;
  }

  static get parameterDescriptors() {
    return [];
  }

  process(inputs, outputs) {
    if (++this.counter >= this.intervalBlocks) {
      this.counter = 0;
      this.ticks++;
      // `currentTime` and `quantum` are worklet globals (seconds / 128).
      this.port.postMessage({ type: "tick", time: currentTime, quantum, seq: this.ticks });
    }
    return true;
  }
}

registerProcessor("rt-ticker-processor", RtTickerProcessor);
