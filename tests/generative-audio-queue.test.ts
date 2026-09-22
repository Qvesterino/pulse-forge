import { describe, expect, it } from "vitest";
import { GenerativeAudioQueue } from "../src/generative/audio-queue";

function chunk(values: number[]) {
  return { sequence: 0, sampleRate: 48000, channels: 1, frames: values.length, data: new Float32Array(values) };
}

describe("generative bounded audio queue", () => {
  it("reports an underrun and zero-fills the missing tail", () => {
    const queue = new GenerativeAudioQueue(1, 8);
    queue.push(chunk([0.1, 0.2]));

    const pulled = queue.pull(4);

    expect(pulled.deliveredFrames).toBe(2);
    expect(pulled.underrun).toBe(true);
    expect(pulled.data[0]).toBeCloseTo(0.1);
    expect(pulled.data[1]).toBeCloseTo(0.2);
    expect([...pulled.data.slice(2)]).toEqual([0, 0]);
  });

  it("drops the oldest frames when a provider overruns capacity", () => {
    const queue = new GenerativeAudioQueue(1, 3);
    const pushed = queue.push(chunk([1, 2, 3, 4, 5]));

    expect(pushed.overrun).toBe(true);
    expect(pushed.droppedFrames).toBe(2);
    expect([...queue.pull(3).data]).toEqual([3, 4, 5]);
    expect(queue.droppedFrames).toBe(2);
  });

  it("preserves interleaved stereo frames", () => {
    const queue = new GenerativeAudioQueue(2, 2);
    queue.push({ sequence: 0, sampleRate: 48000, channels: 2, frames: 2, data: new Float32Array([1, 10, 2, 20]) });

    expect([...queue.pull(2).data]).toEqual([1, 10, 2, 20]);
  });
});
