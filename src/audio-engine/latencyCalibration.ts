export const LATENCY_STORAGE_KEY = "pulse-forge:latency-calibration:v1";

export const MIN_MIDI_REFERENCE_OFFSET_MS = -50;
export const MAX_MIDI_REFERENCE_OFFSET_MS = 100;
export const MAX_AUDIO_JITTER_MS = 8;

export interface AudioLatencyMeasurement {
  roundTripMs: number;
  jitterMs: number;
  sampleCount: number;
  stable: boolean;
  sampleRate: number;
  measuredAt: string;
}

export interface LatencyCalibrationSnapshot {
  audioRoundTripMs: number | null;
  audioJitterMs: number | null;
  audioSampleCount: number;
  audioStable: boolean | null;
  audioMeasuredAt: string | null;
  midiReferenceOffsetMs: number;
}

interface LatencyStorageRecord {
  audio?: Partial<AudioLatencyMeasurement> | null;
  midiReferenceOffsetMs?: unknown;
}

export interface LatencyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEFAULT_LATENCY_CALIBRATION: LatencyCalibrationSnapshot = {
  audioRoundTripMs: null,
  audioJitterMs: null,
  audioSampleCount: 0,
  audioStable: null,
  audioMeasuredAt: null,
  midiReferenceOffsetMs: 0,
};

export function clampMidiReferenceOffsetMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_MIDI_REFERENCE_OFFSET_MS, Math.max(MIN_MIDI_REFERENCE_OFFSET_MS, Math.round(value)));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function summarizeLatencySamples(
  samples: readonly number[],
  sampleRate: number,
  measuredAt = new Date().toISOString(),
): AudioLatencyMeasurement {
  const valid = samples.filter((sample) => Number.isFinite(sample) && sample >= 0 && sample <= 1000);
  const roundTripMs = median(valid);
  const jitterMs = median(valid.map((sample) => Math.abs(sample - roundTripMs)));
  const stable = valid.length >= 5 && jitterMs <= MAX_AUDIO_JITTER_MS;

  return {
    roundTripMs,
    jitterMs,
    sampleCount: valid.length,
    stable,
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 0,
    measuredAt,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStorage(storage: LatencyStorage | null | undefined): LatencyCalibrationSnapshot {
  if (!storage) return { ...DEFAULT_LATENCY_CALIBRATION };
  try {
    const raw = storage.getItem(LATENCY_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LATENCY_CALIBRATION };
    const parsed = JSON.parse(raw) as LatencyStorageRecord;
    const audio = parsed.audio;
    const audioRoundTripMs = finiteOrNull(audio?.roundTripMs);
    const audioJitterMs = finiteOrNull(audio?.jitterMs);
    const audioSampleCount =
      typeof audio?.sampleCount === "number" && Number.isFinite(audio.sampleCount)
        ? Math.max(0, Math.floor(audio.sampleCount))
        : 0;
    const audioStable =
      typeof audio?.stable === "boolean" ? audio.stable : audioRoundTripMs !== null ? audioSampleCount >= 5 : null;
    const measuredAt =
      typeof audio?.measuredAt === "string" && Number.isFinite(Date.parse(audio.measuredAt)) ? audio.measuredAt : null;
    return {
      audioRoundTripMs,
      audioJitterMs,
      audioSampleCount,
      audioStable,
      audioMeasuredAt: measuredAt,
      midiReferenceOffsetMs: clampMidiReferenceOffsetMs(Number(parsed.midiReferenceOffsetMs)),
    };
  } catch {
    return { ...DEFAULT_LATENCY_CALIBRATION };
  }
}

function browserStorage(): LatencyStorage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

export class LatencyCalibrationController {
  private snapshot: LatencyCalibrationSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: LatencyStorage | null = browserStorage()) {
    this.snapshot = readStorage(storage);
  }

  getSnapshot = (): LatencyCalibrationSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setAudioMeasurement(measurement: AudioLatencyMeasurement): void {
    this.snapshot = {
      ...this.snapshot,
      audioRoundTripMs: measurement.roundTripMs,
      audioJitterMs: measurement.jitterMs,
      audioSampleCount: measurement.sampleCount,
      audioStable: measurement.stable,
      audioMeasuredAt: measurement.measuredAt,
    };
    this.persist();
    this.notify();
  }

  setMidiReferenceOffsetMs(value: number): void {
    const midiReferenceOffsetMs = clampMidiReferenceOffsetMs(value);
    if (midiReferenceOffsetMs === this.snapshot.midiReferenceOffsetMs) return;
    this.snapshot = { ...this.snapshot, midiReferenceOffsetMs };
    this.persist();
    this.notify();
  }

  reset(): void {
    this.snapshot = { ...DEFAULT_LATENCY_CALIBRATION };
    try {
      this.storage?.removeItem(LATENCY_STORAGE_KEY);
    } catch {
      // Private browsing or a blocked storage area should not break audio.
    }
    this.notify();
  }

  private persist(): void {
    try {
      this.storage?.setItem(
        LATENCY_STORAGE_KEY,
        JSON.stringify({
          audio: {
            roundTripMs: this.snapshot.audioRoundTripMs,
            jitterMs: this.snapshot.audioJitterMs,
            sampleCount: this.snapshot.audioSampleCount,
            stable: this.snapshot.audioStable,
            measuredAt: this.snapshot.audioMeasuredAt,
          },
          midiReferenceOffsetMs: this.snapshot.midiReferenceOffsetMs,
        }),
      );
    } catch {
      // A full or blocked localStorage must not affect playback.
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
