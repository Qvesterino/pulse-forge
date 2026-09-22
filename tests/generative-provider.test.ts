import { describe, expect, it } from "vitest";
import {
  GENERATIVE_FRAME_RATE_HZ,
  GENERATIVE_PITCH_COUNT,
  createMockGenerativeProvider,
  type GenerativeInput,
} from "../src/generative";

function input(seed = "test-seed"): GenerativeInput {
  const pitchState = new Array<number>(GENERATIVE_PITCH_COUNT).fill(0);
  pitchState[60] = 2;
  return {
    bpm: 142,
    frameRateHz: GENERATIVE_FRAME_RATE_HZ,
    startTick: 0,
    style: { kind: "text", text: "dark atmospheric trap pad" },
    noteFrames: [{ frameIndex: 0, pitchState }],
    drumsMode: "off",
    macros: { energy: 0.62, density: 0.38, variation: 0.27, texture: 0.71 },
    seed,
  };
}

describe("generative provider contract", () => {
  it("produces deterministic captured audio and provenance for equal input", async () => {
    const provider = createMockGenerativeProvider({ sampleRate: 8000, channels: 2 });
    const a = await provider.createSession({ modelId: "mock-small", outputSampleRate: 8000, outputChannels: 2 });
    const b = await provider.createSession({ modelId: "mock-small", outputSampleRate: 8000, outputChannels: 2 });

    const [left, right] = await Promise.all([
      a.capture({ input: input(), durationSec: 0.1 }),
      b.capture({ input: input(), durationSec: 0.1 }),
    ]);

    expect(left).toEqual(right);
    expect(left.frames).toBe(800);
    expect(left.data.length).toBe(1600);
    await a.dispose();
    await b.dispose();
  });

  it("emits bounded realtime chunks after a valid input update", async () => {
    const provider = createMockGenerativeProvider({ sampleRate: 8000, channels: 1 });
    const session = await provider.createSession({ modelId: "mock-small", outputSampleRate: 8000, outputChannels: 1 });
    const statuses: string[] = [];
    const chunks: number[] = [];
    session.subscribeStatus((status) => statuses.push(status.state));
    session.subscribeAudio((chunk) => {
      chunks.push(chunk.sequence);
      expect(chunk.frames).toBe(320);
      expect(chunk.data.length).toBe(320);
      expect(chunk.sampleRate).toBe(8000);
      expect(chunk.channels).toBe(1);
    });

    await session.updateInput(input());
    await session.start();
    await session.updateInput(input("next-frame"));

    expect(statuses).toEqual(["idle", "starting", "running"]);
    expect(chunks).toEqual([0]);
    await session.stop();
    expect(session.getStatus().state).toBe("ready");
    await session.dispose();
  });

  it("rejects malformed note conditioning before provider work", async () => {
    const provider = createMockGenerativeProvider();
    const session = await provider.createSession({ modelId: "mock-small", outputSampleRate: 48000, outputChannels: 2 });
    const invalid = input();
    invalid.noteFrames[0]!.pitchState = [0, 1];

    await expect(session.capture({ input: invalid, durationSec: 0.1 })).rejects.toThrow("pitchState");
    await session.dispose();
  });

  it("honours capture cancellation and rejects work after dispose", async () => {
    const provider = createMockGenerativeProvider({ sampleRate: 8000, channels: 1 });
    const session = await provider.createSession({ modelId: "mock-small", outputSampleRate: 8000, outputChannels: 1 });
    const controller = new AbortController();
    controller.abort();

    await expect(session.capture({ input: input(), durationSec: 0.1, signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
    await session.dispose();
    await expect(session.start()).rejects.toThrow("disposed");
  });
});
