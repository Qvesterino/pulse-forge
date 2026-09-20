/**
 * Defensive AudioParam writer used by every AudioWorklet effect node wrapper.
 *
 * Background: a corrupt document, a bad preset, a half-applied migration or
 * a stale automation entry can hand an AudioWorklet effect a non-finite param
 * value. The Web Audio spec REQUIRES every AudioParam write (`p.value = v` or
 * `p.setValueAtTime(v, t)`) to throw `TypeError` when `v` is `NaN`,
 * `+Infinity` or `-Infinity`. That throw escapes through the engine's
 * bulk-sync loop (see `AudioEngine.syncFxParams`) and can abort the entire
 * fx chain build for a track — leaving the user with silent audio during a
 * critical path (document load, preset apply, undo replay).
 *
 * `safeApplyAudioParam` mirrors the inline guard in `compressor-node.ts`
 * that has protected the dynamics bus from this failure mode for years: it
 * looks up the param by id, no-ops if unknown, DROPS non-finite values so
 * the AudioParam retains its current value (the worklet's prepare() default),
 * and otherwise applies the write unchanged.
 *
 * The helper is purely additive — calling it with a finite value is
 * behaviourally identical to the prior inline writes — so wiring it up
 * across every node wrapper is a no-op audit win for content creators and
 * a malformed-input defence in depth for the engine.
 *
 * Apply with `when` undefined for an instant `p.value = v` (k-rate writes
 * never lose precision in the audio thread); pass an AudioContext time to
 * schedule the change via `setValueAtTime` (used by automation `paramAt`).
 */
export function safeApplyAudioParam(
  node: AudioWorkletNode,
  id: string,
  value: number,
  when?: number,
): void {
  const p = node.parameters.get(id);
  if (!p) return;
  // Spec-mandated guard: non-finite AudioParam values throw TypeError.
  // Drop them and keep the param's current value to preserve playback.
  if (!Number.isFinite(value)) return;
  if (when === undefined) p.value = value;
  else p.setValueAtTime(value, when);
}
