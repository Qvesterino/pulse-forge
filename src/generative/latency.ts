/**
 * Host-local calibration for provider-backed live tracks.
 *
 * This is deliberately separate from ProjectDocument: a provider's warm-up
 * and control latency belong to the current machine/bridge, not to a song.
 */
export const GENERATIVE_LATENCY_STORAGE_KEY = "pulse-forge:generative-latency:v1";

export interface GenerativeLatencySnapshot {
  warmupMs: number | null;
  controlMs: number | null;
  warmupSamples: number;
  controlSamples: number;
  measuredAt: string | null;
}

export interface GenerativeLatencyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEFAULT_GENERATIVE_LATENCY: GenerativeLatencySnapshot = {
  warmupMs: null,
  controlMs: null,
  warmupSamples: 0,
  controlSamples: 0,
  measuredAt: null,
};

function storageOrNull(): GenerativeLatencyStorage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function finiteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 120_000 ? value : null;
}

function readSnapshot(storage: GenerativeLatencyStorage | null): GenerativeLatencySnapshot {
  if (!storage) return { ...DEFAULT_GENERATIVE_LATENCY };
  try {
    const raw = storage.getItem(GENERATIVE_LATENCY_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GENERATIVE_LATENCY };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      warmupMs: finiteMs(parsed.warmupMs),
      controlMs: finiteMs(parsed.controlMs),
      warmupSamples: Number.isSafeInteger(parsed.warmupSamples) ? Math.max(0, Number(parsed.warmupSamples)) : 0,
      controlSamples: Number.isSafeInteger(parsed.controlSamples) ? Math.max(0, Number(parsed.controlSamples)) : 0,
      measuredAt: typeof parsed.measuredAt === "string" ? parsed.measuredAt : null,
    };
  } catch {
    return { ...DEFAULT_GENERATIVE_LATENCY };
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export function generativeLatencyNow(): number {
  return nowMs();
}

export class GenerativeLatencyCalibrationController {
  private snapshot: GenerativeLatencySnapshot;

  constructor(private readonly storage: GenerativeLatencyStorage | null = storageOrNull()) {
    this.snapshot = readSnapshot(storage);
  }

  getSnapshot(): GenerativeLatencySnapshot {
    return { ...this.snapshot };
  }

  recordWarmup(durationMs: number): void {
    this.snapshot = this.record("warmupMs", "warmupSamples", durationMs);
    this.persist();
  }

  recordControl(durationMs: number): void {
    this.snapshot = this.record("controlMs", "controlSamples", durationMs);
    this.persist();
  }

  reset(): void {
    this.snapshot = { ...DEFAULT_GENERATIVE_LATENCY };
    try {
      this.storage?.removeItem(GENERATIVE_LATENCY_STORAGE_KEY);
    } catch {
      // Blocked/private storage must never affect audio.
    }
  }

  private record(
    valueKey: "warmupMs" | "controlMs",
    sampleKey: "warmupSamples" | "controlSamples",
    durationMs: number,
  ): GenerativeLatencySnapshot {
    const value = finiteMs(durationMs);
    if (value === null) return this.snapshot;
    const samples = this.snapshot[sampleKey];
    const previous = this.snapshot[valueKey] ?? value;
    const nextSamples = Math.min(10_000, samples + 1);
    return {
      ...this.snapshot,
      [valueKey]: samples === 0 ? value : previous + (value - previous) / nextSamples,
      [sampleKey]: nextSamples,
      measuredAt: new Date().toISOString(),
    };
  }

  private persist(): void {
    try {
      this.storage?.setItem(GENERATIVE_LATENCY_STORAGE_KEY, JSON.stringify(this.snapshot));
    } catch {
      // A full or blocked localStorage must not affect playback.
    }
  }
}
