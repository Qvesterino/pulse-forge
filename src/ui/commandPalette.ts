/**
 * Command Palette — the Ctrl+K action registry.
 *
 * Every keyboard action from the active shortcut table becomes a palette entry
 * automatically (zero duplication: titles, groups and binding hints come
 * from the same source the help overlay uses), plus a few palette-only
 * actions that have no keybinding (snapshot, gallery…).
 *
 * The fuzzy filter is deliberately tiny: sequential subsequence match with
 * bonuses for word-start and contiguous hits — good enough to feel instant
 * on a ~40-item registry without pulling in a library.
 */
import { formatShortcut, getActiveShortcuts, type Shortcut, type ShortcutKey } from "./shortcuts";
import { DAW_ACTION_MAPPINGS, DAW_PROFILE_OPTIONS, readDawProfile } from "./dawProfile";
import type { ProjectTransferSourceDaw } from "../project-model/types";

export interface PaletteAction {
  id: string;
  title: string;
  group: string;
  /** Extra searchable words beyond the title (e.g. "mp3 bounce render"). */
  keywords?: string;
  /** Primary keybinding, shown as a hint when the action has one. */
  binding?: string;
  /** Familiar source-DAW wording for the active profile, shown under the KYX action. */
  profileHint?: string;
  run: () => void;
}

export interface PaletteDeps {
  runShortcut: (key: ShortcutKey) => void;
  snapshotNow: () => void;
  openGallery: () => void;
  toggleHistoryPanel: () => void;
  toggleDiagnostics: () => void;
  dawProfile?: ProjectTransferSourceDaw | null;
}

/** Build the full action list from the shortcut table + palette-only extras. */
export function buildPaletteActions(deps: PaletteDeps): PaletteAction[] {
  const profile = readDawProfile() ?? deps.dawProfile ?? null;
  const profileLabel = DAW_PROFILE_OPTIONS.find(({ id }) => id === profile)?.label;
  const mappingsByShortcut = new Map<ShortcutKey, (typeof DAW_ACTION_MAPPINGS)[number][]>();
  if (profile && profileLabel) {
    for (const mapping of DAW_ACTION_MAPPINGS) {
      for (const key of mapping.shortcutKeys ?? []) {
        const mappings = mappingsByShortcut.get(key) ?? [];
        mappings.push(mapping);
        mappingsByShortcut.set(key, mappings);
      }
    }
  }

  const fromShortcuts: PaletteAction[] = getActiveShortcuts().map((sc: Shortcut) => {
    const mappings = mappingsByShortcut.get(sc.key) ?? [];
    const familiarTerms = mappings.map((mapping) => mapping.familiarTerm[profile!]);
    const mappingHint = mappings[0];
    return {
      id: `shortcut:${sc.key}`,
      title: sc.label,
      group: sc.group,
      keywords: [
        sc.key,
        ...familiarTerms,
        ...mappings.map((mapping) => mapping.action),
        ...mappings.map((mapping) => mapping.kyxTerm),
      ].join(" "),
      binding: formatShortcut(sc),
      profileHint:
        profileLabel && mappingHint
          ? `${profileLabel}: ${mappingHint.familiarTerm[profile!]} → ${mappingHint.kyxTerm}`
          : undefined,
      run: () => deps.runShortcut(sc.key),
    };
  });

  const extras: PaletteAction[] = [
    {
      id: "extra:snapshot",
      title: "Save a project snapshot now",
      group: "Project",
      keywords: "snapshot backup version history restore point",
      run: deps.snapshotNow,
    },
    {
      id: "extra:gallery",
      title: "Open Beat Gallery",
      group: "Share",
      keywords: "gallery community beats publish browse fork",
      run: deps.openGallery,
    },
    {
      id: "extra:history",
      title: "Toggle undo history panel",
      group: "Panels",
      keywords: "history undo log jump",
      run: deps.toggleHistoryPanel,
    },
    {
      id: "extra:diagnostics",
      title: "Toggle diagnostics overlay",
      group: "Panels",
      keywords: "diagnostics debug engine status",
      run: deps.toggleDiagnostics,
    },
  ];

  return [...fromShortcuts, ...extras];
}

/**
 * Sequential fuzzy score. Returns −1 when the needle is not a subsequence
 * of the haystack; otherwise higher = better (contiguous and word-start
 * character hits outrank scattered ones).
 */
export function fuzzyScore(haystack: string, needle: string): number {
  const hay = haystack.toLowerCase();
  const nee = needle.toLowerCase().trim();
  if (!nee) return 0;
  let score = 0;
  let hayIdx = 0;
  let lastHit = -2;
  for (let i = 0; i < nee.length; i++) {
    const char = nee[i];
    const found = hay.indexOf(char, hayIdx);
    if (found === -1) return -1;
    score += 1;
    if (found === lastHit + 1) score += 3; // contiguous run
    if (found === 0 || /[\s+/·:&-]/.test(hay[found - 1] ?? " ")) score += 2; // word start
    lastHit = found;
    hayIdx = found + 1;
  }
  // Prefer shorter haystacks on equal structure ("solo" → "Solo selected track").
  score += Math.max(0, 8 - Math.floor(hay.length / 16));
  return score;
}

/** Filter + rank actions for the query. Empty query returns all, unranked. */
export function filterActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const nee = query.trim();
  if (!nee) return actions;
  const scored: Array<{ action: PaletteAction; score: number }> = [];
  for (const action of actions) {
    const searchable = [action.title, action.group, action.keywords ?? "", action.binding ?? ""];
    let best = -1;
    for (const field of searchable) {
      const score = fuzzyScore(field, nee);
      // Title hits outrank keyword hits on the same score.
      const bonus = field === action.title ? 4 : field === action.group ? 1 : 0;
      if (score >= 0 && score + bonus > best) best = score + bonus;
    }
    if (best >= 0) scored.push({ action, score: best });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.action);
}
