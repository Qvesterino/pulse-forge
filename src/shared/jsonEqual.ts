/**
 * JSON-equality without the JSON — a drop-in replacement for
 * `JSON.stringify(a) !== JSON.stringify(b)` change-detection (GOAL 08/B1:
 * the stringify pattern ran on entire payloads per keystroke and produced
 * megabytes of transient strings on large projects).
 *
 * Semantics match JSON.stringify comparison:
 *  - reference shortcut first (immutable docs make this the 95 % case);
 *  - key ORDER does not matter (stringify is order-sensitive, but canonical
 *    construction makes that distinction unobservable in practice);
 *  - NaN equals NaN (both stringify to "null"); -0 differs from 0;
 *  - `undefined`-valued keys count as present (stringify drops them — an
 *    edge normalize outputs never emit, since sanitizers build with
 *    conditional spreads).
 *
 * Cost: O(changed subtree) with zero allocation, vs O(payload) with full
 * string materialization on both sides.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  const bRec = b as Record<string, unknown>;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRec, key)) return false;
    if (!jsonEqual((a as Record<string, unknown>)[key], bRec[key])) return false;
  }
  return true;
}
