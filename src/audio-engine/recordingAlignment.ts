import { loadRecordingInputDeviceId } from "./recordingInput";

/**
 * Recording alignment — the offset that compensates a take for the measured
 * audio round trip.
 *
 * THE OFFSET BELONGS TO A DEVICE, NOT TO THE ORIGIN (audit R-3).
 *
 * The offset used to live under ONE global localStorage key, so it applied to
 * every interface and every project: a user with two interfaces calibrated
 * the USB one, and every later take on the built-in microphone was displaced
 * by the USB interface's latency — in every project, with no way to see that
 * it had happened. The offset is now stored PER INPUT DEVICE, under
 * `pulse-forge:recording-alignment:v2:<deviceId>`, and the device id is the
 * SAME one the recorder uses (`recordingInput.loadRecordingInputDeviceId`).
 * One owner for "which input am I recording from" — the offset follows it.
 *
 * WHY THE INPUT DEVICE AND NOT THE OUTPUT: the measurement is a physical
 * round trip (output → air/loopback → microphone → input), so strictly it
 * describes a PAIR. But the output term is the same for every interface in
 * the common case (one set of speakers), the input term is what actually
 * differs between interfaces, and the app's output preference is almost always
 * "system default" — keying on it would mostly add churn without precision.
 *
 * WHY THE MEASUREMENT IS CONSTRAINED TO THE SAME DEVICE: the probe plays a
 * pulse into the default input and listens for it on the default output. If
 * it measured a different microphone than the one the offset is stored for,
 * the fix would reintroduce exactly the bug it removes. The probe now asks
 * for the selected device explicitly, and a missing device FAILS the
 * calibration instead of measuring something else.
 *
 * The LEGACY global key is adopted once, for the device that is selected at
 * upgrade time — the one the user most likely calibrated with — and then
 * dropped. That is strictly better than the old behaviour (where it applied
 * to every device) and it keeps the calibration of a single-interface setup.
 */

/** The LEGACY global key — one offset for every device. Read once, then dropped. */
export const LEGACY_RECORDING_ALIGNMENT_STORAGE_KEY = "pulse-forge:recording-alignment:v1";
/** Per-device slots: `pulse-forge:recording-alignment:v2:<deviceId>`. */
export const RECORDING_ALIGNMENT_STORAGE_PREFIX = "pulse-forge:recording-alignment:v2:";
export const MIN_RECORDING_INPUT_OFFSET_MS = -500;
export const MAX_RECORDING_INPUT_OFFSET_MS = 500;

/**
 * The slot that belongs to one input device.
 *
 * The system default input has no id, so it gets a NAMED slot ("default")
 * instead of an empty one — `…v2:` alone would read like an unfinished key.
 * It is still one slot, not one per physical device: when the system default
 * changes (a headset is plugged in), the slot still holds the old
 * calibration. That is the honest limit of keying on the id the app knows.
 */
