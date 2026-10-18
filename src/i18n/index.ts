/**
 * i18n SKELETON (Prestige plan §3.3) — the mechanism, not a big-bang migration.
 *
 * The app grew its user-facing copy in two languages at once (Slovak prose in
 * panels, English in tooltips and diagnostics). This is the smallest honest
 * mechanism that lets panels migrate ONE AT A TIME:
 *
 *  - a TYPED catalog: `MESSAGES` is `Record<MessageKey, …>`, so TypeScript
 *    refuses a missing key at compile time — the completeness pin costs no test;
 *  - `t(key, vars)` reads the current locale at call time, falls back to EN when
 *    a translation is missing (a partial translation must never render an empty
 *    label), and finally falls back to the KEY itself — visible, never silent;
 *  - `useLocale()` subscribes a component to language changes.
 *
 * The first migrated panel is PublishButton (see docs on the pattern): it reads
 * every string through `t()`, so its English output is byte-identical to before
 * and a Slovak catalog entry switches it. Panels migrate one by one; nothing
 * here rewrites a panel that has not been migrated on purpose.
 */
import { useSyncExternalStore } from "react";

export type Locale = "en" | "sk";

export const LOCALE_STORAGE_KEY = "pf-locale";

/** Every message the migrated surfaces use. Flat on purpose: greppable. */
export const MESSAGES = {
  "publish.cta": {
    en: "PUBLISH TO GALLERY",
    sk: "PUBLIKOVAŤ DO GALÉRIE",
  },
  "publish.title": {
    en: "Drop this beat into the public Beat Gallery (tags + playable embed)",
    sk: "Pošli tento beat do verejnej Beat Galérie (tagy + embed na prehratie)",
  },
  "publish.tooLarge": {
    en: "This project is too large to hand off — export it as a file instead.",
    sk: "Projekt je príliš veľký na odovzdanie — exportuj ho ako súbor.",
  },
  "publish.storageBlocked": {
    en: "The browser blocked temporary storage — allow site data, or export the project instead.",
    sk: "Prehliadač zablokoval dočasné úložisko — povoľ dáta stránky, alebo projekt exportuj.",
  },
} as const;

export type MessageKey = keyof typeof MESSAGES;

let locale: Locale = "en";
let loaded = false;
const listeners = new Set<() => void>();

function readStoredLocale(): Locale {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY) === "sk" ? "sk" : "en";
  } catch {
    return "en";
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  locale = readStoredLocale();
}

export function getLocale(): Locale {
  ensureLoaded();
  return locale;
}

export function setLocale(next: Locale): void {
  ensureLoaded();
  if (next === locale) return;
  locale = next;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    /* storage blocked — the switch still applies to this session */
  }
  for (const listener of [...listeners]) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render a component when the language changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

export type MessageVars = Record<string, string | number>;

/**
 * Translate a key. Falls back to EN for a missing translation and to the KEY
 * itself when the key is unknown — an empty label is never rendered.
 */
export function t(key: MessageKey, vars?: MessageVars): string {
  ensureLoaded();
  const entry = MESSAGES[key] as Record<string, string | undefined> | undefined;
  const template = entry?.[locale] ?? entry?.en ?? key;
  if (vars == null) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** Test/teardown hook — the locale is per-window by design. */
export function resetLocaleForTests(): void {
  locale = "en";
  loaded = false;
  listeners.clear();
}
