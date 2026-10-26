// Audit R-1: a take that captured nothing must not be shown as a take.
//
// The frame count was the ONLY gate: a muted input, a device that delivered
// nothing, a capture that never started — each produced a take that looked
// like any other and sounded like nothing. The meter warned on CLIPPING;
// nothing ever warned on silence.
//
// The teeth probe: drop the measurement from `materializePcmTake` (or make
// `measurePcmSilence` always report "not silent") and the RED case below goes
// green again.

import { describe, expect, it } from "vitest";
import { materializePcmTake, measurePcmSilence, PCM_SILENCE_PEAK_THRESHOLD } from "../src/audio-engine/pcmRecording";
import type { IRecordingRecoveryRepository } from "../src/persistence/contracts";
import type { RecordingPcmChunk, RecordingSession } from "../src/persistence/RecordingRecoveryRepository";

function fakeBuffer(channels: Float32Array[]): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate: 48_000,
    duration: (channels[0]?.length ?? 0) / 48_000,
    getChannelData: (channel: number) => channels[channel],
  } as unknown as AudioBuffer;
}

function session(totalFrames: number): RecordingSession {
  return {
    id: "recording-silence",
    projectId: "project-1",
    trackId: "vocal-1",
    trackName: "Lead Vocal",
    startBar: 0,
    bpm: 120,
    channels: 1,
    sampleRate: 48_000,
    createdAt: new Date().toISOString(),
    updatedAt: Date.now(),
    status: "recoverable",
    totalFrames,
    chunkCount: 1,
  } as unknown as RecordingSession;
}

function fakeRecovery(chunks: RecordingPcmChunk[], stored: RecordingSession): IRecordingRecoveryRepository {
  return {
    get: async () => stored,
    forEachChunk: async (_sessionId: string, visit: (chunk: RecordingPcmChunk, frameOffset: number) => void) => {
      for (const chunk of chunks) visit(chunk, 0);
    },
  } as unknown as IRecordingRecoveryRepository;
}

describe("recording silence (audit R-1)", () => {
  it("calls a take of digital silence SILENT", () => {
    const measurement = measurePcmSilence(fakeBuffer([new Float32Array(64)]));
    expect(measurement.silent).toBe(true);
    expect(measurement.peak).toBe(0);
    expect(measurement.rms).toBe(0);
  });

  it("does NOT call a real recording silent", () => {
    const data = new Float32Array(64);
    data[7] = 0.5;
    data[9] = -0.25;
    const measurement = measurePcmSilence(fakeBuffer([data]));
    expect(measurement.silent).toBe(false);
    expect(measurement.peak).toBeCloseTo(0.5, 6);
    expect(measurement.rms).toBeGreaterThan(0);
  });

  it("does NOT call a quiet but real recording silent", () => {
    // A whisper at the noise floor: far above digital silence, far below a
    // normal level. The gate must not swallow it.
    const data = new Float32Array(64).fill(0.002);
    const measurement = measurePcmSilence(fakeBuffer([data]));
    expect(measurement.silent).toBe(false);
    expect(measurement.peak).toBeCloseTo(0.002, 6);
  });

  it("the threshold is far below any real signal", () => {
    expect(PCM_SILENCE_PEAK_THRESHOLD).toBeLessThan(0.001);
  });

  it("the MATERIALIZED take carries the measurement, so the app can say so", async () => {
    const stored = session(4);
    const chunks: RecordingPcmChunk[] = [
      {
        sessionId: stored.id,
        sequence: 0,
        frames: 4,
        channels: [new Float32Array(4).buffer],
      } as unknown as RecordingPcmChunk,
    ];
    const context = {
      createBuffer: (_channels: number, _frames: number, _sampleRate: number) => fakeBuffer([new Float32Array(4)]),
    } as unknown as BaseAudioContext;

    const take = await materializePcmTake(fakeRecovery(chunks, stored), stored.id, context);

    expect(take.silence).toBeDefined();
    expect(take.silence.silent).toBe(true);
    expect(take.silence.peak).toBe(0);
  });

  it("a materialized take WITH audio is not silent", async () => {
    const stored = session(4);
    const data = new Float32Array([0.4, -0.4, 0.2, 0]);
    const chunks: RecordingPcmChunk[] = [
      {
        sessionId: stored.id,
        sequence: 0,
        frames: 4,
        channels: [data.buffer],
      } as unknown as RecordingPcmChunk,
    ];
    const context = {
      createBuffer: (_channels: number, _frames: number, _sampleRate: number) => fakeBuffer([new Float32Array(4)]),
    } as unknown as BaseAudioContext;

    const take = await materializePcmTake(fakeRecovery(chunks, stored), stored.id, context);

    expect(take.silence.silent).toBe(false);
    expect(take.silence.peak).toBeCloseTo(0.4, 6);
  });
});
