/**
 * MIDI Output — sends MIDI messages to external hardware or software.
 */

export class MidiOutput {
  private access: MIDIAccess | null = null;
  private selectedDeviceId: string = "";
  /** Scheduled future sends — cleared on dispose so a closed project cannot
   * fire ghost notes into hardware afterwards. */
  private pending = new Set<ReturnType<typeof setTimeout>>();

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
      this.pending.add(timer);
      return;
    }
    output.send(msg);
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
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
    // Send all notes off
    for (let ch = 0; ch < 16; ch++) {
      this.sendCC(ch, 123, 0); // All Notes Off
      this.sendCC(ch, 120, 0); // All Sound Off
    }
    this.access = null;
  }
}
