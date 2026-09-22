/**
 * MIDI Output — sends MIDI messages to external hardware or software.
 */

export class MidiOutput {
  private access: MIDIAccess | null = null;
  private selectedDeviceId: string = "";
  /** Scheduled future sends with their messages — cancelPending() must know
   * WHAT it is cancelling: a pending note-OFF that is silently dropped
   * leaves a stuck note on hardware, while a pending note-ON is a ghost. */
  private pending = new Map<ReturnType<typeof setTimeout>, Uint8Array>();

  async requestAccess(): Promise<boolean> {
    if (typeof navigator === "undefined" || !navigator.requestMIDIAccess) return false;
    try {
      this.access = await navigator.requestMIDIAccess();
      return true;
    } catch {
      return false;
    }
  }

  getOutputs(): Array<{ id: string; name: string; manufacturer: string }> {
    if (!this.access) return [];
    const outputs: Array<{ id: string; name: string; manufacturer: string }> = [];
    this.access.outputs.forEach((output) => {
      outputs.push({ id: output.id, name: output.name ?? "Unknown", manufacturer: output.manufacturer ?? "" });
    });
    return outputs;
  }

  setDevice(deviceId: string): void {
    this.selectedDeviceId = deviceId;
  }

  private getOutput(): MIDIOutput | null {
    if (!this.access) return null;
    if (this.selectedDeviceId) {
      return this.access.outputs.get(this.selectedDeviceId) ?? null;
    }
    // Default: first available output
    let first: MIDIOutput | null = null;
    this.access.outputs.forEach((output) => {
      if (!first) first = output;
    });
    return first;
  }

  send(msg: Uint8Array, delayMs?: number): void {
    const output = this.getOutput();
    if (!output) return;
    // delayMs > 0 schedules the send so notes land on the scheduler's
    // musical timing instead of firing when the 25 ms tick happened to run.
    if (delayMs !== undefined && Number.isFinite(delayMs) && delayMs > 0) {
      const timer = setTimeout(() => {
        this.pending.delete(timer);
        output.send(msg);
      }, delayMs);
      this.pending.set(timer, msg);
      return;
    }
    output.send(msg);
  }

  /**
   * Cancel every future-timed send (Audit 03 D5): the scheduler queues
   * note-ons up to a lookahead ahead, so Stop/Seek left ghost hits firing
   * into hardware at the OLD musical time. Note-offs still flush
   * immediately — a dropped off would leave a stuck note; dropping the
   * unmatched note-ons is exactly the point.
   */
  cancelPending(): void {
    for (const [timer, msg] of this.pending) {
      clearTimeout(timer);
      const status = msg[0] & 0xf0;
      if (status === 0x80) {
        // Pending note-off whose note-on may already have fired — send NOW.
        this.getOutput()?.send(msg);
      }
      // Note-ons (0x90), CCs, clocks: dropped — stale musical time.
    }
    this.pending.clear();
  }

  sendNoteOn(channel: number, note: number, velocity: number, delayMs?: number): void {
    this.send(new Uint8Array([0x90 | (channel & 0x0f), note & 0x7f, velocity & 0x7f]), delayMs);
  }

  sendNoteOff(channel: number, note: number, velocity = 0, delayMs?: number): void {
    this.send(new Uint8Array([0x80 | (channel & 0x0f), note & 0x7f, velocity & 0x7f]), delayMs);
  }

  sendCC(channel: number, cc: number, value: number): void {
    this.send(new Uint8Array([0xb0 | (channel & 0x0f), cc & 0x7f, value & 0x7f]));
  }

  sendPitchBend(channel: number, value: number): void {
    // value: -1..1 → 14-bit 0..16383, center at 8192
    const centered = Math.round((value + 1) * 8192);
    const lsb = centered & 0x7f;
    const msb = (centered >> 7) & 0x7f;
    this.send(new Uint8Array([0xe0 | (channel & 0x0f), lsb, msb]));
  }

  sendProgramChange(channel: number, program: number): void {
    this.send(new Uint8Array([0xc0 | (channel & 0x0f), program & 0x7f]));
  }

  sendClock(): void {
    this.send(new Uint8Array([0xf8]));
  }

  sendStart(): void {
    this.send(new Uint8Array([0xfa]));
  }

  sendContinue(): void {
    this.send(new Uint8Array([0xfb]));
  }

  sendStop(): void {
    this.send(new Uint8Array([0xfc]));
  }

  dispose(): void {
    // Cancel scheduled future sends FIRST — otherwise a note-on queued
    // before teardown could start a hanging note after All Sound Off.
    for (const timer of this.pending.keys()) clearTimeout(timer);
    this.pending.clear();
    // Send all notes off
    for (let ch = 0; ch < 16; ch++) {
      this.sendCC(ch, 123, 0); // All Notes Off
      this.sendCC(ch, 120, 0); // All Sound Off
    }
    this.access = null;
  }
}
