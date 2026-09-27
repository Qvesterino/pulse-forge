/**
 * DEVICE MONITOR — pure diff logic + wiring for the audio status chips.
 *
 * Chromium silently re-routes playback when an output device vanishes
 * (headphones unplugged, BT dies) and keeps the recording input selection
 * pointing at a dead microphone — the user gets zero feedback. This module
 * enumerates media devices, diffs against the previous snapshot and turns
 * the risky transitions (something DISAPPEARED, default changed) into short
 * human messages for the status chips.
 *
 * Deliberately message-level only: no picker re-wiring, no engine changes —
 * the browser's own fallback keeps audio flowing; we just stop being silent.
 */

export interface AudioDeviceInfo {
  deviceId: string;
  kind: "audioinput" | "audiooutput";
  label: string;
}

const KIND_LABEL: Record<AudioDeviceInfo["kind"], string> = {
  audioinput: "Microphone",
  audiooutput: "Output",
};

export function normalizeDevices(list: MediaDeviceInfo[]): AudioDeviceInfo[] {
  return list
    .filter((d) => d.kind === "audioinput" || d.kind === "audiooutput")
    .map((d) => ({
      deviceId: d.deviceId,
      kind: d.kind as AudioDeviceInfo["kind"],
      // Without mic permission labels can be empty — fall back to kind.
      label: d.label || KIND_LABEL[d.kind as AudioDeviceInfo["kind"]],
    }));
}

/** Human messages for the transitions that actually matter to a user. */
export function diffAudioDevices(
  previous: AudioDeviceInfo[],
  next: AudioDeviceInfo[],
): Array<{ level: "warn" | "info"; message: string }> {
  const messages: Array<{ level: "warn" | "info"; message: string }> = [];
  const byId = (devices: AudioDeviceInfo[]) => new Map(devices.map((d) => [d.deviceId, d]));
  const before = byId(previous);
  const after = byId(next);

  for (const device of previous) {
    if (after.has(device.deviceId)) continue;
    if (device.kind === "audiooutput") {
      messages.push({
        level: "warn",
        message: `${device.label} disconnected — audio moved to the remaining output`,
      });
    } else {
      messages.push({ level: "warn", message: `${device.label} disconnected` });
    }
  }
  const isFirstSnapshot = previous.length === 0;
  for (const device of next) {
    if (before.has(device.deviceId)) continue;
    // Skip the noisy connect case entirely on the very first snapshot.
    if (!isFirstSnapshot) {
      messages.push({
        level: "info",
        message: `New ${device.kind === "audiooutput" ? "output" : "input"} device: ${device.label}`,
      });
    }
  }
  return messages;
}

/** True when the suspended-state chip should show: the contradictory state
 *  where the user pressed play but audio cannot run. */
export function shouldShowSuspendedChip(state: string | null, playing: boolean): boolean {
  return state === "suspended" && playing;
}

/** Storage pressure fraction, or null when the API is unavailable. */
export async function readStoragePressure(): Promise<number | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota <= 0) return null;
    return usage / quota;
  } catch {
    return null;
  }
}

/** Wire the devicechange listener; fires diffed messages after an initial
 *  snapshot. Returns a stop function. */
export function startDeviceMonitor(
  onMessages: (messages: Array<{ level: "warn" | "info"; message: string }>) => void,
): () => void {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return () => {};
  let previous: AudioDeviceInfo[] = [];
  let stopped = false;

  const snapshot = async () => {
    if (stopped) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const next = normalizeDevices(list);
      if (previous.length > 0 || next.length > 0) {
        const messages = diffAudioDevices(previous, next);
        // First snapshot only warms the baseline — never messages.
        if (previous.length > 0 && messages.length > 0) onMessages(messages);
      }
      previous = next;
    } catch {
      /* enumeration can reject on permission churn — stay silent */
    }
  };

  void snapshot();
  const handler = () => void snapshot();
  navigator.mediaDevices.addEventListener?.("devicechange", handler);
  return () => {
    stopped = true;
    navigator.mediaDevices.removeEventListener?.("devicechange", handler);
  };
}
