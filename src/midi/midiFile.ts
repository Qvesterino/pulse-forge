/**
 * Standard MIDI File (SMF) reader/writer — zero dependencies, like zip.ts.
 *
 * Scope is deliberately practical:
 *  - format 0/1 (format 2 is treated as 1), ticks-per-quarter division
 *    (SMPTE timing is rejected with a clear error — no browser DAW needs it)
 *  - note on/off pairing (velocity-0 note-ons count as offs), running status
 *  - tempo (0x51) + time signature (0x58) + track name (0x03) meta
 *  - note-on velocity and explicit note-off release velocity
 *  - CC7/10/11 are retained as track volume/pan/expression events; CC64
 *    sustain is represented by extending note durations. Other CC / pitch
 *    bend / program-change events are counted as unsupported.
 *
 * Ticks everywhere are "per quarter note" — the project runs on PPQ=480, and
 * the writer defaults to division 480 so project patterns round-trip 1:1.
 */

export interface MidiNote {
  pitch: number; // 0..127
  startTick: number; // absolute ticks, ≥ 0
  endTick: number; // > startTick
  /** 0..1 (MIDI 1..127 scaled). */
  velocity: number;
  /** 0..1 note-off velocity when the source used an explicit note-off event. */
  releaseVelocity?: number;
}

export interface MidiTrackData {
  name: string;
  /** 0..15. Channel 9 (0-based) is the GM drum channel. */
  channel: number;
  notes: MidiNote[];
  /** Supported continuous controllers retained for track automation. */
  controllers: MidiControllerEvent[];
}

export interface MidiControllerEvent {
  tick: number;
  controller: 7 | 10 | 11;
  value: number;
}

export interface MidiExportControllerEvent {
  tick: number;
  controller: number;
  value: number;
}

export interface MidiTempoEvent {
  tick: number;
  /** Exact BPM implied by the MIDI microseconds-per-quarter value. */
  bpm: number;
}

export interface MidiTimeSignatureEvent {
  tick: number;
  num: number;
  den: number;
}

export interface MidiUnsupportedEvents {
  controlChanges: number;
  pitchBends: number;
  programChanges: number;
  aftertouch: number;
  systemExclusive: number;
}

export interface ParsedMidi {
  division: number;
  /** First tempo meta (rounded), or null when the file has none. */
  bpm: number | null;
  timeSignature: { num: number; den: number } | null;
  /** Distinct tempo changes in tick order; repeated copies of the same value are collapsed. */
  tempoEvents: MidiTempoEvent[];
  /** Distinct time-signature changes in tick order. */
  timeSignatureEvents: MidiTimeSignatureEvent[];
  /** MIDI event classes this note-focused importer does not preserve. */
  unsupportedEvents: MidiUnsupportedEvents;
  /** Number of CC64 pedal events whose held-note timing is baked into note ends. */
  sustainPedalEvents: number;
  /** One entry per chunk×channel that contains notes or supported controllers. */
  tracks: MidiTrackData[];
}

export class MidiParseError extends Error {}

// ── low-level readers ───────────────────────────────────────────────────────

function u32(data: Uint8Array, pos: number): number {
  return ((data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]) >>> 0;
}

function u16(data: Uint8Array, pos: number): number {
  return (data[pos] << 8) | data[pos + 1];
}

