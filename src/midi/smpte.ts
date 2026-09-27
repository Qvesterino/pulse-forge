/**
 * SMPTE timecode over MIDI (MTC) — decoder + timecode math.
 *
 * Wave 1 of the SMPTE standard (ADR 0017 companion): KYX can READ MIDI
 * Timecode from external gear — quarter-frame streams (0xF1) and full-frame
 * SysEx (F0 7F 7F 01 01 …) — and convert timecode labels to real seconds,
 * samples (the BWF `bext` timeReference) and back, including the 29.97
 * drop-frame compensation that famously punishes the naive.
 *
 * Everything is pure and network-boundary hardened: bytes from the MIDI wire
 * are validated before they can reach Transport or any UI readout.
 */

/** Timecode families. `2997` = 29.97 fps drop-frame ("30 DF"), `30` = 30 non-drop. */
export type SmpTeRate = 24 | 25 | 2997 | 30;

export interface SmpTeTimecode {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  rate: SmpTeRate;
}

export const SMPTE_RATES: readonly SmpTeRate[] = [24, 25, 2997, 30];

/** Frames per second the timecode LABEL counts (29.97 DF still counts 30 units). */
export function nominalFps(rate: SmpTeRate): 24 | 25 | 30 {
  return rate === 24 ? 24 : rate === 25 ? 25 : 30;
}

/** Real frames per second (the 29.97 DF family actually plays at 29.97). */
export function realFps(rate: SmpTeRate): number {
  return rate === 2997 ? 29.97 : nominalFps(rate);
}

/** Network boundary: garbage bytes must never poison transport math. */
export function isSmpTeTimecode(value: unknown): value is SmpTeTimecode {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<SmpTeTimecode>;
  return (
    SMPTE_RATES.includes(t.rate as SmpTeRate) &&
    Number.isInteger(t.hours) &&
    t.hours! >= 0 &&
    t.hours! <= 23 &&
    Number.isInteger(t.minutes) &&
    t.minutes! >= 0 &&
    t.minutes! <= 59 &&
    Number.isInteger(t.seconds) &&
    t.seconds! >= 0 &&
    t.seconds! <= 59 &&
    Number.isInteger(t.frames) &&
    t.frames! >= 0 &&
    t.frames! < nominalFps(t.rate as SmpTeRate)
  );
}

/**
 * Real elapsed seconds at the timecode label. Drop-frame compensates for
 * 29.97 fps counting in 30-unit seconds: 2 frames are dropped at every
 * minute except every 10th — one hour of DF timecode is EXACTLY 3600.0 s
 * (107892 real frames), where the non-drop label would drift 3.6 s.
 */
export function smpteToSeconds(tc: SmpTeTimecode): number {
  if (!isSmpTeTimecode(tc)) return Number.NaN;
  if (tc.rate !== 2997) {
    return (tc.hours * 3600 + tc.minutes * 60 + tc.seconds) + tc.frames / nominalFps(tc.rate);
  }
  const frameNumber = tc.hours * 107892 + tc.minutes * 1798 + Math.floor(tc.minutes / 10) * 2 + tc.seconds * 30 + tc.frames;
  return frameNumber / 29.97;
}

/** Inverse of {@link smpteToSeconds}: real seconds → timecode label. */
export function secondsToSmpTe(seconds: number, rate: SmpTeRate): SmpTeTimecode | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (rate !== 2997) {
    const fps = nominalFps(rate);
    const whole = Math.floor(seconds);
    const frames = Math.min(fps - 1, Math.floor((seconds - whole) * fps));
    return { hours: Math.floor(whole / 3600) % 24, minutes: Math.floor(whole / 60) % 60, seconds: whole % 60, frames, rate };
  }
  let frameNumber = Math.floor(seconds * 29.97);
  const hours = Math.min(23, Math.floor(frameNumber / 107892));
  frameNumber -= hours * 107892;
  // Minutes: m*1798 + floor(m/10)*2 is monotonic — bracket then settle.
  let minutes = Math.min(59, Math.floor(frameNumber / 1798));
  const dropped = (m: number) => m * 1798 + Math.floor(m / 10) * 2;
  while (minutes > 0 && dropped(minutes) > frameNumber) minutes--;
  while (minutes < 59 && dropped(minutes + 1) <= frameNumber) minutes++;
  const rest = frameNumber - dropped(minutes);
  return { hours, minutes, seconds: Math.floor(rest / 30), frames: rest % 30, rate };
}

/** Frames since the SMPTE day origin — the BWF `bext` timeReference basis. */
export function smpteToSamples(tc: SmpTeTimecode, sampleRate: number): number {
  return Math.round(smpteToSeconds(tc) * sampleRate);
}

