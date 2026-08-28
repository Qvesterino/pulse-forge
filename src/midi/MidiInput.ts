import type { AudioEngine } from "../audio-engine/AudioEngine";
import type { Command } from "../commands/types";
import type { Transport } from "../transport/Transport";
import type { DrumTrack, MidiConfig, ProjectDocument } from "../project-model/types";
import { GM_DRUM_MAP } from "../project-model/types";

/** Store surface MidiInput needs — implemented by ProjectStore and YDocStore. */
export interface MidiStoreSurface {
  execute(command: Command): void;
}

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
  private deviceListeners = new Set<DeviceChangeCallback>();
  private configCb: (() => MidiConfig) | null = null;
  private getDoc: (() => ProjectDocument) | null = null;
  private clockPulseCb: (() => void) | null = null;
  private clockStartCb: (() => void) | null = null;
  private clockContinueCb: (() => void) | null = null;
  private clockStopCb: (() => void) | null = null;

  private engine: AudioEngine | null = null;
  private store: MidiStoreSurface | null = null;
  private transport: Transport | null = null;
  /** Last channel voice status byte (running status support). */
  private runningStatus: number | null = null;

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

  /**
   * Subscribe to device-list changes (plug/unplug, permission granted).
   * UI consumers use this to stay in sync — reading getDevices() once at
   * render time went stale until the next unrelated re-render.
   */
  subscribeDevices(listener: DeviceChangeCallback): () => void {
    this.deviceListeners.add(listener);
    return () => {
      this.deviceListeners.delete(listener);
    };
  }

  private notifyDevices(): void {
    const devices = this.getDevices();
    this.deviceChangeCb?.(devices);
    for (const listener of this.deviceListeners) listener(devices);
  }

  start(
    engine: AudioEngine,
    store: MidiStoreSurface,
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
      this.notifyDevices();
    };
    this.notifyDevices();
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
    this.runningStatus = null;
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
    if (!data || data.length < 1) return;
    const config = this.configCb?.();
    if (!config?.enabled) return;

    // System realtime messages are single-byte and would be masked to 0xf0
    // by the status nibble below — dispatch them on the raw byte first.
    switch (data[0]) {
      case 0xf8: // MIDI Clock
        this.handleClock(config);
        return;
      case 0xfa: // Start
        this.handleClockStart(config);
        return;
      case 0xfb: // Continue
        this.handleClockContinue(config);
        return;
      case 0xfc: // Stop
        this.handleClockStop(config);
        return;
    }

    // Running status: a message starting with a DATA byte (< 0x80) reuses the
    // last channel-voice status byte — without this, chord tails from such
    // keyboards were silently dropped.
    let payload = data;
    if (data[0] < 0x80) {
      if (this.runningStatus === null) return;
      const merged = new Uint8Array(data.length + 1);
      merged[0] = this.runningStatus;
      merged.set(data, 1);
      payload = merged;
    }

    const status = payload[0] & 0xf0;
    const channel = (payload[0] & 0x0f) + 1; // 1-16
    // Program Change and Channel Pressure are 2-byte messages, the rest are 3.
    const minLen = status === 0xc0 || status === 0xd0 ? 2 : 3;
    if (payload.length < minLen) return;
    // Channel voice messages carry running status: many keyboards send the
    // status byte once and then bare [note, velocity] pairs for the rest of
    // a chord. Remember it — and clear it on System Common, per spec.
    if (payload[0] >= 0x80 && payload[0] < 0xf0) {
      this.runningStatus = payload[0];
    } else if (payload[0] >= 0xf0 && payload[0] < 0xf8) {
      this.runningStatus = null;
    }

    switch (status) {
      case 0x90: // Note On
        this.handleNoteOn(payload[1], payload[2], channel, config);
        break;
      case 0x80: // Note Off
        this.handleNoteOff(payload[1], channel, config);
        break;
      case 0xb0: // CC
        this.handleCC(payload[1], payload[2], channel, config);
        break;
      case 0xe0: // Pitch Bend
        this.handlePitchBend(payload[1], payload[2], channel, config);
        break;
      case 0xc0: // Program Change
        this.handleProgramChange(payload[1], channel, config);
        break;
      case 0xd0: // Channel Pressure (Aftertouch)
        this.handleChannelPressure(payload[1], channel, config);
        break;
      case 0xa0: // Polyphonic Aftertouch
        this.handlePolyPressure(payload[1], payload[2], channel, config);
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

  // ---------------------------------------------------------------------------
  // Program Change
  // ---------------------------------------------------------------------------

  private handleProgramChange(program: number, channel: number, config: MidiConfig): void {
    const doc = this.getDoc?.();
    if (!doc || !this.store) return;

    // Check program map
    if (config.programMap) {
      const entry = config.programMap.find((m) => m.program === program);
      if (entry) {
        const instTrack = doc.tracks.find(
          (t) => t.kind === "instrument" && (config.instrumentChannel === 0 || channel === config.instrumentChannel),
        );
        if (instTrack && instTrack.kind === "instrument") {
          this.store.execute(this.setTrackPresetCmd(doc, instTrack.id, entry.presetId));
          return;
        }
      }
    }

    // Fallback: program number = index in sorted preset list for the instrument kind
    const instTrack = doc.tracks.find(
      (t) => t.kind === "instrument" && (config.instrumentChannel === 0 || channel === config.instrumentChannel),
    );
    if (instTrack && instTrack.kind === "instrument") {
      // Use program number as a hint — the actual preset switching depends on available presets
      // For now, just log it. Full implementation requires PresetRepository access.
      void program;
    }
  }

  // ---------------------------------------------------------------------------
  // Aftertouch
  // ---------------------------------------------------------------------------

  private handleChannelPressure(pressure: number, _channel: number, config: MidiConfig): void {
    if (!this.engine || !config.aftertouchTarget) return;
    const range = config.aftertouchRange ?? 0.5;
    const normalized = pressure / 127;
    const scaled = normalized * range;
    this.engine.applyMidiCc(config.aftertouchTarget, scaled);
  }

  private handlePolyPressure(note: number, pressure: number, _channel: number, config: MidiConfig): void {
    if (!this.engine) return;
    const doc = this.getDoc?.();
    if (!doc) return;
    // Route to instrument track's polyPressure if available
    const instTrack = doc.tracks.find((t) => t.kind === "instrument");
    if (instTrack) {
      const normalized = pressure / 127;
      this.engine.polyPressure(instTrack.id, note, normalized);
    }
    void config;
  }

  // ---------------------------------------------------------------------------
  // MIDI Clock
  // ---------------------------------------------------------------------------

  private handleClock(config: MidiConfig): void {
    if (config.clockMode !== "slave") return;
    this.clockPulseCb?.();
  }

  private handleClockStart(config: MidiConfig): void {
    if (config.clockMode !== "slave") return;
    this.clockStartCb?.();
  }

  private handleClockContinue(config: MidiConfig): void {
    if (config.clockMode !== "slave") return;
    this.clockContinueCb?.();
  }

  private handleClockStop(config: MidiConfig): void {
    if (config.clockMode !== "slave") return;
    this.clockStopCb?.();
  }

  /** Register clock callbacks (called by MidiClock). */
  onClock(cbs: { pulse?: () => void; start?: () => void; continue?: () => void; stop?: () => void }): void {
    this.clockPulseCb = cbs.pulse ?? null;
    this.clockStartCb = cbs.start ?? null;
    this.clockContinueCb = cbs.continue ?? null;
    this.clockStopCb = cbs.stop ?? null;
  }

  // Lightweight command builders (avoids circular import from commands.ts)
  private setTrackPresetCmd(_doc: ProjectDocument, trackId: string, presetId: string) {
    return {
      type: "setTrackPreset",
      label: "Program Change",
      execute: (d: ProjectDocument) => ({
        ...d,
        tracks: d.tracks.map((t) => (t.id === trackId && t.kind === "instrument" ? { ...t, presetId } : t)),
      }),
      undo: (d: ProjectDocument) => d,
    };
  }

  private setMacroValueCmd(doc: ProjectDocument, macroId: string, value: number) {
    const clamped = Math.max(0, Math.min(1, value));
    const prev = doc.macros.find((m) => m.id === macroId)?.value ?? 0.5;
    return {
      type: "setMacroValue",
      label: "MIDI CC",
      // A knob sweep emits dozens of CC messages per gesture — coalesce them
      // into one undo entry so the history is not flooded (and real edits
      // are not evicted from the capped undo stack). Undo restores the
      // pre-gesture value.
      coalesceKey: `midi:macro:${macroId}`,
      execute: (d: ProjectDocument) => ({
        ...d,
        macros: d.macros.map((m) => (m.id === macroId ? { ...m, value: clamped } : m)),
      }),
      undo: (d: ProjectDocument) => ({
        ...d,
        macros: d.macros.map((m) => (m.id === macroId ? { ...m, value: prev } : m)),
      }),
    };
  }
}
