export const RECORDING_ALIGNMENT_STORAGE_KEY = "pulse-forge:recording-alignment:v1";
export const MIN_RECORDING_INPUT_OFFSET_MS = -500;
export const MAX_RECORDING_INPUT_OFFSET_MS = 500;

export interface RecordingAlignmentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function clampOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_RECORDING_INPUT_OFFSET_MS, Math.max(MIN_RECORDING_INPUT_OFFSET_MS, Math.round(value)));
}

function browserStorage(): RecordingAlignmentStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export class RecordingAlignmentController {
  private offsetMs: number;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: RecordingAlignmentStorage | null = browserStorage()) {
    let stored: string | null = null;
    try {
      stored = storage?.getItem(RECORDING_ALIGNMENT_STORAGE_KEY) ?? null;
    } catch {
      // Blocked storage must not prevent microphone recording.
    }
    this.offsetMs = stored === null ? 0 : clampOffset(Number(stored));
  }

  getSnapshot = (): number => this.offsetMs;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setOffsetMs(value: number): void {
    const next = clampOffset(value);
    if (next === this.offsetMs) return;
    this.offsetMs = next;
    try {
      this.storage?.setItem(RECORDING_ALIGNMENT_STORAGE_KEY, String(next));
    } catch {
      // Storage quota/private browsing must not interrupt recording.
    }
    for (const listener of this.listeners) listener();
  }

  reset(): void {
    this.setOffsetMs(0);
    try {
      this.storage?.removeItem(RECORDING_ALIGNMENT_STORAGE_KEY);
    } catch {
      // A blocked storage area must not prevent microphone recording.
    }
  }
}

/** Loaded with the lazy recording/calibration panels, not the initial DAW shell. */
export const recordingAlignment = new RecordingAlignmentController();
