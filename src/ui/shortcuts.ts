/**
 * Centralized keyboard shortcut definitions.
 *
 * Each shortcut describes an intent at the level of user-visible verbs
 * ("toggle transport", "select track +1"). The matcher normalizes browser
 * event quirks (case, modifier order) so consumers can do plain equality.
 */

export type ShortcutKey =
  | "playPause"
  | "stop"
  | "undo"
  | "redo"
  | "save"
  | "toggleLoop"
  | "duplicatePattern"
  | "deleteNote"
  | "nextTrack"
  | "prevTrack"
  | "selectTrack1"
  | "selectTrack2"
  | "selectTrack3"
  | "selectTrack4"
  | "selectTrack5"
  | "selectTrack6"
  | "selectTrack7"
  | "selectTrack8"
  | "selectTrack9"
  | "toggleMuteTrack"
  | "toggleSoloTrack"
  | "panelMix"
  | "panelFx"
  | "panelArr"
  | "panelMod"
  | "panelExport"
  | "panelDice"
  | "nextPattern"
  | "prevPattern"
  | "seekHome"
  | "seekBack"
  | "seekForward"
  | "toggleHelp";

/**
 * Panel toggles → bottom-panel ids. Kept here (not derived by slicing the
 * shortcut name): panel ids are app vocabulary ("exp" is the export panel)
 * and a mechanical `slice(5).toLowerCase()` produced an id that matched
 * nothing, making Alt+5 silently close the dock.
 */
export const PANEL_IDS_BY_SHORTCUT: Record<string, string> = {
  panelMix: "mixer",
  // Kept as the shortcut key name for Alt+2; App canonicalizes this legacy id
  // to the unified Devices panel.
  panelFx: "fx",
  panelArr: "arr",
  panelMod: "mod",
  panelExport: "exp",
  panelDice: "dice",
};

export function panelIdOfShortcut(key: ShortcutKey): string | null {
  return PANEL_IDS_BY_SHORTCUT[key] ?? null;
}

export interface Shortcut {
  key: ShortcutKey;
  /** Human-readable label for the help overlay. */
  label: string;
  /** Group label for organizing the help overlay. */
  group: "Transport" | "Tracks" | "Patterns" | "Panels" | "Sequencer" | "Help";
  /** Primary key (lowercased). */
  keyHint: string;
  /** Modifiers required for the primary key. */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  /**
   * Optional alternative bindings (e.g. Space for play, but also a labelled
   * chord). The first alternative is shown in the help overlay.
   */
  altHints?: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }[];
}

export const SHORTCUTS: Shortcut[] = [
  {
    key: "playPause",
    label: "Play / Pause",
    group: "Transport",
    keyHint: "Space",
    altHints: [{ key: " " }],
  },
  // keyHint must equal the literal event.key ("Escape", not "Esc") — the
  // matcher lowercases but does not alias key names.
  { key: "stop", label: "Stop (clears help/selection first)", group: "Transport", keyHint: "Escape" },
  { key: "seekHome", label: "Return to start", group: "Transport", keyHint: "Home" },
  { key: "seekBack", label: "Nudge −1 bar", group: "Transport", keyHint: "," },
  { key: "seekForward", label: "Nudge +1 bar", group: "Transport", keyHint: "." },
  {
    key: "save",
    label: "Force save",
    group: "Transport",
    keyHint: "S",
    ctrl: true,
    altHints: [{ key: "s", ctrl: true }],
  },
  { key: "toggleLoop", label: "Toggle loop region", group: "Transport", keyHint: "L" },
  { key: "undo", label: "Undo", group: "Transport", keyHint: "Z", ctrl: true, altHints: [{ key: "z", ctrl: true }] },
  {
    key: "redo",
    label: "Redo",
    group: "Transport",
    keyHint: "Y",
    ctrl: true,
    altHints: [
      { key: "y", ctrl: true },
      { key: "z", ctrl: true, shift: true },
    ],
  },

  { key: "nextTrack", label: "Next track", group: "Tracks", keyHint: "Tab" },
  { key: "prevTrack", label: "Previous track", group: "Tracks", keyHint: "Tab", shift: true },
  { key: "selectTrack1", label: "Select track 1", group: "Tracks", keyHint: "1" },
  { key: "selectTrack2", label: "Select track 2", group: "Tracks", keyHint: "2" },
  { key: "selectTrack3", label: "Select track 3", group: "Tracks", keyHint: "3" },
  { key: "selectTrack4", label: "Select track 4", group: "Tracks", keyHint: "4" },
  { key: "selectTrack5", label: "Select track 5", group: "Tracks", keyHint: "5" },
  { key: "selectTrack6", label: "Select track 6", group: "Tracks", keyHint: "6" },
  { key: "selectTrack7", label: "Select track 7", group: "Tracks", keyHint: "7" },
  { key: "selectTrack8", label: "Select track 8", group: "Tracks", keyHint: "8" },
  { key: "selectTrack9", label: "Select track 9", group: "Tracks", keyHint: "9" },
  { key: "toggleMuteTrack", label: "Mute selected track", group: "Tracks", keyHint: "M", alt: true },
  { key: "toggleSoloTrack", label: "Solo selected track", group: "Tracks", keyHint: "S", alt: true },

  { key: "nextPattern", label: "Next pattern", group: "Patterns", keyHint: "PageDown" },
  { key: "prevPattern", label: "Previous pattern", group: "Patterns", keyHint: "PageUp" },
  {
    key: "duplicatePattern",
    label: "Duplicate active pattern",
    group: "Patterns",
    keyHint: "D",
    ctrl: true,
    altHints: [{ key: "d", ctrl: true }],
  },

  // Bare digits 1–9 select tracks; panels live on Alt+1–5. Both families
  // previously bound the bare 1–5 keys — the map silently kept only the
  // panels, so "select track 1–5" was dead while 6–9 still worked.
  { key: "panelMix", label: "Toggle mixer panel", group: "Panels", keyHint: "1", alt: true },
  { key: "panelFx", label: "Toggle track devices", group: "Panels", keyHint: "2", alt: true },
  { key: "panelArr", label: "Toggle arrangement", group: "Panels", keyHint: "3", alt: true },
  { key: "panelMod", label: "Toggle modulation", group: "Panels", keyHint: "4", alt: true },
  { key: "panelExport", label: "Toggle export", group: "Panels", keyHint: "5", alt: true },
  { key: "panelDice", label: "Toggle dice panel", group: "Panels", keyHint: "6", alt: true },

  { key: "deleteNote", label: "Delete selected note / clear selected steps", group: "Sequencer", keyHint: "Delete" },

  { key: "toggleHelp", label: "Show / hide this help", group: "Help", keyHint: "?" },
];

