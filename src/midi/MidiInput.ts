import type { AudioEngine } from "../audio-engine/AudioEngine";
import type { ProjectStore } from "../store/ProjectStore";
import type { Transport } from "../transport/Transport";
import type { DrumTrack, MidiConfig, ProjectDocument } from "../project-model/types";
import { GM_DRUM_MAP } from "../project-model/types";

export interface MidiDevice {
  id: string;
  name: string;
  manufacturer: string;
}

type DeviceChangeCallback = (devices: MidiDevice[]) => void;

/**
 * Web MIDI input handler. Parses MIDI messages and routes notes, CC, and
 * pitch bend to the audio engine and project store.
 */
export class MidiInput {
  private access: MIDIAccess | null = null;
  private listeners = new Map<MIDIInput, (e: MIDIMessageEvent) => void>();
  private deviceChangeCb: DeviceChangeCallback | null = null;
  private configCb: (() => MidiConfig) | null = null;
  private getDoc: (() => ProjectDocument) | null = null;

  private engine: AudioEngine | null = null;
  private store: ProjectStore | null = null;
  private transport: Transport | null = null;

  async requestAccess(): Promise<boolean> {
    if (typeof navigator === "undefined" || !navigator.requestMIDIAccess) return false;
    try {
      this.access = await navigator.requestMIDIAccess();
      return true;
    } catch {
      return false;
    }
  }

  getDevices(): MidiDevice[] {
    if (!this.access) return [];
    const devices: MidiDevice[] = [];
    this.access.inputs.forEach((input) => {
      devices.push({ id: input.id, name: input.name ?? "Unknown", manufacturer: input.manufacturer ?? "" });
    });
    return devices;
  }

  start(
    engine: AudioEngine,
    store: ProjectStore,
    transport: Transport,
    getConfig: () => MidiConfig,
    getDoc: () => ProjectDocument,
    onDeviceChange?: DeviceChangeCallback,
  ): void {
    if (!this.access) return;
    this.engine = engine;
    this.store = store;
    this.transport = transport;
    this.configCb = getConfig;
    this.getDoc = getDoc;
    this.deviceChangeCb = onDeviceChange ?? null;

    for (const [, input] of this.access.inputs) {
      this.connectInput(input);
    }
    this.access.onstatechange = () => {
      this.reconnectAll();
      this.deviceChangeCb?.(this.getDevices());
    };
    this.deviceChangeCb?.(this.getDevices());
  }

