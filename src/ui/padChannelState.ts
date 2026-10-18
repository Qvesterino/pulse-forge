import { useSyncExternalStore } from "react";
import type { RepeatRate } from "../audio-engine/NoteRepeat";

/**
 * Shared pad-channel state — the single owner of everything the drum rack
 * header and the sequencer row labels must both read and write.
 *
 * Why a module store instead of component state: the SAME channel list was
 * rendered twice (the rack pad grid and the sequencer `.row-label`), so a
 * value like "pad 3 repeats 1/16" or "16 LEVELS is armed" had to be written in
 * one place and read in the other. Component state cannot cross that boundary;
 * an external store can, and `useSyncExternalStore` keeps the read path
 * subscription-based (a plain getter would not re-render on write).
 *
 * Subscriptions are deliberately narrow: `usePadPeak(padId)` re-renders ONE
 * row when that pad's peak changes, not every row. A pad list re-rendered at
 * 60 fps on every decaying peak would be the same cost the rack already pays —
 * do not multiply it by the row count.
 *
 * The decay loop stays with its owner (RackStrip's rAF effect calls
 * `decayPeaks()`), so the loop's lifecycle is exactly what it was before this
 * module existed — only the storage and the notify moved.
 */

type Listener = () => void;
type Updater<T> = T | ((prev: T) => T>;

function notify(listeners: Set<Listener>): void {
  for (const listener of [...listeners]) listener();
}

function resolve<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater;
}

function subscribeTo(set: Set<Listener>, listener: Listener): () => void {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Divisions a pad can pin individually (global "off" is the master switch, not an option here). */
export const PINNABLE_RATES = ["1/4", "1/8", "1/16", "1/8T", "1/16T"] as const;
export type PinnableRate = (typeof PINNABLE_RATES)[number];

// ── Per-pad pinned repeat divisions ────────────────────────────────────────

let pinnedRates: Record<string, PinnableRate> = {};
const pinnedListeners = new Set<Listener>();

export function getPinnedRates(): Record<string, PinnableRate> {
  return pinnedRates;
}

export function setPinnedRates(next: Updater<Record<string, PinnableRate>>): void {
  const value = resolve(next, pinnedRates);
  if (value === pinnedRates) return;
  pinnedRates = value;
  notify(pinnedListeners);
}

export function subscribePinnedRates(listener: Listener): () => void {
  return subscribeTo(pinnedListeners, listener);
}

export function usePinnedRates(): Record<string, PinnableRate> {
  return useSyncExternalStore(subscribePinnedRates, getPinnedRates);
}

// ── MPC 16 LEVELS: pads become velocity lanes for the selected sound ────────

let sixteenLevels = false;
const levelsListeners = new Set<Listener>();

export function getSixteenLevels(): boolean {
  return sixteenLevels;
}

export function setSixteenLevels(next: Updater<boolean>): void {
  const value = resolve(next, sixteenLevels);
  if (value === sixteenLevels) return;
  sixteenLevels = value;
  notify(levelsListeners);
}

export function subscribeSixteenLevels(listener: Listener): () => void {
  return subscribeTo(levelsListeners, listener);
}

export function useSixteenLevels(): boolean {
  return useSyncExternalStore(subscribeSixteenLevels, getSixteenLevels);
}

// ── Live pad peaks (sequencer state, rendered as a meter) ──────────────────

/** Per-frame falloff of the meter, matching the rack's pre-existing loop. */
export const PEAK_DECAY = 0.88;
/** Below this the pad is silent and the entry is dropped entirely. */
const PEAK_FLOOR = 0.02;

let peaks: Record<string, number> = {};
const peakListeners = new Set<Listener>();

export function getPeaks(): Record<string, number> {
  return peaks;
}

/** One pad's peak. Reads through the record so a write is visible immediately. */
export function peakOf(padId: string): number {
  return peaks[padId] ?? 0;
}

export function setPeaks(next: Updater<Record<string, number>>): void {
  const value = resolve(next, peaks);
  if (value === peaks) return;
  peaks = value;
  notify(peakListeners);
}

/** Write one pad's peak — the hot path (every playhead hit, every press). */
export function setPadPeak(padId: string, value: number): void {
  if (peaks[padId] === value) return;
  peaks = { ...peaks, [padId]: value };
  notify(peakListeners);
}

/**
 * One decay frame: every live peak falls by `factor` and anything at or below
 * `floor` is dropped. Returns whether a re-render is needed (false only when
 * nothing was live), which is what lets the caller skip the notify entirely.
 */
export function decayPeaks(factor: number = PEAK_DECAY, floor: number = PEAK_FLOOR): boolean {
  if (Object.keys(peaks).length === 0) return false;
  const next: Record<string, number> = {};
  for (const [padId, value] of Object.entries(peaks)) {
    const decayed = value * factor;
    if (decayed > floor) next[padId] = decayed;
  }
  peaks = next;
  notify(peakListeners);
  return true;
}

export function subscribePeaks(listener: Listener): () => void {
  return subscribeTo(peakListeners, listener);
}

/** One row's meter reading. Numeric snapshot → re-renders only when IT moves. */
export function usePadPeak(padId: string): number {
  return useSyncExternalStore(subscribePeaks, () => peakOf(padId));
}

/** The whole record — for surfaces that render every pad's meter at once. */
export function usePeaks(): Record<string, number> {
  return useSyncExternalStore(subscribePeaks, getPeaks);
}

// ── Test seam ──────────────────────────────────────────────────────────────

/** Reset every channel. Tests only — the UI never tears the channel down. */
export function resetPadChannelState(): void {
  pinnedRates = {};
  sixteenLevels = false;
  peaks = {};
  notify(pinnedListeners);
  notify(levelsListeners);
  notify(peakListeners);
}

/** Effective division for a pad: its own pin wins, else the global default. */
export function effectiveRateOf(pinned: RepeatRate | undefined, globalRate: RepeatRate): RepeatRate {
  return pinned ?? globalRate;
}