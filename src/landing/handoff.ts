/**
 * Landing → studio handoff (viral growth plan A1).
 *
 * A beat generated on the landing page travels into the studio through
 * sessionStorage instead of a `?import=` URL — a full share code is tens of
 * KB and would bloat every internal navigation. `Boot` picks the handoff up
 * right after `enterStudio` and drops the project through the SAME
 * `openProject` path a share link uses; the prompt text rides along for the
 * IntentPanel pre-fill (A2), so the user lands in a studio that already
 * holds their beat AND the sentence that made it.
 *
 * All reads are take-semantics (read + clear): a reload after the studio
 * opened must not re-import yesterday's handoff, and a failed decode falls
 * back to the normal studio entry rather than blocking it.
 */

const HANDOFF_KEY = "pf-handoff";
export const INTENT_PREFILL_KEY = "pf-intent-prefill";

export interface LandingHandoff {
  /** Share code of the generated project (encodeShareCode output). */
  code: string;
  /** The prompt that produced it (for the IntentPanel pre-fill). */
  prompt: string;
}

function session(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null; // storage blocked — handoff degrades to normal studio entry
  }
}

/** Store a freshly forged landing beat for the studio to pick up. */
export function savePendingHandoff(handoff: LandingHandoff): void {
  const storage = session();
  if (!storage) return;
  try {
    storage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    /* quota/blocked — the studio still opens, just without the beat */
  }
}

/** Take (and clear) a pending handoff. Returns null when absent/corrupt. */
export function takePendingHandoff(): LandingHandoff | null {
  const storage = session();
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(HANDOFF_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    storage.removeItem(HANDOFF_KEY);
  } catch {
    /* best-effort clear */
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as LandingHandoff).code !== "string" ||
      typeof (parsed as LandingHandoff).prompt !== "string"
    ) {
      return null;
    }
    return parsed as LandingHandoff;
  } catch {
    return null;
  }
}

/**
 * Stash the prompt for the IntentPanel pre-fill. Separate from the handoff:
 * `Boot` consumes the doc immediately, the panel consumes the text on mount.
 */
export function stashIntentPrefill(prompt: string): void {
  const storage = session();
  if (!storage || !prompt.trim()) return;
  try {
    storage.setItem(INTENT_PREFILL_KEY, prompt);
  } catch {
    /* best-effort */
  }
}

/** Take (and clear) a pending IntentPanel pre-fill prompt. */
export function takeIntentPrefill(): string | null {
  const storage = session();
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(INTENT_PREFILL_KEY);
    if (raw !== null) storage.removeItem(INTENT_PREFILL_KEY);
  } catch {
    return null;
  }
  return raw && raw.trim() ? raw : null;
}
