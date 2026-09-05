/**
 * Standard MIDI File (SMF) reader/writer — zero dependencies, like zip.ts.
 *
 * Scope is deliberately practical:
 *  - format 0/1 (format 2 is treated as 1), ticks-per-quarter division
 *    (SMPTE timing is rejected with a clear error — no browser DAW needs it)
 *  - note on/off pairing (velocity-0 note-ons count as offs), running status
 *  - tempo (0x51) + time signature (0x58) + track name (0x03) meta
 *  - CC / pitch bend / program change are skipped on import; the writer
 *    emits only what the project model can represent: tempo + notes.
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
}

export interface MidiTrackData {
  name: string;
  /** 0..15. Channel 9 (0-based) is the GM drum channel. */
  channel: number;
  notes: MidiNote[];
}

export interface ParsedMidi {
  division: number;
  /** First tempo meta (rounded), or null when the file has none. */
  bpm: number | null;
  timeSignature: { num: number; den: number } | null;
  /** One entry per chunk×channel that contains at least one note. */
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

  let bpm: number | null = null;
  let timeSignature: { num: number; den: number } | null = null;

  /** Per chunk: name + per-channel note-open stacks + finished note lists. */
  type OpenNote = { startTick: number; velocity: number };
  const chunks: { name: string; open: Map<number, OpenNote[]>; notes: Map<number, MidiNote[]> }[] = [];

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
    const entry = { name: `Track ${chunk + 1}`, open: new Map(), notes: new Map() };
    chunks.push(entry);

    let cursor = pos + 8;
    let tick = 0;
    let runningStatus = 0;
    const notesOf = (channel: number) => {
      let list = entry.notes.get(channel);
      if (!list) entry.notes.set(channel, (list = []));
      return list;
    };
    const closeNote = (channel: number, pitch: number, endT: number, velocity = 1) => {
      const stack = entry.open.get(channel + (pitch << 4));
      const open = stack?.pop();
      if (!open) return;
      if (endT <= open.startTick) return;
      notesOf(channel).push({
        pitch,
        startTick: open.startTick,
        endTick: endT,
        velocity: Math.min(1, Math.max(0.01, open.velocity / 127)),
      });
      void velocity;
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
          if (usPerQuarter > 0 && bpm === null) bpm = Math.round(60_000_000 / usPerQuarter);
        } else if (type === 0x58 && meta.value >= 2 && timeSignature === null) {
          const den = Math.round(Math.pow(2, payload[1]));
          if (den > 0) timeSignature = { num: payload[0], den };
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
        closeNote(channel, data1, tick);
      }
      // CC/PB/program/aftertouch: intentionally skipped.
    }

    // Close any hanging notes at the last tick — better an audible short
    // note than a silently dropped phrase (many exporters omit note-offs).
    for (const [key, stack] of entry.open) {
      for (const open of stack) {
        const channel = key & 0x0f;
        const pitch = key >> 4;
        notesOf(channel).push({ pitch, startTick: open.startTick, endTick: tick, velocity: Math.min(1, Math.max(0.01, open.velocity / 127)) });
      }
    }
    entry.open.clear();

    pos = end;
  }

  const tracks: MidiTrackData[] = [];
  for (const entry of chunks) {
    for (const [channel, notes] of entry.notes) {
      if (notes.length === 0) continue;
      notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
      tracks.push({ name: entry.name, channel, notes });
    }
  }

  return { division, bpm, timeSignature, tracks };
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
}

export interface MidiExportTrack {
  name?: string;
  /** 0..15. */
  channel: number;
  notes: MidiExportNote[];
}

export function writeMidiFile(options: {
  division?: number;
  bpm?: number;
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

  // Conductor track: name + tempo + time signature + EOT.
  const meta: number[] = [];
  const nameBytes = [...new TextEncoder().encode("Pulse Forge")];
  writeVlq(meta, 0);
  meta.push(0xff, 0x03, nameBytes.length, ...nameBytes);
  if (options.bpm && options.bpm > 0) {
    const usPerQuarter = Math.round(60_000_000 / options.bpm);
    writeVlq(meta, 0);
    meta.push(0xff, 0x51, 0x03, (usPerQuarter >>> 16) & 0xff, (usPerQuarter >>> 8) & 0xff, usPerQuarter & 0xff);
  }
  if (options.timeSignature) {
    const denPow = Math.round(Math.log2(options.timeSignature.den));
    writeVlq(meta, 0);
    meta.push(0xff, 0x58, 0x04, options.timeSignature.num, denPow, 24, 8);
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
      events.push({ tick: start, order: 1, bytes: [0x90 | channel, pitch, vel] });
      events.push({ tick: end, order: 0, bytes: [0x80 | channel, pitch, 0] });
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
