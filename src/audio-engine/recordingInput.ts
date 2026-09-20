const STORAGE_KEY = "pf:recording-input-device";
const GAIN_STORAGE_KEY = "pf:recording-input-gain-db";

export interface RecordingInputDevice {
  deviceId: string;
  label: string;
}

type RecordingInputStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): RecordingInputStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The selected mic is a per-browser preference, never part of a project. */
export function loadRecordingInputDeviceId(storage: RecordingInputStorage | null = browserStorage()): string {
  try {
    return storage?.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveRecordingInputDeviceId(
  deviceId: string,
  storage: RecordingInputStorage | null = browserStorage(),
): void {
  try {
    if (!storage) return;
    if (deviceId) storage.setItem(STORAGE_KEY, deviceId);
    else storage.removeItem(STORAGE_KEY);
  } catch {
    // Blocked/full preference storage must never prevent a vocal take.
  }
}

/** Persisted input trim (dB) for the next mic session. */
export function loadRecordingInputGainDb(storage: RecordingInputStorage | null = browserStorage()): number {
  try {
    const raw = storage?.getItem(GAIN_STORAGE_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function saveRecordingInputGainDb(gainDb: number, storage: RecordingInputStorage | null = browserStorage()): void {
  try {
    if (!storage) return;
    storage.setItem(GAIN_STORAGE_KEY, String(Math.round(gainDb * 10) / 10));
  } catch {
    // Blocked storage must not prevent a vocal take.
  }
}

/** Device labels are often withheld until the user grants microphone access. */
export async function listRecordingInputDevices(
  mediaDevices: Pick<MediaDevices, "enumerateDevices"> | null =
    typeof navigator !== "undefined" ? navigator.mediaDevices : null,
): Promise<RecordingInputDevice[]> {
  if (!mediaDevices || typeof mediaDevices.enumerateDevices !== "function") return [];
  const devices = await mediaDevices.enumerateDevices();
  let anonymousIndex = 0;
  const seen = new Set<string>();
  return devices.flatMap((device) => {
    if (device.kind !== "audioinput" || !device.deviceId || device.deviceId === "default" || seen.has(device.deviceId)) {
      return [];
    }
    seen.add(device.deviceId);
    anonymousIndex++;
    return [{ deviceId: device.deviceId, label: device.label.trim() || `Microphone ${anonymousIndex}` }];
  });
}
