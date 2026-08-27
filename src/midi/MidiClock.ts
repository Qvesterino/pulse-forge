import type { Transport } from "../transport/Transport";
import type { MidiOutput } from "./MidiOutput";
import { MAX_BPM, MIN_BPM } from "../project-model/schema";

const PPQ = 480; // pulses per quarter note (matching project PPQ)
const CLOCKS_PER_BEAT = 24; // MIDI standard
/** Pulse intervals outside this window are timing noise, not a musical clock. */
const MIN_PULSE_INTERVAL_MS = 5;
const MAX_PULSE_INTERVAL_MS = 2000;

/**
 * MIDI Clock — handles sending and receiving MIDI timing messages.
 * Master mode: sends 24 PPQN clock pulses to external devices.
 * Slave mode: receives clock pulses and drives the internal transport.
 */
export class MidiClock {
  private timer: ReturnType<typeof setInterval> | null = null;
  private transport: Transport | null = null;
  private output: MidiOutput | null = null;
  private slavePulseCount = 0;
  private slaveLastPulseTime = 0;
  private slaveBpmAccum = 0;
  private slaveBpmCount = 0;

  /** Start sending MIDI clock (master mode). */
  startMaster(transport: Transport, output: MidiOutput): void {
    this.stopMaster();
    this.transport = transport;
    this.output = output;

    output.sendStart();

    // 24 pulses per quarter note — interval recalculated on tempo change
    this.recalcInterval();
  }

  /** Stop sending MIDI clock. */
  stopMaster(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.output?.sendStop();
    this.transport = null;
    this.output = null;
  }

  /** Update tempo while clock is running. */
  setTempo(bpm: number): void {
    if (this.timer !== null) {
      this.recalcInterval(bpm);
    }
  }

  /** Reset slave-derived tempo tracking (call when the stream stalls). */
  private resetSlaveTracking(): void {
    this.slaveLastPulseTime = 0;
    this.slaveBpmAccum = 0;
    this.slaveBpmCount = 0;
  }

  /** Handle incoming clock pulse (slave mode). */
  handleSlavePulse(transport: Transport): void {
    // External gear streams 0xF8 clocks whenever ITS transport runs. Pulses
    // must never move OUR playhead while ours is stopped — otherwise the
    // position creeps forward and Play resumes from a random spot.
    if (!transport.playing) {
      this.resetSlaveTracking();
      return;
    }
    const now = performance.now();
    this.slavePulseCount++;

    // Calculate BPM from pulse interval (24 pulses = 1 beat)
    if (this.slaveLastPulseTime > 0) {
      const intervalMs = now - this.slaveLastPulseTime;
      if (intervalMs < MIN_PULSE_INTERVAL_MS || intervalMs > MAX_PULSE_INTERVAL_MS) {
        // A gap or burst (device paused, cable pull, timer hiccup): discard the
        // whole measurement window instead of letting one outlier drag the
        // average toward 0 (or thousands) and wrenching the tempo.
        this.slaveBpmAccum = 0;
        this.slaveBpmCount = 0;
      } else {
        const pulsesPerMs = 1 / intervalMs;
        const beatsPerMs = pulsesPerMs / CLOCKS_PER_BEAT;
        const bpm = beatsPerMs * 60000;
        // Average over 4 beats (96 pulses) for stability
        this.slaveBpmAccum += bpm;
        this.slaveBpmCount++;
        if (this.slaveBpmCount >= CLOCKS_PER_BEAT * 4) {
          const avgBpm = Math.min(MAX_BPM, Math.max(MIN_BPM, this.slaveBpmAccum / this.slaveBpmCount));
          transport.setBpm(Math.round(avgBpm * 10) / 10);
          this.slaveBpmAccum = 0;
          this.slaveBpmCount = 0;
        }
      }
    }
    this.slaveLastPulseTime = now;

    // Advance transport by one pulse
    const ticksPerPulse = PPQ / CLOCKS_PER_BEAT;
    transport.seek(transport.position + ticksPerPulse);
  }

  /** Handle MIDI Start message (slave mode). */
  handleSlaveStart(transport: Transport): void {
    this.resetSlaveTracking();
    if (!transport.playing) return;
    transport.seek(0);
  }

  /** Handle MIDI Continue message (slave mode). */
  handleSlaveContinue(_transport: Transport): void {
    // Continue from current position — no reset
  }

  /** Handle MIDI Stop message (slave mode). */
  handleSlaveStop(_transport: Transport): void {
    this.resetSlaveTracking();
  }

  dispose(): void {
    this.stopMaster();
  }

  private recalcInterval(bpm?: number): void {
    if (this.timer !== null) clearInterval(this.timer);
    const currentBpm = bpm ?? this.transport?.bpm ?? 120;
    const msPerPulse = 60000 / (currentBpm * CLOCKS_PER_BEAT);
    this.timer = setInterval(() => {
      this.output?.sendClock();
    }, msPerPulse);
  }
}
