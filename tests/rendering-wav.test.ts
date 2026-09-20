import { describe, expect, it } from "vitest";
import { encodeWav } from "../src/rendering/wav";

function fakeBuffer(samples: number[]): AudioBuffer {
  return {
    numberOfChannels: 1,
    sampleRate: 44_100,
    length: samples.length,
    getChannelData: () => Float32Array.from(samples),
  } as unknown as AudioBuffer;
}

describe("WAV render encoding", () => {
  it("preserves hot samples in the 32-bit float interchange format", () => {
    const bytes = encodeWav(fakeBuffer([1.2, Number.NaN, -1.2]), 32);
    const view = new DataView(bytes);

    expect(view.getFloat32(44, true)).toBe(Math.fround(1.2));
    expect(view.getFloat32(48, true)).toBe(0);
    expect(view.getFloat32(52, true)).toBe(Math.fround(-1.2));
    expect(view.getFloat32(44, true)).toBeGreaterThan(1);
  });

  it("soft-knees hot 24-bit PCM instead of pre-clamping at full scale", () => {
    const bytes = encodeWav(fakeBuffer([1.2]), 24);
    const view = new DataView(bytes);
    const unsigned = view.getUint8(44) | (view.getUint8(45) << 8) | (view.getUint8(46) << 16);
    expect(unsigned).toBeLessThan(0x7fffff);
    expect(unsigned).toBeGreaterThan(Math.round(0.95 * 0x7fffff));
  });
});
