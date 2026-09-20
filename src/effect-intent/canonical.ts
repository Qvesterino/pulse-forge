import { hashString } from "../shared/rng";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite value");
  return value;
}

export function canonicalEffectIntentJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/** Stable non-cryptographic fingerprint used to reject stale UI proposals. */
export function effectIntentFingerprint(value: unknown): string {
  const canonical = canonicalEffectIntentJson(value);
  const primary = hashString(canonical).toString(16).padStart(8, "0");
  const secondary = hashString(`pulse-forge-effect-intent-v1:${canonical}`).toString(16).padStart(8, "0");
  return `${primary}${secondary}`;
}
