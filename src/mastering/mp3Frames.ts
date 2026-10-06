const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0] as const;
const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0] as const;

export interface Mp3FrameHeader {
  version: 1 | 2 | 2.5;
  sampleRate: number;
  channels: number;
  bitrateKbps: number;
  frameBytes: number;
  samplesPerFrame: number;
}

/** Parse one MPEG Layer III header at a byte offset. */
export function parseMp3FrameHeader(view: DataView, offset: number): Mp3FrameHeader | null {
  if (offset < 0 || offset + 4 > view.byteLength) return null;
  const word = view.getUint32(offset, false);
  if (word >>> 21 !== 0x7ff) return null;
  const versionBits = (word >>> 19) & 0b11;
  const layerBits = (word >>> 17) & 0b11;
  const bitrateIndex = (word >>> 12) & 0b1111;
  const sampleRateIndex = (word >>> 10) & 0b11;
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3)
    return null;

  const version: Mp3FrameHeader["version"] = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const baseRate = [44100, 48000, 32000][sampleRateIndex];
  const sampleRate = baseRate / (version === 1 ? 1 : version === 2 ? 2 : 4);
  const bitrateKbps = (version === 1 ? MPEG1_L3_KBPS : MPEG2_L3_KBPS)[bitrateIndex];
  const padding = (word >>> 9) & 1;
  const samplesPerFrame = version === 1 ? 1152 : 576;
  const frameBytes = Math.floor(((version === 1 ? 144 : 72) * bitrateKbps * 1000) / sampleRate) + padding;
  return {
    version,
    sampleRate,
    channels: ((word >>> 6) & 0b11) === 3 ? 1 : 2,
    bitrateKbps,
    frameBytes,
    samplesPerFrame,
  };
}

export function mp3AudioStartOffset(header: ArrayBuffer): number {
  if (header.byteLength < 10) return 0;
  const view = new DataView(header);
  if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return 0;
  const tagSize =
    ((view.getUint8(6) & 0x7f) << 21) |
    ((view.getUint8(7) & 0x7f) << 14) |
    ((view.getUint8(8) & 0x7f) << 7) |
    (view.getUint8(9) & 0x7f);
  return 10 + tagSize + ((view.getUint8(5) & 0x10) !== 0 ? 10 : 0);
}

export function sameMp3Stream(first: Mp3FrameHeader, next: Mp3FrameHeader): boolean {
  return first.version === next.version && first.sampleRate === next.sampleRate && first.channels === next.channels;
}
