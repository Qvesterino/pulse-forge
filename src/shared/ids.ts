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
  deterministicMode = true;
  return () => {
    deterministicMode = false;
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
  const raw =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${raw}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
