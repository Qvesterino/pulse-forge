/**
 * Optional native-shell bridge (ADR 0052).
 *
 * KYX Web works with no shell. An Android Capacitor/WebView shell may inject a
 * single, same-app object as `window.kyxNative`; the web layer uses it only
 * for the four platform gaps the PWA cannot close by itself:
 *
 *   - USB/BLE MIDI (Web MIDI is absent on Chrome Android),
 *   - Storage Access Framework import/export,
 *   - a foreground service for background playback/recording,
 *   - audio focus.
 *
 * The bridge is never a remote object and never owns project/audio state. It is
 * validated defensively: an incomplete or malformed bridge is treated as
 * absent, so the PWA fallback (Web MIDI, anchor download, screen wake lock)
 * keeps working.
 */

export interface NativeMidiPort {
  id: string;
  name?: string;
  manufacturer?: string;
}

export interface NativeMidiEvent {
  /** Input port id the bytes arrived on. */
  inputId: string;
  /** Raw MIDI bytes (status + data). */
  data: number[];
  /** Monotonic timestamp in milliseconds, if the shell has one. */
  timestamp?: number;
}

export interface NativeMidiBridge {
  listInputs(): Promise<NativeMidiPort[]>;
  listOutputs(): Promise<NativeMidiPort[]>;
  /** Send bytes to an output; `null` means the shell's default output. */
  send(outputId: string | null, data: number[]): void | Promise<void>;
  /** Subscribe to incoming MIDI; returns an unsubscribe function. */
  subscribe(listener: (event: NativeMidiEvent) => void): () => void;
  /** Optional device add/remove notification; returns an unsubscribe. */
  onStateChange?(listener: () => void): () => void;
}

export interface NativeDocumentPayload {
  name: string;
  mimeType?: string;
  bytes: Uint8Array;
}

export interface NativeFilesBridge {
  /** SAF open-document flow. `multiple` may be ignored by the shell. */
  pickDocuments(options?: { mimeTypes?: string[]; multiple?: boolean }): Promise<NativeDocumentPayload[]>;
  /** SAF create-document flow. Resolves `saved:false` on user cancel. */
  saveDocument(payload: NativeDocumentPayload): Promise<{ saved: boolean; name?: string }>;
}

export type NativeAudioReason = "playback" | "recording";

export interface NativeAudioSessionBridge {
  /** Foreground service + audio focus for the first holder of this reason. */
  acquire(reason: NativeAudioReason): void | Promise<void>;
  /** Release when the last holder of the reason goes away. */
  release(reason: NativeAudioReason): void | Promise<void>;
  /** Optional audio-focus change stream; `false` means the app lost focus. */
  subscribeFocus?(listener: (focused: boolean) => void): () => void;
}

export interface KyxNativeBridge {
  /** Bumped by the shell when the contract changes; ignored by this version. */
  version?: number;
  platform: "android" | "ios" | string;
  midi?: NativeMidiBridge;
  files?: NativeFilesBridge;
  audioSession?: NativeAudioSessionBridge;
}

declare global {
  interface Window {
    kyxNative?: Partial<KyxNativeBridge>;
  }
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function validMidi(value: unknown): value is NativeMidiBridge {
  if (!value || typeof value !== "object") return false;
  const midi = value as Partial<NativeMidiBridge>;
  return (
    isFunction(midi.listInputs) && isFunction(midi.listOutputs) && isFunction(midi.send) && isFunction(midi.subscribe)
  );
}

function validFiles(value: unknown): value is NativeFilesBridge {
  if (!value || typeof value !== "object") return false;
  const files = value as Partial<NativeFilesBridge>;
  return isFunction(files.pickDocuments) && isFunction(files.saveDocument);
}

function validAudioSession(value: unknown): value is NativeAudioSessionBridge {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<NativeAudioSessionBridge>;
  return isFunction(session.acquire) && isFunction(session.release);
}

export function getNativeBridge(): KyxNativeBridge | null {
  if (typeof window === "undefined") return null;
  const raw = window.kyxNative;
  if (!raw || typeof raw !== "object" || typeof raw.platform !== "string") return null;
  return raw as KyxNativeBridge;
}

export function getNativeMidiBridge(): NativeMidiBridge | null {
  const midi = getNativeBridge()?.midi;
  return validMidi(midi) ? midi : null;
}

export function getNativeFilesBridge(): NativeFilesBridge | null {
  const files = getNativeBridge()?.files;
  return validFiles(files) ? files : null;
}

export function getNativeAudioSessionBridge(): NativeAudioSessionBridge | null {
  const session = getNativeBridge()?.audioSession;
  return validAudioSession(session) ? session : null;
}

/** Capability readout for the MIDI/settings UI. */
export function nativeCapabilities(): { midi: boolean; files: boolean; audioSession: boolean } {
  return {
    midi: getNativeMidiBridge() !== null,
    files: getNativeFilesBridge() !== null,
    audioSession: getNativeAudioSessionBridge() !== null,
  };
}
