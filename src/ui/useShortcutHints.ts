import { useMemo, useSyncExternalStore } from "react";
import {
  getActiveShortcuts,
  shortcutBindingsRevision,
  shortcutDisplayBindings,
  subscribeShortcutBindings,
  type Shortcut,
  type ShortcutKey,
} from "./shortcuts";

export interface ShortcutHints {
  get: (key: ShortcutKey) => Shortcut | undefined;
  label: (key: ShortcutKey, includeAlternatives?: boolean) => string;
  aria: (key: ShortcutKey) => string | undefined;
}

function compact(binding: string): string {
  return binding.replace(/\s*\+\s*/g, "+");
}

function ariaBinding(binding: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Control");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  if (binding.meta) parts.push("Meta");
  const key = binding.key === " " ? "Space" : binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
  parts.push(key);
  return parts.join("+");
}

/** Read live shortcut definitions so UI hints follow user remaps immediately. */
export function useShortcutHints(): ShortcutHints {
  const revision = useSyncExternalStore(subscribeShortcutBindings, shortcutBindingsRevision, shortcutBindingsRevision);

  return useMemo(() => {
    const byKey = new Map(getActiveShortcuts().map((shortcut) => [shortcut.key, shortcut]));
    const get = (key: ShortcutKey) => byKey.get(key);
    return {
      get,
      label: (key: ShortcutKey, includeAlternatives = false) => {
        const shortcut = get(key);
        if (!shortcut) return "";
        const bindings = shortcutDisplayBindings(shortcut);
        return (includeAlternatives ? bindings : bindings.slice(0, 1)).map(compact).join(" / ");
      },
      aria: (key: ShortcutKey) => {
        const shortcut = get(key);
        if (!shortcut) return undefined;
        return [ariaBinding(shortcut), ...(shortcut.altHints ?? []).map((binding) => ariaBinding(binding))].join(" ");
      },
    };
  }, [revision]);
}
