/**
 * Funnel events (viral growth plan A4) — dead-simple local counters.
 *
 * Every event increments a counter in localStorage (`pf-funnel-v1`). No
 * network, no accounts — the numbers ship with the user until a future
 * optional beacon reads them. TTFB / prompt→zvuk konverzia (plan §1) is
 * computable from these counters alone.
 *
 * Storage-blocked browsers: events are best-effort no-ops — a missing
 * analytics counter must never break a user path.
 */

const KEY = "pf-funnel-v1";

type FunnelCounts = Record<string, number>;

function readCounts(): FunnelCounts {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as FunnelCounts;
  } catch {
    return {};
  }
}

/** Record one funnel event (idempotent name, monotonic per-browser count). */
export function funnelEvent(name: string): void {
  if (typeof name !== "string" || name.length === 0 || name.length > 64) return;
  const counts = readCounts();
  counts[name] = (counts[name] ?? 0) + 1;
  try {
    localStorage.setItem(KEY, JSON.stringify(counts));
  } catch {
    /* quota/blocked — best-effort */
  }
}

/** Read all counters (diagnostics panel / future beacon). */
export function funnelCounts(): FunnelCounts {
  return readCounts();
}
