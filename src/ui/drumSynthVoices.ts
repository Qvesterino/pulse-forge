/**
 * Drum-pad synth voice defaults — single source of truth for the TYPE
 * dropdown in the pad inspector (Inspector.tsx) and the floating plugin
 * (FloatingPlugin.tsx).
 *
 * Why this is a typed Record and not an inline `Record<string, …>`: the
 * inline version was indexed with an `as any`-cast string, so a `<option>`
 * value that had no entry returned `undefined` and the next line threw a
 * TypeError on `d.decay`. A `Record<DrumSynthType, …>` makes the table
 * exhaustive at compile time — adding a DrumSynthType without a default is a
 * type error, and indexing with a value outside the union is a type error.
 *
 * The `DRUM_SYNTH_TYPE_ORDER` array is the render order for the dropdown and
 * must stay in sync with the keys; it is derived from the table so it can
 * never drift.
 */
import type { DrumSynthConfig, DrumSynthType } from "../project-model/types";

/** Per-type voice seed. `type` itself is not stored here — the caller adds it. */
export type DrumSynthVoiceDefaults = Omit<DrumSynthConfig, "type">;

export const DRUM_SYNTH_DEFAULTS: Record<DrumSynthType, DrumSynthVoiceDefaults> = {
  hatClosed: { decay: 0.08, tone: 7500, snap: 0.35, body: 0.3 },
  hatOpen: { decay: 0.32, tone: 7000, snap: 0.55, body: 0.5 },
  clap: { decay: 0.25, tone: 1200, snap: 0.4, body: 0.5 },
  perc: { decay: 0.12, tone: 2100, snap: 0.35, body: 0.45 },
  cowbell: { decay: 0.32, tone: 540, snap: 0.35, body: 0.5 },
  kick: { decay: 0.42, tone: 5000, snap: 0.3, body: 0.6 },
  snare: { decay: 0.22, tone: 1750, snap: 0.45, body: 0.5 },
};

/** Dropdown order. Derived from the table so the two can never diverge. */
export const DRUM_SYNTH_TYPE_ORDER = Object.keys(DRUM_SYNTH_DEFAULTS) as DrumSynthType[];

/** Human labels for the TYPE dropdown, keyed by the same union. */
export const DRUM_SYNTH_TYPE_LABELS: Record<DrumSynthType, string> = {
  hatClosed: "Hat Closed",
  hatOpen: "Hat Open",
  clap: "Clap",
  perc: "Perc (Tick)",
  cowbell: "Cowbell",
  kick: "Kick",
  snare: "Snare",
};

/**
 * Narrow an untrusted `<select>` value to a DrumSynthType.
 * Returns null for anything outside the union instead of throwing, so a
 * mistyped option degrades to "leave the current voice alone" rather than
 * crashing the panel.
 */
export function asDrumSynthType(value: string): DrumSynthType | null {
  return (DRUM_SYNTH_TYPE_ORDER as string[]).includes(value) ? (value as DrumSynthType) : null;
}

/**
 * A full DrumSynthConfig for a pad, preserving whatever the pad already had.
 * `pad.synth` is `DrumSynthConfig | null | undefined`; spreading null/undefined
 * is safe at runtime but the type system needs the explicit fallback.
 */
export function mergeSynth(base: DrumSynthConfig | null | undefined, patch: Partial<DrumSynthConfig>): DrumSynthConfig {
  return { ...(base ?? { type: "hatClosed", decay: 0.08, tone: 7500, snap: 0.35, body: 0.3 }), ...patch };
}
