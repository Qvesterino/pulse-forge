import { describe, expect, it } from "vitest";
import { encodeWav } from "../src/rendering/wav";

function makeBuffer(channels: number[][], sampleRate = 44100): AudioBuffer {
  const length = channels[0].length;
  return {
    length,
    sampleRate,
    numberOfChannels: channels.length,
    duration: length / sampleRate,
    getChannelData: (ch: number) => Float32Array.from(channels[ch]),
  } as unknown as AudioBuffer;
}

const readString = (view: DataView, offset: number, len: number) => {
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
};

describe("wav encoder", () => {
  it("writes a valid 16-bit PCM header", () => {
    const buffer = makeBuffer([[0.5, -0.5, 0.25, -0.25]]);
    const arrayBuffer = encodeWav(buffer, 16);
    const view = new DataView(arrayBuffer);
    expect(readString(view, 0, 4)).toBe("RIFF");
    expect(readString(view, 8, 4)).toBe("WAVE");
    expect(readString(view, 12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(readString(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(4 * 2);
    expect(arrayBuffer.byteLength).toBe(44 + 8);
  });

  it("encodes 16-bit sample values correctly and clamps", () => {
    const buffer = makeBuffer([[1.5, -1.5, 0.5]]);
    const view = new DataView(encodeWav(buffer, 16));
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBeCloseTo(0.5 * 0x7fff, -1);
  });

  it("interleaves stereo channels", () => {
    const buffer = makeBuffer([[0.5, 0.25], [-0.5, -0.25]]);
    const view = new DataView(encodeWav(buffer, 16));
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(40, true)).toBe(2 * 2 * 2);
    expect(view.getInt16(44, true)).toBeGreaterThan(0);
    expect(view.getInt16(46, true)).toBeLessThan(0);
    expect(view.getInt16(48, true)).toBeGreaterThan(0);
    expect(view.getInt16(50, true)).toBeLessThan(0);
  });

  it("writes 24-bit and 32-bit float formats", () => {
    const buffer = makeBuffer([[0.5, -0.5]]);
    const pcm24 = new DataView(encodeWav(buffer, 24));
    expect(pcm24.getUint16(20, true)).toBe(1);
    expect(pcm24.getUint16(34, true)).toBe(24);
    expect(pcm24.getUint32(40, true)).toBe(2 * 3);

    const float32 = new DataView(encodeWav(buffer, 32));
    expect(float32.getUint16(20, true)).toBe(3);
    expect(float32.getUint16(34, true)).toBe(32);
    expect(float32.getFloat32(44, true)).toBeCloseTo(0.5, 5);
    expect(float32.getFloat32(48, true)).toBeCloseTo(-0.5, 5);
  });
});