export function samplesToSmpTe(samples: number, sampleRate: number, rate: SmpTeRate): SmpTeTimecode | null {
  if (!Number.isFinite(samples) || samples < 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  return secondsToSmpTe(samples / sampleRate, rate);
}

/** "hh:mm:ss:ff" — drop-frame renders the last separator as ";" per convention. */
export function formatSmpTe(tc: SmpTeTimecode): string {
  if (!isSmpTeTimecode(tc)) return "--:--:--:--";
  const p2 = (n: number) => String(n).padStart(2, "0");
  const frameSeparator = tc.rate === 2997 ? ";" : ":";
  return `${p2(tc.hours)}:${p2(tc.minutes)}:${p2(tc.seconds)}${frameSeparator}${p2(tc.frames)}`;
}

/** Parse "hh:mm:ss:ff" (or ";ff" for drop-frame). `rate` is not carried by the string. */
export function parseSmpTe(text: string, rate: SmpTeRate): SmpTeTimecode | null {
  const match = /^(\d{1,2}):(\d{1,2}):(\d{1,2})[;:](\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  const tc: SmpTeTimecode = {
    hours: Number(match[1]),
    minutes: Number(match[2]),
    seconds: Number(match[3]),
    frames: Number(match[4]),
    rate,
  };
  return isSmpTeTimecode(tc) ? tc : null;
}

/** MTC speed nibble → rate family (MIDI Timecode spec, quarter-frame piece 7). */
export function mtcRateCodeToRate(code: number): SmpTeRate {
  return ([24, 25, 2997, 30] as SmpTeRate[])[Math.min(3, Math.max(0, code))];
}

/**
 * Assembles MTC quarter-frame pairs (0xF1 messages) into full timecodes.
 * A frame is 8 pieces (frame/sec/min/hour × low/high nibbles). Out-of-order
 * or repeated pieces reset the assembly — a garbled cable must not emit
 * fabricated positions.
 */
export class MtcDecoder {
  private values = [0, 0, 0, 0]; // frames, seconds, minutes, hours (raw assembled)
  private nextPiece = 0;
  private rate: SmpTeRate = 25;

  /**
   * Feed one quarter frame: `pieceIndex` (0..7) with the message data byte.
   * The MTC data byte is `(pieceIndex << 4) | nibble` — a mismatch between
   * the caller's piece index and the byte's own nibble is treated as noise.
   */
  feed(pieceIndex: number, data: number): SmpTeTimecode | null {
    if (!Number.isInteger(pieceIndex) || pieceIndex < 0 || pieceIndex > 7) return null;
    if (!Number.isInteger(data) || data < 0 || data > 0x7f) return null;
    if (data >> 4 !== pieceIndex) {
      this.nextPiece = 0;
      return null;
    }
    if (pieceIndex !== this.nextPiece) {
      // Only a piece 0 starts a valid (re)sync; anything else is noise.
      if (pieceIndex !== 0) {
        this.nextPiece = 0;
        return null;
      }
    }
    const value = data & 0x0f;
    switch (pieceIndex) {
      case 0:
        this.values[0] = value; // frame low
        break;
      case 1:
        this.values[0] |= value << 4; // frame high (1 bit used)
        break;
      case 2:
        this.values[1] = value; // seconds low
        break;
      case 3:
        this.values[1] |= (value & 0x03) << 4;
        break;
      case 4:
        this.values[2] = value; // minutes low
        break;
      case 5:
        this.values[2] |= (value & 0x03) << 4;
        break;
      case 6:
        this.values[3] = value; // hour low
        break;
      case 7:
        this.values[3] |= (value & 0x01) << 4;
        this.rate = mtcRateCodeToRate((value >> 1) & 0x03);
        break;
    }
    this.nextPiece = pieceIndex + 1;
    if (pieceIndex !== 7) return null;
    this.nextPiece = 0;
    const tc: SmpTeTimecode = {
      frames: this.values[0],
      seconds: this.values[1],
      minutes: this.values[2],
      hours: this.values[3],
      rate: this.rate,
    };
    return isSmpTeTimecode(tc) ? tc : null;
  }

  /**
   * Parse an MTC full-frame SysEx (F0 7F 7F 01 01 hh mm ss ff [F7]). Full
   * frames are how gear announces a JUMP (chase target) — the decoder must
   * also resync the quarter-frame stream, which callers do via `resync()`.
   */
  static parseFullFrame(bytes: ArrayLike<number>): SmpTeTimecode | null {
    if (!bytes || bytes.length < 9) return null;
    if (bytes[0] !== 0xf0 || bytes[1] !== 0x7f || bytes[2] !== 0x7f || bytes[3] !== 0x01 || bytes[4] !== 0x01) return null;
    const rate = mtcRateCodeToRate((bytes[5] >> 5) & 0x03);
    const tc: SmpTeTimecode = {
      hours: bytes[5] & 0x1f,
      minutes: bytes[6] & 0x3f,
      seconds: bytes[7] & 0x3f,
      frames: bytes[8] & 0x1f,
      rate,
    };
    return isSmpTeTimecode(tc) ? tc : null;
  }

  /** Reset partial assembly (call after a jump/full frame or device change). */
  resync(): void {
    this.nextPiece = 0;
    this.values = [0, 0, 0, 0];
  }
}

export interface MtcSnapshot {
  timecode: SmpTeTimecode;
  atEpochMs: number;
}

/**
 * Host-side receiver: decoder + recency + pub/sub for the statusbar readout.
 * Pure decode math stays in {@link MtcDecoder}; this adds only the "when did
 * a frame last arrive" state the UI needs to show and hide itself.
 */
export class MtcReceiver {
  private decoder = new MtcDecoder();
  private snapshot: MtcSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): MtcSnapshot | null {
    return this.snapshot;
  }

  /** True when a frame arrived within `freshMs` (default 1 s). */
  isFresh(freshMs = 1000): boolean {
    return this.snapshot !== null && Date.now() - this.snapshot.atEpochMs <= freshMs;
  }

  handleQuarter(pieceIndex: number, data: number): void {
    const frame = this.decoder.feed(pieceIndex, data);
    if (frame) this.note(frame);
  }

  handleFullFrame(bytes: Uint8Array): void {
    const frame = MtcDecoder.parseFullFrame(bytes);
    if (frame) {
      // A full frame is a jump — the quarter-frame stream restarts around it.
      this.decoder.resync();
      this.note(frame);
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.snapshot = null;
  }

  private note(frame: SmpTeTimecode): void {
    this.snapshot = { timecode: frame, atEpochMs: Date.now() };
    for (const listener of this.listeners) listener();
  }
}
