/**
 * Audio OUTPUT device selection (Studio I/O panel, ROADMAP: I/O wave).
 *
 * Chromium ≥110 exposes `AudioContext.setSinkId` — the only standard path a
 * web app has for choosing where sound comes out. The API is optional at
 * runtime (older browsers, Firefox/Safari) and the types are not in every
 * lib.dom revision, so everything here feature-detects and reports honestly
 * instead of assuming support.
 *
 * Preference is per-browser, never part of a project — the same contract as
 * the recording input in `recordingInput.ts`.
 */
const STORAGE_KEY = "pf:audio-output-device";

type RecordingInputStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type MediaDevicesPick = Pick<MediaDevices, "enumerateDevices"> | null;

/** Minimal structural type for the optional setSinkId API. */
type SinkIdContext = { setSinkId?: (sinkId: string) => Promise<void> };

export interface OutputDevice {
  deviceId: string;
  label: string;
}

function browserStorage(): RecordingInputStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadOutputDeviceId(storage: RecordingInputStorage | null = browserStorage()): string {
  try {
    return storage?.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveOutputDeviceId(deviceId: string, storage: RecordingInputStorage | null = browserStorage()): void {
  try {
    if (!storage) return;
    if (deviceId) storage.setItem(STORAGE_KEY, deviceId);
    else storage.removeItem(STORAGE_KEY);
  } catch {
    // Cosmetic preference — quota/private mode stays silent.
  }
}

export function setSinkIdSupported(ctx: BaseAudioContext | null): boolean {
  return Boolean(ctx && typeof (ctx as SinkIdContext).setSinkId === "function");
}

/**
 * Apply a device to the LIVE context. Resolves an honest status —
 * "unsupported" / engine errors carry a message instead of throwing into
 * the UI. The empty string means the system default.
 */
export async function applyOutputDevice(
  ctx: BaseAudioContext | null,
  deviceId: string,
): Promise<{
  status: "ok" | "unsupported" | "error";
  message?: string;
}> {
  if (!ctx || ctx.state === "closed") return { status: "error", message: "No active audio context" };
  const sink = ctx as SinkIdContext;
  if (typeof sink.setSinkId !== "function") {
    return { status: "unsupported", message: "This browser cannot switch audio outputs (no setSinkId)" };
  }
  try {
    await sink.setSinkId(deviceId);
    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Output endpoints. "default" stays an explicit first entry (the picker's
 *  empty value maps to it) — enumerateDevices lists it as a distinct device
 *  and hiding it would make "back to system default" undiscoverable. */
export async function listOutputDevices(
  mediaDevices: MediaDevicesPick = typeof navigator !== "undefined" ? navigator.mediaDevices : null,
): Promise<OutputDevice[]> {
  if (!mediaDevices || typeof mediaDevices.enumerateDevices !== "function") return [];
  try {
    const devices = await mediaDevices.enumerateDevices();
    // "default" is seeded as the explicit first entry — never listed twice.
    const seen = new Set(["default"]);
    const out: OutputDevice[] = [{ deviceId: "default", label: "System default output" }];
    let anonymousIndex = 0;
    for (const device of devices) {
      if (device.kind !== "audiooutput" || !device.deviceId || seen.has(device.deviceId)) continue;
      seen.add(device.deviceId);
      anonymousIndex++;
      const label = device.label.trim();
      out.push({ deviceId: device.deviceId, label: label || `Audio output ${anonymousIndex}` });
    }
    return out;
  } catch {
    return [{ deviceId: "default", label: "System default output" }];
  }
}
