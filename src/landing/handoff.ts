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
const SONG_STARTER_KEY = "pf-song-starter";

export interface SongStarterHandoff {
  genre: string;
  mood: string | null;
  bpm: number;
}

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

/**
 * Peek at a pending handoff WITHOUT clearing it.
 *
 * `Boot` must peek (not take): React StrictMode mounts effects twice in dev
 * — a take-and-clear on the first (immediately cancelled) run would swallow
 * the handoff before the second run ever sees it. The successful run clears
 * explicitly once the studio is up, which also gives reload-retry semantics
 * if openProject fails mid-boot.
 */
export function peekPendingHandoff(): LandingHandoff | null {
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

/** Drop a consumed (or unreadable) handoff. Best-effort. */
export function clearPendingHandoff(): void {
  const storage = session();
  if (!storage) return;
  try {
    storage.removeItem(HANDOFF_KEY);
  } catch {
    /* best-effort */
  }
}

/** Take (and clear) a pending handoff. Returns null when absent/corrupt. */
export function takePendingHandoff(): LandingHandoff | null {
  const handoff = peekPendingHandoff();
  if (handoff) clearPendingHandoff();
  return handoff;
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

/** Pass the selected song-starter filters from the project browser into KYX Studio. */
export function stashSongStarter(starter: SongStarterHandoff): void {
  const storage = session();
  if (!storage || !starter.genre.trim() || !Number.isFinite(starter.bpm) || starter.bpm < 40 || starter.bpm > 240)
    return;
  try {
    storage.setItem(SONG_STARTER_KEY, JSON.stringify(starter));
  } catch {
    /* The project and prompt still open when session storage is unavailable. */
  }
}

/** Read the current song-starter handoff without consuming it. */
export function peekSongStarter(): SongStarterHandoff | null {
  const storage = session();
  if (!storage) return null;
  try {
    const raw = storage.getItem(SONG_STARTER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<SongStarterHandoff>;
    if (
      typeof value.genre !== "string" ||
      !value.genre.trim() ||
      !(value.mood === null || typeof value.mood === "string") ||
      typeof value.bpm !== "number" ||
      !Number.isFinite(value.bpm) ||
      value.bpm < 40 ||
      value.bpm > 240
    ) {
      return null;
    }
    return { genre: value.genre, mood: value.mood, bpm: value.bpm };
  } catch {
    return null;
  }
}

/** Clear a song starter once the studio has read it. */
export function clearSongStarter(): void {
  const storage = session();
  if (!storage) return;
  try {
    storage.removeItem(SONG_STARTER_KEY);
  } catch {
    /* best-effort */
  }
}

// ── Regenerate-with-intent (viral growth plan B1) ──────────────────────────
// A gallery/embed link carries `?regen=1`; Boot stashes this flag so the App
// opens the INTENT panel and the panel auto-runs one fresh-seed generation
// from the imported beat's own intent provenance. Peek on the App side (the
// flag must survive until the panel mounts), take on the panel side.

const REGEN_FLAG_KEY = "pf-intent-regen";

export function stashRegenFlag(): void {
  const storage = session();
  if (!storage) return;
  try {
    storage.setItem(REGEN_FLAG_KEY, "1");
  } catch {
    /* best-effort — regen degrades to a normal import */
  }
}

/** True when the studio boot came from a `?regen=1` link (non-destructive). */
export function peekRegenFlag(): boolean {
  const storage = session();
  if (!storage) return false;
  try {
    return storage.getItem(REGEN_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

/** Consume the regen flag (IntentPanel mount — the auto-generate runs once). */
export function takeRegenFlag(): boolean {
  const storage = session();
  if (!storage) return false;
  let present = false;
  try {
    present = storage.getItem(REGEN_FLAG_KEY) === "1";
    if (present) storage.removeItem(REGEN_FLAG_KEY);
  } catch {
    return false;
  }
  return present;
}