/** Variable-length quantity (SMF delta times and meta lengths). */
function readVlq(data: Uint8Array, pos: number): { value: number; next: number } {
  let value = 0;
  let cursor = pos;
  for (let i = 0; i < 4; i++) {
    if (cursor >= data.length) throw new MidiParseError("truncated variable-length quantity");
    const byte = data[cursor++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return { value, next: cursor };
  }
  throw new MidiParseError("variable-length quantity longer than 4 bytes");
}

// ── parser ──────────────────────────────────────────────────────────────────

export function parseMidiFile(data: Uint8Array): ParsedMidi {
  if (data.length < 14 || String.fromCharCode(data[0], data[1], data[2], data[3]) !== "MThd") {
    throw new MidiParseError("not a MIDI file (missing MThd header)");
  }
  const headerLen = u32(data, 4);
  const format = u16(data, 8);
  const trackCount = u16(data, 10);
  const division = u16(data, 12);
  if (division & 0x8000) throw new MidiParseError("SMPTE timing is not supported (ticks-per-quarter only)");
  if (division === 0) throw new MidiParseError("invalid MIDI division (0)");
  if (format === 2) throw new MidiParseError("format-2 MIDI files are not supported");

  const tempoEvents: MidiTempoEvent[] = [];
  const timeSignatureEvents: MidiTimeSignatureEvent[] = [];
  const unsupportedEvents: MidiUnsupportedEvents = {
    controlChanges: 0,
    pitchBends: 0,
    programChanges: 0,
    aftertouch: 0,
    systemExclusive: 0,
  };
  let sustainPedalEvents = 0;
  let controllerEventCount = 0;

  // Audit 10 D3: hard cap on retained notes. A machine-generated 10 MB .mid
  // (just under the file cap) packs ~2.5 M note events — the parse used to
  // allocate them all (hundreds of MB live + multi-second freeze) only for
  // downstream caps to discard almost everything.
  const MAX_NOTES = 200_000;
  let noteCount = 0;

  /** Per chunk: name + per-channel note-open stacks + finished note lists. */
  type OpenNote = { startTick: number; velocity: number };
  type SustainedNote = { pitch: number; open: OpenNote; releaseVelocity?: number };
  const chunks: {
    name: string;
    open: Map<number, OpenNote[]>;
    notes: Map<number, MidiNote[]>;
    controllers: Map<number, MidiControllerEvent[]>;
    sustainDown: Set<number>;
    sustained: Map<number, SustainedNote[]>;
  }[] = [];

  let pos = 8 + headerLen;
  for (let chunk = 0; chunk < trackCount; chunk++) {
    if (pos + 8 > data.length) break; // tolerate truncated chunk count
    const id = String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
    const len = u32(data, pos + 4);
    const end = pos + 8 + len;
    if (id !== "MTrk") {
      pos = end;
      continue;
    }
    const entry = {
      name: `Track ${chunk + 1}`,
      open: new Map<number, OpenNote[]>(),
      notes: new Map<number, MidiNote[]>(),
      controllers: new Map<number, MidiControllerEvent[]>(),
      sustainDown: new Set<number>(),
      sustained: new Map<number, SustainedNote[]>(),
    };
    chunks.push(entry);

    let cursor = pos + 8;
    let tick = 0;
    let runningStatus = 0;
    const notesOf = (channel: number) => {
      let list = entry.notes.get(channel);
      if (!list) entry.notes.set(channel, (list = []));
      return list;
    };
    const finishNote = (
      channel: number,
      pitch: number,
      open: OpenNote,
      endT: number,
      releaseVelocity?: number,
      keepZeroLength = false,
    ) => {
      if (endT < open.startTick || (endT === open.startTick && !keepZeroLength)) return;
      if (++noteCount > MAX_NOTES) {
        throw new MidiParseError(
          `MIDI file contains too many notes (over ${MAX_NOTES}) — likely machine-generated data`,
        );
      }
      notesOf(channel).push({
        pitch,
        startTick: open.startTick,
        endTick: endT,
        velocity: Math.min(1, Math.max(0.01, open.velocity / 127)),
        ...(releaseVelocity === undefined ? {} : { releaseVelocity: Math.max(0, Math.min(1, releaseVelocity)) }),
      });
    };
    const closeNote = (channel: number, pitch: number, endT: number, releaseVelocity?: number) => {
      const stack = entry.open.get(channel + (pitch << 4));
      const open = stack?.pop();
      if (!open) return;
      if (entry.sustainDown.has(channel)) {
        let held = entry.sustained.get(channel);
        if (!held) entry.sustained.set(channel, (held = []));
        held.push({ pitch, open, ...(releaseVelocity === undefined ? {} : { releaseVelocity }) });
      } else {
        finishNote(channel, pitch, open, endT, releaseVelocity);
      }
    };
    const releaseSustain = (channel: number, endT: number) => {
      const held = entry.sustained.get(channel);
      if (!held) return;
      for (const note of held) finishNote(channel, note.pitch, note.open, endT, note.releaseVelocity);
      entry.sustained.delete(channel);
    };

    while (cursor < end) {
      const delta = readVlq(data, cursor);
      cursor = delta.next;
      tick += delta.value;
      if (cursor >= end) break;
      let status = data[cursor];
      if (status < 0x80) {
        if (!runningStatus) throw new MidiParseError("running status without a preceding status byte");
        status = runningStatus;
      } else {
        cursor++;
        runningStatus = status < 0xf0 ? status : 0;
      }

      if (status === 0xff) {
        const type = data[cursor++];
        const meta = readVlq(data, cursor);
        cursor = meta.next;
        const payload = data.subarray(cursor, cursor + meta.value);
        cursor += meta.value;
        if (type === 0x51 && meta.value === 3) {
          const usPerQuarter = (payload[0] << 16) | (payload[1] << 8) | payload[2];
          if (usPerQuarter > 0) tempoEvents.push({ tick, bpm: 60_000_000 / usPerQuarter });
        } else if (type === 0x58 && meta.value >= 2) {
          const den = Math.round(Math.pow(2, payload[1]));
          if (den > 0 && payload[0] > 0) timeSignatureEvents.push({ tick, num: payload[0], den });
        } else if (type === 0x03) {
          const name = new TextDecoder().decode(payload).trim();
          if (name) entry.name = name;
        } else if (type === 0x2f) {
          break; // end of track
        }
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const sysex = readVlq(data, cursor);
        cursor = sysex.next + sysex.value;
        unsupportedEvents.systemExclusive++;
        continue;
      }

      const kind = status & 0xf0;
      const channel = status & 0x0f;
      const data1 = data[cursor++] & 0x7f;
      const twoByte = kind === 0xc0 || kind === 0xd0;
      const data2 = twoByte ? 0 : (data[cursor++] ?? 0) & 0x7f;

      if (kind === 0x90) {
        if (data2 === 0) closeNote(channel, data1, tick);
        else {
          const key = channel + (data1 << 4);
          let stack = entry.open.get(key);
          if (!stack) entry.open.set(key, (stack = []));
          stack.push({ startTick: tick, velocity: data2 });
        }
      } else if (kind === 0x80) {
        closeNote(channel, data1, tick, data2 / 127);
      } else if (kind === 0xb0) {
        if (data1 === 64) {
          sustainPedalEvents++;
          if (data2 >= 64) entry.sustainDown.add(channel);
          else if (entry.sustainDown.delete(channel)) releaseSustain(channel, tick);
        } else if (data1 === 7 || data1 === 10 || data1 === 11) {
          if (++controllerEventCount > 200_000) {
            throw new MidiParseError("MIDI file contains too many supported controller events (over 200,000)");
          }
          let list = entry.controllers.get(channel);
          if (!list) entry.controllers.set(channel, (list = []));
          list.push({ tick, controller: data1, value: data2 });
        } else {
          unsupportedEvents.controlChanges++;
        }
      } else if (kind === 0xe0) {
        unsupportedEvents.pitchBends++;
      } else if (kind === 0xc0) {
        unsupportedEvents.programChanges++;
      } else if (kind === 0xa0 || kind === 0xd0) {
        unsupportedEvents.aftertouch++;
      }
      // Unsupported CC/PB/program/aftertouch events are counted so
      // interchange workflows can disclose the loss before committing.
    }

    // Close any hanging notes at the last tick — better an audible short
    // note than a silently dropped phrase (many exporters omit note-offs).
    // The cap guards here too: a hostile file stacking note-ons at one tick
    // floods through THIS loop otherwise (event-driven closes cap first).
    for (const [key, stack] of entry.open) {
      for (const open of stack) {
        const channel = key & 0x0f;
        const pitch = key >> 4;
        finishNote(channel, pitch, open, tick, undefined, true);
      }
    }
    entry.open.clear();
    for (const [channel] of entry.sustained) releaseSustain(channel, tick);

    pos = end;
  }

  const tracks: MidiTrackData[] = [];
  for (const entry of chunks) {
    const channels = new Set([...entry.notes.keys(), ...entry.controllers.keys()]);
    for (const channel of channels) {
      const notes = entry.notes.get(channel) ?? [];
      const controllers = entry.controllers.get(channel) ?? [];
      if (notes.length === 0 && controllers.length === 0) continue;
      notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
      tracks.push({ name: entry.name, channel, notes, controllers });
    }
  }

  const collapseEvents = <T extends { tick: number }>(events: T[], sameValue: (a: T, b: T) => boolean): T[] => {
    const sorted = events
      .map((event, order) => ({ event, order }))
      .sort((a, b) => a.event.tick - b.event.tick || a.order - b.order);
    const collapsed: T[] = [];
    for (const { event } of sorted) {
      const previous = collapsed[collapsed.length - 1];
      if (previous && previous.tick === event.tick && sameValue(previous, event)) continue;
      if (previous && previous.tick !== event.tick && sameValue(previous, event)) continue;
      collapsed.push(event);
    }
    return collapsed;
  };
  const tempos = collapseEvents(tempoEvents, (a, b) => (a as MidiTempoEvent).bpm === (b as MidiTempoEvent).bpm);
  const signatures = collapseEvents(timeSignatureEvents, (a, b) => {
    const left = a as MidiTimeSignatureEvent;
    const right = b as MidiTimeSignatureEvent;
    return left.num === right.num && left.den === right.den;
  });
  const firstTempo = tempos[0];
  const firstSignature = signatures[0];
  return {
    division,
    bpm: firstTempo ? Math.round(firstTempo.bpm) : null,
    timeSignature: firstSignature ? { num: firstSignature.num, den: firstSignature.den } : null,
    tempoEvents: tempos,
    timeSignatureEvents: signatures,
    unsupportedEvents,
    sustainPedalEvents,
    tracks,
  };
}

// ── writer ──────────────────────────────────────────────────────────────────

function writeVlq(out: number[], value: number): void {
  if (value < 0) value = 0;
  const groups = [value & 0x7f];
  value >>>= 7;
  while (value > 0) {
    groups.unshift((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out.push(...groups);
}

function chunk(id: string, payload: number[]): number[] {
  const len = payload.length;
  return [
    ...id.split("").map((c) => c.charCodeAt(0)),
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...payload,
  ];
}

export interface MidiExportNote {
  pitch: number;
  startTick: number;
  endTick: number;
  /** 0..1 */
  velocity: number;
  /** 0..1; omitted uses the neutral MIDI note-off velocity. */
  releaseVelocity?: number;
}

export interface MidiExportTrack {
  name?: string;
  /** 0..15. */
  channel: number;
  notes: MidiExportNote[];
  controllers?: MidiExportControllerEvent[];
}

export function writeMidiFile(options: {
  division?: number;
  bpm?: number;
  tempoChanges?: Array<{ tick: number; bpm: number }>;
  timeSignature?: { num: number; den: number };
  tracks: MidiExportTrack[];
}): Uint8Array {
  const division = options.division ?? 480;
  const bytes: number[] = [];

  // MThd — format 1 (conductor track + one track per part).
  bytes.push(
    ...chunk("MThd", [
      0,
      1, // format
      ((options.tracks.length + 1) >>> 8) & 0xff,
      (options.tracks.length + 1) & 0xff,
      (division >>> 8) & 0xff,
      division & 0xff,
    ]),
  );

  // Conductor track: name + tempo map + time signature + EOT.
  const meta: number[] = [];
  const metaEvents: Array<{ tick: number; order: number; bytes: number[] }> = [];
  const nameBytes = [...new TextEncoder().encode("KYX")];
  metaEvents.push({ tick: 0, order: 0, bytes: [0xff, 0x03, nameBytes.length, ...nameBytes] });
  const tempoChanges = options.tempoChanges?.length
    ? options.tempoChanges
    : options.bpm && options.bpm > 0
      ? [{ tick: 0, bpm: options.bpm }]
      : [];
  tempoChanges.forEach(({ tick, bpm }, index) => {
    if (!Number.isFinite(tick) || tick < 0 || !Number.isFinite(bpm) || bpm <= 0) return;
    const usPerQuarter = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / bpm)));
    metaEvents.push({
      tick: Math.round(tick),
      order: index + 1,
      bytes: [0xff, 0x51, 0x03, (usPerQuarter >>> 16) & 0xff, (usPerQuarter >>> 8) & 0xff, usPerQuarter & 0xff],
    });
  });
  if (options.timeSignature) {
    const denPow = Math.round(Math.log2(options.timeSignature.den));
    metaEvents.push({ tick: 0, order: 0.5, bytes: [0xff, 0x58, 0x04, options.timeSignature.num, denPow, 24, 8] });
  }
  metaEvents.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let lastMetaTick = 0;
  for (const event of metaEvents) {
    const tick = Math.max(lastMetaTick, Math.round(event.tick));
    writeVlq(meta, tick - lastMetaTick);
    meta.push(...event.bytes);
    lastMetaTick = tick;
  }
  writeVlq(meta, 0);
  meta.push(0xff, 0x2f, 0x00);
  bytes.push(...chunk("MTrk", meta));

  // Note tracks.
  for (const track of options.tracks) {
    const payload: number[] = [];
    if (track.name) {
      const trackName = [...new TextEncoder().encode(track.name.slice(0, 64))];
      writeVlq(payload, 0);
      payload.push(0xff, 0x03, trackName.length, ...trackName);
    }
    const channel = Math.max(0, Math.min(15, Math.round(track.channel)));
    type Ev = { tick: number; order: number; bytes: number[] };
    const events: Ev[] = [];
    for (const note of track.notes) {
      const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)));
      const start = Math.max(0, Math.round(note.startTick));
      const end = Math.max(start + 1, Math.round(note.endTick));
      const vel = Math.max(1, Math.min(127, Math.round(note.velocity * 127)));
      events.push({ tick: start, order: 2, bytes: [0x90 | channel, pitch, vel] });
      const releaseVelocity =
        note.releaseVelocity === undefined ? 64 : Math.max(0, Math.min(127, Math.round(note.releaseVelocity * 127)));
      events.push({ tick: end, order: 0, bytes: [0x80 | channel, pitch, releaseVelocity] });
    }
    for (const controller of track.controllers ?? []) {
      if (
        !Number.isFinite(controller.tick) ||
        controller.tick < 0 ||
        !Number.isInteger(controller.controller) ||
        controller.controller < 0 ||
        controller.controller > 127 ||
        !Number.isFinite(controller.value)
      ) {
        continue;
      }
      events.push({
        tick: Math.round(controller.tick),
        order: 1,
        bytes: [0xb0 | channel, controller.controller, Math.max(0, Math.min(127, Math.round(controller.value)))],
      });
    }
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    let lastTick = 0;
    for (const event of events) {
      writeVlq(payload, event.tick - lastTick);
      payload.push(...event.bytes);
      lastTick = event.tick;
    }
    writeVlq(payload, 0);
    payload.push(0xff, 0x2f, 0x00);
    // No argument-spread: a dense track's payload can exceed the engine's
    // call-stack argument limit and throw RangeError mid-export.
    const trackChunk = chunk("MTrk", payload);
    for (const byte of trackChunk) bytes.push(byte);
  }

  return new Uint8Array(bytes);
}