  stop(): void {
    for (const [input, handler] of this.listeners) {
      input.removeEventListener("midimessage", handler);
    }
    this.listeners.clear();
    if (this.access) this.access.onstatechange = null;
    this.engine = null;
    this.store = null;
    this.transport = null;
    this.configCb = null;
    this.getDoc = null;
    this.deviceChangeCb = null;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private connectInput(input: MIDIInput): void {
    if (this.listeners.has(input)) return;
    const handler = (e: MIDIMessageEvent) => this.onMidiMessage(e);
    input.addEventListener("midimessage", handler);
    this.listeners.set(input, handler);
  }

  private reconnectAll(): void {
    if (!this.access) return;
    // Disconnect removed inputs
    for (const [input] of this.listeners) {
      if (!this.access.inputs.has(input.id)) {
        input.removeEventListener("midimessage", this.listeners.get(input)!);
        this.listeners.delete(input);
      }
    }
    // Connect new inputs
    for (const [, input] of this.access.inputs) {
      this.connectInput(input);
    }
  }

  private onMidiMessage(e: MIDIMessageEvent): void {
    const data = e.data;
    if (!data || data.length < 3) return;
    const config = this.configCb?.();
    if (!config?.enabled) return;

    const status = data[0] & 0xf0;
    const channel = (data[0] & 0x0f) + 1; // 1-16

    switch (status) {
      case 0x90: // Note On
        this.handleNoteOn(data[1], data[2], channel, config);
        break;
      case 0x80: // Note Off
        this.handleNoteOff(data[1], channel, config);
        break;
      case 0xb0: // CC
        this.handleCC(data[1], data[2], channel, config);
        break;
      case 0xe0: // Pitch Bend
        this.handlePitchBend(data[1], data[2], channel, config);
        break;
    }
  }

  private handleNoteOn(note: number, velocity: number, channel: number, config: MidiConfig): void {
    if (velocity === 0) {
      this.handleNoteOff(note, channel, config);
      return;
    }
    const doc = this.getDoc?.();
    if (!doc || !this.engine || !this.transport) return;
    const normVelocity = velocity / 127;
    const when = this.engine.currentTime + 0.005;

    // Drum tracks — check channel filter
    if (config.drumChannel === 0 || channel === config.drumChannel) {
      const drumTrack = doc.tracks.find((t): t is DrumTrack => t.kind === "drum");
      if (drumTrack) {
        // Custom note map first, then GM default
        const customPad = config.drumNoteMap.find((m) => m.midiNote === note);
        if (customPad) {
          const pad = drumTrack.pads.find((p) => p.id === customPad.padId);
          if (pad) {
            this.engine.trigger(drumTrack.id, pad, when, normVelocity);
            return;
          }
        }
        // GM drum map fallback: map note to pad by index
        const gmIndex = GM_DRUM_MAP.findIndex((m) => m.note === note);
        if (gmIndex >= 0 && gmIndex < drumTrack.pads.length) {
          this.engine.trigger(drumTrack.id, drumTrack.pads[gmIndex], when, normVelocity);
          return;
        }
      }
    }

    // Instrument tracks — check channel filter
    if (config.instrumentChannel === 0 || channel === config.instrumentChannel) {
      const instTrack = doc.tracks.find((t) => t.kind === "instrument");
      if (instTrack) {
        this.engine.noteOn(instTrack.id, note, normVelocity, when, 0.5);
      }
    }
  }

  private handleNoteOff(_note: number, _channel: number, _config: MidiConfig): void {
    // For now, note off is a no-op — instruments handle voice lifecycle internally
    // via envelope release. Full note-off routing would require per-voice tracking.
  }

  private handleCC(cc: number, value: number, channel: number, config: MidiConfig): void {
    const doc = this.getDoc?.();
    if (!doc || !this.store || !this.engine) return;

    // Check CC mappings
    for (const mapping of config.ccMappings) {
      if (mapping.ccNumber !== cc) continue;
      if (mapping.channel !== undefined && mapping.channel !== channel) continue;

      const normalized = value / 127;
      const targetValue = mapping.min + normalized * (mapping.max - mapping.min);
      this.engine.applyMidiCc(mapping.target, targetValue);
    }

    // Check macro source:midiCC mappings
    for (const macro of doc.macros) {
      for (const m of macro.mappings) {
        if (m.source !== "midiCC" || m.ccNumber !== cc) continue;
        if (m.channel !== undefined && m.channel !== channel) continue;
        const normalized = value / 127;
        this.store.execute(this.setMacroValueCmd(doc, macro.id, normalized));
      }
    }
  }

  private handlePitchBend(lsb: number, msb: number, _channel: number, config: MidiConfig): void {
    const doc = this.getDoc?.();
    if (!doc || !this.engine) return;

    // 14-bit value: 0..16383, center at 8192
    const raw = (msb << 7) | lsb;
    const centered = (raw - 8192) / 8192; // -1..1
    const semitones = centered * config.pitchBendRange;

    // Apply to the first instrument track for now
    const instTrack = doc.tracks.find((t) => t.kind === "instrument");
    if (instTrack) {
      this.engine.setMidiPitchBend(instTrack.id, semitones);
    }
  }

  // Lightweight command builder (avoids circular import from commands.ts)
  private setMacroValueCmd(_doc: ProjectDocument, macroId: string, value: number) {
    const clamped = Math.max(0, Math.min(1, value));
    return {
      type: "setMacroValue",
      label: "MIDI CC",
      execute: (d: ProjectDocument) => ({
        ...d,
        macros: d.macros.map((m) => (m.id === macroId ? { ...m, value: clamped } : m)),
      }),
      undo: (d: ProjectDocument) => d,
    };
  }
}