export function recordingAlignmentStorageKey(deviceId: string): string {
  return `${RECORDING_ALIGNMENT_STORAGE_PREFIX}${deviceId || "default"}`;
}

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
  private deviceId: string;
  private readonly listeners = new Set<() => void>();

  /**
   * `deviceIdProvider` is the OWNER of the selected input — the same one the
   * recorder asks for its stream (`PcmMicRecorder`), so the offset and the
   * audio can never disagree about which microphone is in use. It is read on
   * demand rather than cached: the user can switch the input mid-session, and
   * a cached id would keep applying one interface's offset to another.
   */
  constructor(
    private readonly storage: RecordingAlignmentStorage | null = browserStorage(),
    private readonly deviceIdProvider: () => string = loadRecordingInputDeviceId,
  ) {
    this.deviceId = this.deviceIdProvider();
    this.offsetMs = this.readSlot(this.deviceId);
    this.adoptLegacyOffset();
  }

  getSnapshot = (): number => {
    const deviceId = this.deviceIdProvider();
    if (deviceId !== this.deviceId) {
      // The input changed: the previous device's offset must not follow it.
      this.deviceId = deviceId;
      this.offsetMs = this.readSlot(deviceId);
    }
    return this.offsetMs;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * The offset for ONE source, read on demand.
   *
   * Audit R-2: the offset belongs to the source that ACTUALLY recorded. In
   * native WASAPI mode that is the Windows endpoint the I/O panel opened, not
   * the browser device the dropdown names — so the caller asks for the source
   * it is about to record from, not for "the selected device". The controller's
   * own state (the selected device) is untouched: this is a READ of another
   * slot, not a switch.
   */
  getSnapshotFor = (deviceId: string): number => {
    if (deviceId === this.deviceIdProvider()) return this.getSnapshot();
    return this.readSlot(deviceId);
  };

  setOffsetMs(value: number): void {
    const deviceId = this.deviceIdProvider();
    if (deviceId !== this.deviceId) {
      this.deviceId = deviceId;
      this.offsetMs = this.readSlot(deviceId);
    }
    const next = clampOffset(value);
    if (next === this.offsetMs) return;
    this.offsetMs = next;
    try {
      this.storage?.setItem(recordingAlignmentStorageKey(deviceId), String(next));
    } catch {
      // Storage quota/private browsing must not interrupt recording.
    }
    for (const listener of this.listeners) listener();
  }

  reset(): void {
    const deviceId = this.deviceIdProvider();
    this.setOffsetMs(0);
    try {
      this.storage?.removeItem(recordingAlignmentStorageKey(deviceId));
    } catch {
      // A blocked storage area must not prevent microphone recording.
    }
  }

  /** Read one device's slot. A malformed value reads as "not calibrated". */
  private readSlot(deviceId: string): number {
    let stored: string | null = null;
    try {
      stored = this.storage?.getItem(recordingAlignmentStorageKey(deviceId)) ?? null;
    } catch {
      // Blocked storage must not prevent microphone recording.
      return 0;
    }
    if (stored === null) return 0;
    const value = Number(stored);
    if (!Number.isFinite(value)) return 0;
    return clampOffset(value);
  }

  /**
   * Adopt the LEGACY global offset for the device selected right now.
   *
   * The legacy value was measured on SOME device and applied to all of them.
   * We cannot know which, so it goes to the currently selected device — the
   * one the user most likely calibrated with — and the global key is dropped.
   * Strictly better than the old behaviour (it applied to EVERY device), and
   * it keeps the calibration of a single-interface setup.
   */
  private adoptLegacyOffset(): void {
    if (!this.storage) return;
    let stored: string | null;
    try {
      stored = this.storage.getItem(LEGACY_RECORDING_ALIGNMENT_STORAGE_KEY);
    } catch {
      return;
    }
    if (stored === null) return;
    try {
      this.storage.removeItem(LEGACY_RECORDING_ALIGNMENT_STORAGE_KEY);
    } catch {
      /* best-effort */
    }
    const value = Number(stored);
    if (!Number.isFinite(value) || value === 0) return;
    const clamped = clampOffset(value);
    if (clamped === 0) return;
    // A device with its own calibration keeps it — the legacy value is only
    // a fallback for a device that has never been calibrated.
    if (this.readSlot(this.deviceId) !== 0) return;
    try {
      this.storage.setItem(recordingAlignmentStorageKey(this.deviceId), String(clamped));
    } catch {
      /* best-effort */
    }
    this.offsetMs = clamped;
  }
}

/** Loaded with the lazy recording/calibration panels, not the initial DAW shell. */
export const recordingAlignment = new RecordingAlignmentController();

/** The slice of a measured audio round trip the placement policy consumes. */
export interface MeasuredAudioRoundTrip {
  roundTripMs: number;
  stable: boolean;
}

/**
 * Recording-placement policy for the latency probe's measurement: a stable,
 * finite round trip becomes the mic recording offset (the controller clamps
 * to ±500 ms), so takes compensate the measured output+input latency without
 * manual slider work. Unstable measurements are refused — applying one would
 * systematically misplace takes by an unmeasured amount.
 */
export function recordingOffsetFromMeasurement(measurement: MeasuredAudioRoundTrip): number | null {
  if (!measurement || measurement.stable !== true || !Number.isFinite(measurement.roundTripMs)) return null;
  return Math.round(measurement.roundTripMs);
}
