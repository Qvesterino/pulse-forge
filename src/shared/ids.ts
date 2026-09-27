/**
 * TEST-ONLY deterministic id mode. While active, uid() emits sequential,
 * reproducible ids (`pattern-test-0001`) instead of random UUIDs. The counter
 * is monotonic per module instance (per test file) — docs built in the same
 * order get the same ids across runs, which makes snapshots diffable and
 * cross-instance test fixtures alignable. Never enable in production code.
 */
let deterministicMode = false;
let deterministicCounter = 0;

export function useDeterministicIds(): () => void {
  // Restore the PREVIOUS state, not "off" — nested scopes (a builder inside
  // a builder) must not silently disable the mode for their caller.
  const previous = deterministicMode;
  deterministicMode = true;
  return () => {
    deterministicMode = previous;
  };
}

/** TEST-ONLY: reset the deterministic counter (call inside useDeterministicIds). */
export function resetDeterministicIds(start = 0): void {
  deterministicCounter = start;
}

export function uid(prefix: string): string {
  if (deterministicMode) {
    return `${prefix}-test-${(deterministicCounter++).toString(36).padStart(4, "0")}`;
  }
  // `typeof … === "function"` rather than `"randomUUID" in crypto`: the `in`
  // check is satisfied by a property that is present-but-undefined (partial
  // WebCrypto polyfills, older Safari 14, some embedded webviews), so the
  // `in` form passes the guard and then throws `is not a function` instead of
  // taking the fallback. Matches the guard in RecordingRecoveryRepository and
  // PcmMicRecorder.
  const raw =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${raw}`;
}

export function clamp(value: number, min: number, max: number): number {
  // NaN passes through Math.min/max chains unchanged — a NaN velocity from a
  // parse bug must clamp to the floor, not poison a pattern row or a note.
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
