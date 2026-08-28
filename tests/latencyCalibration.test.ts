import { describe, expect, it } from "vitest";
import {
  LATENCY_STORAGE_KEY,
  LatencyCalibrationController,
  MAX_AUDIO_JITTER_MS,
  MAX_MIDI_REFERENCE_OFFSET_MS,
  MIN_MIDI_REFERENCE_OFFSET_MS,
  summarizeLatencySamples,
} from "../src/audio-engine/latencyCalibration";

function memoryStorage(initial?: string): Storage {
  const data = new Map<string, string>();
  if (initial) data.set(LATENCY_STORAGE_KEY, initial);
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("latency calibration math", () => {
  it("summarizes valid samples with median and MAD jitter", () => {
    const result = summarizeLatencySamples([20, 21, 19, 20, 22, 20], 48000, "2026-08-23T12:00:00.000Z");
    expect(result.roundTripMs).toBe(20);
    expect(result.jitterMs).toBe(0.5);
    expect(result.sampleCount).toBe(6);
    expect(result.stable).toBe(true);
    expect(result.sampleRate).toBe(48000);
  });

  it("marks too few samples or excessive jitter as unstable", () => {
    expect(summarizeLatencySamples([20, 21, 19, 20], 44100).stable).toBe(false);
    const unstable = summarizeLatencySamples([0, 0, 0, 0, 40, 40, 40, 40], 44100);
    expect(unstable.jitterMs).toBeGreaterThan(MAX_AUDIO_JITTER_MS);
    expect(unstable.stable).toBe(false);
  });

  it("ignores invalid and out-of-range samples", () => {
    const result = summarizeLatencySamples([20, Number.NaN, -2, 2000, 22, 21, 19, 20], 44100);
    expect(result.sampleCount).toBe(5);
    expect(result.roundTripMs).toBe(20);
  });
});

describe("LatencyCalibrationController", () => {
  it("persists measurements and clamps the MIDI reference offset", () => {
    const storage = memoryStorage();
    const controller = new LatencyCalibrationController(storage);
    controller.setMidiReferenceOffsetMs(MAX_MIDI_REFERENCE_OFFSET_MS + 20);
    expect(controller.getSnapshot().midiReferenceOffsetMs).toBe(MAX_MIDI_REFERENCE_OFFSET_MS);
    controller.setAudioMeasurement({
      roundTripMs: 23.5,
      jitterMs: 1.2,
      sampleCount: 8,
      stable: true,
      sampleRate: 48000,
      measuredAt: "2026-08-23T12:00:00.000Z",
    });

    const restored = new LatencyCalibrationController(storage);
    expect(restored.getSnapshot().audioRoundTripMs).toBe(23.5);
    expect(restored.getSnapshot().audioSampleCount).toBe(8);
    expect(restored.getSnapshot().midiReferenceOffsetMs).toBe(MAX_MIDI_REFERENCE_OFFSET_MS);
  });

  it("clamps negative offsets and ignores malformed storage", () => {
    const storage = memoryStorage("not-json");
    const controller = new LatencyCalibrationController(storage);
    expect(controller.getSnapshot().audioRoundTripMs).toBeNull();
    controller.setMidiReferenceOffsetMs(MIN_MIDI_REFERENCE_OFFSET_MS - 20);
    expect(controller.getSnapshot().midiReferenceOffsetMs).toBe(MIN_MIDI_REFERENCE_OFFSET_MS);
  });

  it("resets local state without touching project data", () => {
    const storage = memoryStorage();
    const controller = new LatencyCalibrationController(storage);
    controller.setMidiReferenceOffsetMs(12);
    controller.reset();
    expect(controller.getSnapshot().midiReferenceOffsetMs).toBe(0);
    expect(storage.getItem(LATENCY_STORAGE_KEY)).toBeNull();
  });
});
