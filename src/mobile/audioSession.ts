/**
 * Mobile audio session: foreground service + audio focus (native shell) and a
 * screen wake lock fallback for the PWA (ADR 0052).
 *
 * Reasons are reference-counted per app instance, not per call site: transport
 * playback and arrangement recording can overlap, and the native shell must
 * keep its foreground service alive until the LAST holder releases.
 *
 * Without a shell this still does useful work: where the Screen Wake Lock API
 * exists, playback/recording keeps the display awake and re-acquires the lock
 * after the browser drops it on tab hide/show.
 */
import { getNativeAudioSessionBridge, type NativeAudioReason } from "./nativeBridge";

interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
}

type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
};

const counts: Record<NativeAudioReason, number> = { playback: 0, recording: 0 };
const focusListeners = new Set<(focused: boolean) => void>();
let wakeLock: WakeLockSentinelLike | null = null;
let visibilityBound = false;
let detachFocus: (() => void) | null = null;

function totalActive(): number {
  return counts.playback + counts.recording;
}

function attachFocusBridge(): void {
  if (detachFocus) return;
  const bridge = getNativeAudioSessionBridge();
  if (typeof bridge?.subscribeFocus !== "function") return;
  detachFocus = bridge.subscribeFocus((focused) => {
    for (const listener of focusListeners) {
      try {
        listener(focused);
      } catch (error) {
        console.error("[mobile-audio] focus listener failed:", error);
      }
    }
  });
}

function ensureWakeLock(): void {
  if (wakeLock || totalActive() === 0) return;
  if (typeof navigator === "undefined") return;
  // Wake locks are a mobile fallback; a desktop session must not keep the
  // display awake just because transport play started.
  if (typeof document !== "undefined" && document.documentElement.getAttribute("data-mobile-profile") === "desktop") {
    return;
  }
  const api = (navigator as WakeLockNavigator).wakeLock;
  if (typeof api?.request !== "function") return;
  void api
    .request("screen")
    .then((sentinel) => {
      wakeLock = sentinel;
      sentinel.addEventListener?.("release", () => {
        if (wakeLock === sentinel) wakeLock = null;
      });
    })
    .catch(() => {
      // Permission policy / browser denial: keep audio running without it.
    });
}

function releaseWakeLock(): void {
  const current = wakeLock;
  wakeLock = null;
  void current?.release?.().catch(() => {
    /* already released */
  });
}

function onVisibilityChange(): void {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible") ensureWakeLock();
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === "undefined") return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
}

function unbindVisibility(): void {
  if (!visibilityBound || typeof document === "undefined") return;
  visibilityBound = false;
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

export function acquireMobileAudio(reason: NativeAudioReason): void {
  counts[reason] = Math.min(1_000_000, counts[reason] + 1);
  if (counts[reason] !== 1) return;
  const bridge = getNativeAudioSessionBridge();
  if (bridge) {
    try {
      void Promise.resolve(bridge.acquire(reason)).catch((error) => {
        console.warn(`[mobile-audio] native acquire(${reason}) failed:`, error);
      });
    } catch (error) {
      console.warn(`[mobile-audio] native acquire(${reason}) threw:`, error);
    }
  }
  if (totalActive() === 1) {
    bindVisibility();
    ensureWakeLock();
  }
}

export function releaseMobileAudio(reason: NativeAudioReason): void {
  if (counts[reason] <= 0) return;
  counts[reason] -= 1;
  if (counts[reason] !== 0) return;
  const bridge = getNativeAudioSessionBridge();
  if (bridge) {
    try {
      void Promise.resolve(bridge.release(reason)).catch((error) => {
        console.warn(`[mobile-audio] native release(${reason}) failed:`, error);
      });
    } catch (error) {
      console.warn(`[mobile-audio] native release(${reason}) threw:`, error);
    }
  }
  if (totalActive() === 0) {
    unbindVisibility();
    releaseWakeLock();
  }
}

/** Dispose path: drop every reason and stop the foreground service/wake lock. */
export function releaseAllMobileAudio(): void {
  const hadPlayback = counts.playback > 0;
  const hadRecording = counts.recording > 0;
  counts.playback = 0;
  counts.recording = 0;
  const bridge = getNativeAudioSessionBridge();
  if (bridge) {
    if (hadPlayback) void Promise.resolve(bridge.release("playback")).catch(() => undefined);
    if (hadRecording) void Promise.resolve(bridge.release("recording")).catch(() => undefined);
  }
  unbindVisibility();
  releaseWakeLock();
}

export function getMobileAudioState(): {
  playback: number;
  recording: number;
  wakeLock: boolean;
  native: boolean;
} {
  return {
    playback: counts.playback,
    recording: counts.recording,
    wakeLock: wakeLock !== null,
    native: getNativeAudioSessionBridge() !== null,
  };
}

/** Audio-focus stream from the shell; returns a no-op without a bridge. */
export function subscribeMobileAudioFocus(listener: (focused: boolean) => void): () => void {
  attachFocusBridge();
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
    if (focusListeners.size === 0 && detachFocus) {
      detachFocus();
      detachFocus = null;
    }
  };
}
