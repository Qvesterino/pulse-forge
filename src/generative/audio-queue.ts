import type { GenerativeAudioChunk } from "./types";

export interface GenerativeAudioQueuePull {
  data: Float32Array;
  requestedFrames: number;
  deliveredFrames: number;
  underrun: boolean;
  availableFrames: number;
}

export interface GenerativeAudioQueuePush {
  acceptedFrames: number;
  droppedFrames: number;
  availableFrames: number;
  overrun: boolean;
}

/**
 * Provider-neutral bounded PCM transport. It owns no AudioNode and performs
 * no DSP; its only job is to make backpressure, drops and underruns explicit
 * before a provider is connected to an AudioWorklet or native output bus.
 */
export class GenerativeAudioQueue {
  private readonly ring: Float32Array;
  private readFrame = 0;
  private writeFrame = 0;
  private bufferedFrames = 0;
  private totalDroppedFrames = 0;

  constructor(
    readonly channels: number,
    readonly maxFrames: number,
    readonly sampleRate = 48000,
  ) {
    if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
      throw new Error("Generative audio queue channel count is invalid");
    }
    if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new Error("Generative audio queue capacity is invalid");
    if (!Number.isInteger(sampleRate) || sampleRate <= 0)
      throw new Error("Generative audio queue sample rate is invalid");
    this.ring = new Float32Array(channels * maxFrames);
  }

  get availableFrames(): number {
    return this.bufferedFrames;
  }

  get droppedFrames(): number {
    return this.totalDroppedFrames;
  }

  clear(): void {
    this.readFrame = 0;
    this.writeFrame = 0;
    this.bufferedFrames = 0;
  }

  push(chunk: GenerativeAudioChunk): GenerativeAudioQueuePush {
    if (chunk.sampleRate !== this.sampleRate) throw new Error("Generative audio queue sample-rate mismatch");
    if (chunk.channels !== this.channels) throw new Error("Generative audio queue channel mismatch");
    if (!Number.isInteger(chunk.frames) || chunk.frames < 0 || chunk.data.length !== chunk.frames * this.channels) {
      throw new Error("Generative audio queue chunk shape is invalid");
    }
    for (const sample of chunk.data) {
      if (!Number.isFinite(sample)) throw new Error("Generative audio queue chunk contains a non-finite sample");
    }

    const sourceStartFrame = Math.max(0, chunk.frames - this.maxFrames);
    const acceptedFrames = chunk.frames - sourceStartFrame;
    const neededDrop = Math.max(0, this.bufferedFrames + acceptedFrames - this.maxFrames);
    if (neededDrop > 0) {
      this.readFrame = (this.readFrame + neededDrop) % this.maxFrames;
      this.bufferedFrames -= neededDrop;
    }
    this.totalDroppedFrames += neededDrop + sourceStartFrame;
    for (let frame = sourceStartFrame; frame < chunk.frames; frame++) {
      const sourceOffset = frame * this.channels;
      const ringOffset = this.writeFrame * this.channels;
      this.ring.set(chunk.data.subarray(sourceOffset, sourceOffset + this.channels), ringOffset);
      this.writeFrame = (this.writeFrame + 1) % this.maxFrames;
      this.bufferedFrames++;
    }
    return {
      acceptedFrames,
      droppedFrames: neededDrop + sourceStartFrame,
      availableFrames: this.bufferedFrames,
      overrun: neededDrop + sourceStartFrame > 0,
    };
  }

  pull(requestedFrames: number): GenerativeAudioQueuePull {
    if (!Number.isInteger(requestedFrames) || requestedFrames < 0) {
      throw new Error("Generative audio queue pull size is invalid");
    }
    const availableBefore = this.bufferedFrames;
    const deliveredFrames = Math.min(requestedFrames, availableBefore);
    const data = new Float32Array(requestedFrames * this.channels);
    for (let frame = 0; frame < deliveredFrames; frame++) {
      const ringOffset = this.readFrame * this.channels;
      data.set(this.ring.subarray(ringOffset, ringOffset + this.channels), frame * this.channels);
      this.readFrame = (this.readFrame + 1) % this.maxFrames;
    }
    this.bufferedFrames -= deliveredFrames;
    return {
      data,
      requestedFrames,
      deliveredFrames,
      underrun: deliveredFrames < requestedFrames,
      availableFrames: this.bufferedFrames,
    };
  }
}