const SHORTCUT_BY_KEY: Record<string, ShortcutKey> = (() => {
  const out: Record<string, ShortcutKey> = {};
  for (const sc of SHORTCUTS) {
    out[primarySignature(sc)] = sc.key;
    for (const alt of sc.altHints ?? []) {
      out[signature(alt.key, alt.ctrl, alt.shift, alt.alt, alt.meta)] = sc.key;
    }
  }
  return out;
})();

function signature(key: string, ctrl?: boolean, shift?: boolean, alt?: boolean, meta?: boolean): string {
  return `${ctrl ? "C" : "."}${shift ? "S" : "."}${alt ? "A" : "."}${meta ? "M" : "."}|${key.toLowerCase()}`;
}

function primarySignature(sc: Shortcut): string {
  return signature(sc.keyHint, sc.ctrl, sc.shift, sc.alt, sc.meta);
}

/** Every signature a shortcut answers to (primary + alternatives). */
export function shortcutSignatures(sc: Shortcut): string[] {
  return [
    primarySignature(sc),
    ...(sc.altHints ?? []).map((alt) => signature(alt.key, alt.ctrl, alt.shift, alt.alt, alt.meta)),
  ];
}

/**
 * Match a KeyboardEvent against the registered shortcuts.
 * Returns the matched ShortcutKey, or null.
 *
 * The match is conservative: if a modifier is set on the shortcut, the event
 * must have it; if no modifier is set, the event must NOT have it (so plain
 * typing in inputs is not hijacked).
 */
export function matchShortcut(event: KeyboardEvent): ShortcutKey | null {
  const key = event.key === " " ? " " : event.key;
  // `?` is reported as "?" with shift on most layouts — but if shift is the
  // ONLY modifier we still want to match. Make "?" tolerant.
  const isQuestionMark = event.key === "?" && !event.ctrlKey && !event.altKey && !event.metaKey;
  const sig = signature(
    isQuestionMark ? "?" : key,
    event.ctrlKey,
    event.shiftKey && isQuestionMark ? false : event.shiftKey,
    event.altKey,
    event.metaKey,
  );
  // Direct lookup
  const direct = SHORTCUT_BY_KEY[sig];
  if (direct) return direct;
  // "?" fallback
  if (isQuestionMark) {
    const alt = SHORTCUT_BY_KEY[signature("?", false, false, false, false)];
    if (alt) return alt;
  }
  return null;
}

/** Group shortcuts for the help overlay. */
export function groupShortcuts(): { group: Shortcut["group"]; items: Shortcut[] }[] {
  const order: Shortcut["group"][] = ["Transport", "Tracks", "Patterns", "Panels", "Sequencer", "Help"];
  const byGroup = new Map<Shortcut["group"], Shortcut[]>();
  for (const sc of SHORTCUTS) {
    const list = byGroup.get(sc.group) ?? [];
    list.push(sc);
    byGroup.set(sc.group, list);
  }
  return order.filter((g) => byGroup.has(g)).map((g) => ({ group: g, items: byGroup.get(g)! }));
}

/**
 * Build a display string for a shortcut, e.g. "Ctrl + Z" or "Alt + M".
 * Uses the primary keyHint and its modifiers.
 */
export function formatShortcut(sc: Shortcut): string {
  return formatBinding({
    key: sc.keyHint,
    ctrl: sc.ctrl,
    shift: sc.shift,
    alt: sc.alt,
    meta: sc.meta,
  });
}

/** Format one binding (primary or alternative) — "Ctrl + Shift + Z". */
export function formatBinding(binding: {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  if (binding.meta) parts.push("Meta");
  // Single-character keys display uppercase ("Ctrl + Z"), named keys keep
  // their canonical form ("Escape", "PageDown").
  const key = binding.key === " " ? "Space" : binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
  parts.push(key);
  return parts.join(" + ");
}

/** All display strings for a shortcut: primary first, then unique alternatives. */
export function shortcutDisplayBindings(sc: Shortcut): string[] {
  const out: string[] = [];
  for (const binding of [formatShortcut(sc), ...(sc.altHints ?? []).map((alt) => formatBinding(alt))]) {
    if (!out.includes(binding)) out.push(binding);
  }
  return out;
}
