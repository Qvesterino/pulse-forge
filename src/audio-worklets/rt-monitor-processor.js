/**
 * RT Monitor — audio-thread load / xrun probe (release-gate hardening).
 *
 * A 0-output sink processor fed from the post-limiter master bus. It exists
 * so the audio thread keeps pulling it every render quantum. It does NOT try
 * to measure its own wall time: `AudioWorkletGlobalScope` has no `performance`
 * (verified: headless Chromium reports `performance` undefined on the audio
 * thread), so an in-worklet CPU measurement is not portable.
 *
 * What the audio thread CAN report portably is the AUDIO CLOCK
 * (`currentFrame`/`currentTime`). A healthy render advances exactly one render
 * quantum per callback, so:
 *   - `currentFrame` jumping by more than 128 frames means the audio device
 *     dropped quanta — the platform's only observable xrun signal;
 *   - the frame counter is forwarded with a heartbeat so the MAIN thread can
 *     measure delivery jitter, which is the host-visible symptom of an
 *     overloaded graph (the audio thread stops meeting its deadline and the
 *     heartbeat arrives late / in bursts).
 *
 * Both numbers are honest: quanta actually dropped, and heartbeat jitter.
 * Protocol (port): `{ type: "rt", blocks, frames, droppedQuanta, gapFrames }`
 * every `reportEveryBlocks` quanta.
 */
class RtMonitorProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const reportEvery = Number(opts.reportEveryBlocks);
    this.reportEvery = Number.isFinite(reportEvery) && reportEvery >= 1 ? Math.floor(reportEvery) : 64;
    this.sr = globalThis.sampleRate || 48000;
    this.quantumMs = (128 / this.sr) * 1000;
    this.blocks = 0;
    this.droppedQuanta = 0;
    this.lastFrame = null;
  }

  static get parameterDescriptors() {
    return [];
  }

  process(_inputs, _outputs) {
    const frame = currentFrame;
    if (this.lastFrame !== null) {
      const advanced = frame - this.lastFrame;
      // Audio-thread underrun / device drop: the clock advanced by more than
      // the render quantum. Anything past one extra quantum is a dropped block.
      if (advanced > 128) this.droppedQuanta += Math.round(advanced / 128) - 1;
    }
    this.lastFrame = frame;
    this.blocks++;
    if (this.blocks % this.reportEvery === 0) {
      this.port.postMessage({
        type: "rt",
        blocks: this.blocks,
        sampleRate: this.sr,
        quantumMs: this.quantumMs,
        droppedQuanta: this.droppedQuanta,
        audioTime: currentTime,
      });
    }
    return true;
  }
}

registerProcessor("rt-monitor-processor", RtMonitorProcessor);
