import { useSyncExternalStore } from "react";
import { DEFAULT_PAD_KEYS, normalizePadKeyMap, RESERVED, type PadKeyMap } from "../shared/pad-keys-data";

/**
 * Per-user QWERTY bindings for the 16 drum pads (performance keys).
 *
 * Keyboards differ (QWERTY / AZERTY / QWERTZ / national layouts), so the
 * default letter grid is rebindable per slot: press a pad's slot in the KEYS
 * editor, press any key, done. Bindings persist in localStorage — they are a
 * per-person input preference, NOT project data.
 *
 * A pad key overrides single-letter keyboard shortcuts: pressing it plays the
 * pad, the shortcut (loop toggle, track select…) stays silent for that key.
 * Modifier combos (Ctrl/Alt/Meta+…) are untouched by this rule.
 *
 * The pure data half (default grid, reserved set, normalizer) lives in
 * `shared/pad-keys-data.ts` so share-code encoders never pull React; this
 * module re-exports it for backward compatibility.
 */

export { DEFAULT_PAD_KEYS, normalizePadKeyMap, type PadKeyMap } from "../shared/pad-keys-data";

const STORAGE_KEY = "pf-padkeys-v1";

let state: PadKeyMap = [...DEFAULT_PAD_KEYS];
/**
 * True while the drum rack is mounted. Pad keys shadow plain-letter shortcuts
 * ONLY then — an instrument track selection must not silently kill S/P/C/B/E/M
 * and the P locators just because a drum track exists in the project.
 */
let armed = false;
const listeners = new Set<() => void>();

function load(): PadKeyMap {
  if (typeof localStorage === "undefined") return [...DEFAULT_PAD_KEYS];
  try {
    return normalizePadKeyMap(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return [...DEFAULT_PAD_KEYS];
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* cosmetic preference — stay silent */
  }
}

export function getPadKeys(): PadKeyMap {
  return state;
}

/** True when the (lowercased) key plays a pad — pad keys shadow plain-letter shortcuts. */
export function isPadKey(key: string): boolean {
  return state.includes(key);
}

/**
 * True when pad keys are live (the drum rack is on screen). App-level
 * shortcut routing checks this before deferring plain letters to the pads.
 */
export function padKeysArmed(): boolean {
  return armed;
}

export function setPadKeysArmed(next: boolean): void {
  armed = !!next;
}

/** Rebind slot `index` to `key`. Rebinding an occupied key swaps the two slots. */
export function bindPadKey(index: number, key: string): void {
  const k = key.toLowerCase();
  if (index < 0 || index >= 16 || k.length !== 1 || RESERVED.has(k)) return;
  const next = [...state];
  const existing = next.indexOf(k);
  if (existing >= 0 && existing !== index) {
    next[existing] = next[index];
  }
  next[index] = k;
  state = normalizePadKeyMap(next);
  persist();
  for (const listener of listeners) listener();
}

/** Install a full key map from a BINDS share code (normalized + persisted). */
export function importPadKeys(map: unknown): void {
  state = normalizePadKeyMap(map);
  persist();
  for (const listener of listeners) listener();
}

export function resetPadKeys(): void {
  state = [...DEFAULT_PAD_KEYS];
  persist();
  for (const listener of listeners) listener();
}

export function initPadKeys(): PadKeyMap {
  state = load();
  return state;
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Reactive pad key map for components. */
export function usePadKeys(): PadKeyMap {
  return useSyncExternalStore(subscribe, getPadKeys);
}
