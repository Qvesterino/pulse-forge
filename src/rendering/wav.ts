import { mulberry32, quantizeInt16Sample, softClipSample } from "../export/quantize";
import { downloadBlob } from "../export/download";

export type WavBitDepth = 16 | 24 | 32;

export function encodeWav(buffer: AudioBuffer, bitDepth: WavBitDepth): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  // RIFF chunk fields are unsigned 32-bit. Past ~4 GB they wrap and the file
  // is silently corrupt — an explicit failure beats wasting a 20-minute
  // render on a WAV no player will read.
  if (dataSize > 0xffffffff - 44) {
    throw new Error(
      `Render too large for WAV export (${(dataSize / 1024 ** 3).toFixed(1)} GB data). Export in segments or lower the sample rate/bit depth.`,
    );
  }
  // Audit 11 D4: RIFF requires an odd `data` chunk to carry one pad byte —
  // currently unreachable (all sources are stereo), but encodeWav is public
  // API and a future mono 24-bit call would emit a spec-violating file.
  const padByte = dataSize % 2 === 1 ? 1 : 0;
  const arrayBuffer = new ArrayBuffer(44 + dataSize + padByte);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  // RIFF sizes count the data chunk WITH its pad byte (spec: chunks are
  // word-aligned); the declared `dataSize` stays the raw sample bytes.
  view.setUint32(4, 36 + dataSize + padByte, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  // TPDF dither PRNG for the 16-bit path (seeded → byte-reproducible exports)
  const ditherRand = mulberry32(0x57415631);
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      // Keep non-finite render artefacts from poisoning the file, but feed
      // hot finite samples through the shared soft-knee policy. Clamping
      // before softClipSample would turn the 24/32-bit paths into a hidden
      // hard clip at exactly full scale.
      const input = Number.isFinite(channels[ch][i]) ? channels[ch][i] : 0;
      if (bitDepth === 16) {
        view.setInt16(offset, quantizeInt16Sample(input, ditherRand), true);
        offset += 2;
      } else {
        // 32-bit float is the interchange/mastering format: retain finite
        // over-range samples and let the receiving DAW preserve the headroom.
        // Integer PCM still uses the export soft-knee to avoid hard clipping.
        const sample = bitDepth === 32 ? input : softClipSample(input);
        if (bitDepth === 24) {
          const value = Math.round(sample * (sample < 0 ? 0x800000 : 0x7fffff));
          view.setUint8(offset, value & 0xff);
          view.setUint8(offset + 1, (value >> 8) & 0xff);
          view.setUint8(offset + 2, (value >> 16) & 0xff);
          offset += 3;
        } else {
          view.setFloat32(offset, sample, true);
          offset += 4;
        }
      }
    }
  }
  return arrayBuffer;
}

export function downloadWav(arrayBuffer: ArrayBuffer, filename: string): void {
  downloadBlob(new Blob([arrayBuffer], { type: "audio/wav" }), filename);
}

export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[^\w\- ]+/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 60) || "pulse-forge"
  );
}
