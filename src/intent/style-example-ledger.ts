import { GENRES } from "../ai/types";

export const STYLE_EXAMPLE_LEDGER_KEY = "pf:producer-style-examples";
export const STYLE_AUTO_LEARN_KEY = "pf:producer-style-auto-learn";
export const STYLE_PREFERRED_GENRE_KEY = "pf:producer-style-genre";
export const STYLE_EXAMPLES_CHANGED_EVENT = "pf:producer-style-examples-changed";
export const STYLE_EXAMPLES_CLEARED_EVENT = "pf:producer-style-examples-cleared";
export const STYLE_EXAMPLE_LEDGER_VERSION = 1 as const;
export const STYLE_EXAMPLE_LEDGER_CAP = 64;
const STYLE_EXAMPLE_LEDGER_MAX_CHARS = 256_000;

/** Compact local taste signal. It contains no project or note payload. */
export interface StyleExampleV1 {
  version: typeof STYLE_EXAMPLE_LEDGER_VERSION;
  contentHash: string;
  savedAt: number;
  genre: string;
  grooveId: string;
  energy: number;
  density: number;
  complexity: number;
  variation: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidStyleExample(value: unknown): value is StyleExampleV1 {
  if (!isRecord(value)) return false;
  const unit = (field: unknown): field is number =>
    typeof field === "number" && Number.isFinite(field) && field >= 0 && field <= 1;
  return (
    value.version === STYLE_EXAMPLE_LEDGER_VERSION &&
    typeof value.contentHash === "string" &&
    /^[a-f0-9]{8}$/.test(value.contentHash) &&
    typeof value.savedAt === "number" &&
    Number.isFinite(value.savedAt) &&
    value.savedAt >= 0 &&
    typeof value.genre === "string" &&
    (GENRES as readonly string[]).includes(value.genre) &&
    typeof value.grooveId === "string" &&
    /^[a-zA-Z0-9._:-]{0,128}$/.test(value.grooveId) &&
    unit(value.energy) &&
    unit(value.density) &&
    unit(value.complexity) &&
    unit(value.variation)
  );
}

function safeRead(): StyleExampleV1[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(STYLE_EXAMPLE_LEDGER_KEY);
    if (!raw || raw.length > STYLE_EXAMPLE_LEDGER_MAX_CHARS) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidStyleExample).slice(-STYLE_EXAMPLE_LEDGER_CAP);
  } catch {
    return [];
  }
}

function safeWrite(examples: readonly StyleExampleV1[]): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(STYLE_EXAMPLE_LEDGER_KEY, JSON.stringify(examples));
    return true;
  } catch {
    return false;
  }
}

function notifyChanged(): void {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(STYLE_EXAMPLES_CHANGED_EVENT));
  } catch {
    /* storage/UI notification is best-effort */
  }
}

/** Automatic capture is local-only and defaults on, as requested by the user. */
export function automaticStyleLearningEnabled(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(STYLE_AUTO_LEARN_KEY) !== "off";
  } catch {
    return false;
  }
}

export function setAutomaticStyleLearningEnabled(enabled: boolean): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(STYLE_AUTO_LEARN_KEY, enabled ? "on" : "off");
    notifyChanged();
    return true;
  } catch {
    return false;
  }
}

/** Last genre explicitly requested in Intent, used only when a manual pattern has no genre metadata. */
export function setPreferredStyleGenre(genre: string): void {
  try {
    if ((GENRES as readonly string[]).includes(genre)) localStorage.setItem(STYLE_PREFERRED_GENRE_KEY, genre);
  } catch {
    /* optional context */
  }
}

export function preferredStyleGenre(): string | null {
  try {
    const value = localStorage.getItem(STYLE_PREFERRED_GENRE_KEY);
    return value && (GENRES as readonly string[]).includes(value) ? value : null;
  } catch {
    return null;
  }
}

export function readStyleExamples(): StyleExampleV1[] {
  return safeRead();
}

/** Re-teaching the same content in the same genre refreshes its timestamp. */
export function recordStyleExample(example: StyleExampleV1): boolean {
  if (!isValidStyleExample(example)) return false;
  const retained = safeRead().filter(
    (existing) => existing.contentHash !== example.contentHash || existing.genre !== example.genre,
  );
  const next = [...retained, example];
  const saved = safeWrite(next.slice(-STYLE_EXAMPLE_LEDGER_CAP));
  if (saved) notifyChanged();
  return saved;
}

/** Merge explicitly imported compact style examples by content and genre. */
export function mergeStyleExamples(examples: readonly unknown[]): boolean {
  const merged = safeRead();
  for (const value of examples) {
    if (!isValidStyleExample(value)) continue;
    const next = merged.filter(
      (existing) => existing.contentHash !== value.contentHash || existing.genre !== value.genre,
    );
    next.push(value);
    merged.splice(0, merged.length, ...next.slice(-STYLE_EXAMPLE_LEDGER_CAP));
  }
  const saved = safeWrite(merged);
  if (saved) notifyChanged();
  return saved;
}

export function countStyleExamples(): number {
  return safeRead().length;
}

export function clearStyleExamples(): boolean {
  const cleared = safeWrite([]);
  if (cleared) {
    try {
      localStorage.removeItem(STYLE_PREFERRED_GENRE_KEY);
      if (typeof window !== "undefined") window.dispatchEvent(new Event(STYLE_EXAMPLES_CLEARED_EVENT));
    } catch {
      /* clear remains successful if notification is unavailable */
    }
    notifyChanged();
  }
  return cleared;
}
