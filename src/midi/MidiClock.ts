import type { Transport } from "../transport/Transport";
import type { MidiOutput } from "./MidiOutput";

const PPQ = 480; // pulses per quarter note (matching project PPQ)
const CLOCKS_PER_BEAT = 24; // MIDI standard

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

  /** Handle incoming clock pulse (slave mode). */
  handleSlavePulse(transport: Transport): void {
    const now = performance.now();
    this.slavePulseCount++;

    // Calculate BPM from pulse interval (24 pulses = 1 beat)
    if (this.slaveLastPulseTime > 0) {
      const intervalMs = now - this.slaveLastPulseTime;
      if (intervalMs > 0) {
        const pulsesPerMs = 1 / intervalMs;
        const beatsPerMs = pulsesPerMs / CLOCKS_PER_BEAT;
        const bpm = beatsPerMs * 60000;
        // Average over 4 beats (96 pulses) for stability
        this.slaveBpmAccum += bpm;
        this.slaveBpmCount++;
        if (this.slaveBpmCount >= CLOCKS_PER_BEAT * 4) {
          const avgBpm = this.slaveBpmAccum / this.slaveBpmCount;
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
    this.slavePulseCount = 0;
    this.slaveLastPulseTime = 0;
    this.slaveBpmAccum = 0;
    this.slaveBpmCount = 0;
    transport.seek(0);
  }

  /** Handle MIDI Continue message (slave mode). */
  handleSlaveContinue(_transport: Transport): void {
    // Continue from current position — no reset
  }

  /** Handle MIDI Stop message (slave mode). */
  handleSlaveStop(_transport: Transport): void {
    this.slaveLastPulseTime = 0;
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
