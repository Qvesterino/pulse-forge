/** Semantic role used by the local drum quality rules. */
export type PadRole =
  | 'kick'
  | 'snare'
  | 'clap'
  | 'closedHat'
  | 'openHat'
  | 'perc'
  | 'tom'
  | 'fx'
  | 'unknown';

const INDEX_FALLBACKS: readonly PadRole[] = [
  'kick', 'kick', 'kick', 'perc',
  'snare', 'snare', 'clap', 'perc',
  'closedHat', 'closedHat', 'openHat', 'openHat',
  'tom', 'tom', 'perc', 'fx',
];

/** Infer a stable semantic role from kit metadata, with legacy-index fallback. */
export function inferPadRole(name: string | undefined, padIndex: number): PadRole {
  const normalized = (name ?? '').trim().toLowerCase();
  if (normalized) {
    if (/kick|bass drum|bd/.test(normalized)) return 'kick';
    if (/snare|rim|side stick/.test(normalized)) return 'snare';
    if (/clap|拍/.test(normalized)) return 'clap';
    if (/open hat|openhat|ohat|ride|crash/.test(normalized)) return 'openHat';
    if (/hat|hihat|hi-hat|shaker|tambourine/.test(normalized)) return 'closedHat';
    if (/tom|conga|bongo/.test(normalized)) return 'tom';
    if (/fx|blip|noise|impact|bell/.test(normalized)) return 'fx';
    if (/perc|rim|tick|clave|wood/.test(normalized)) return 'perc';
  }
  return INDEX_FALLBACKS[padIndex] ?? 'unknown';
}

export function canRatchet(role: PadRole): boolean {
  return role === 'closedHat' || role === 'openHat' || role === 'perc' || role === 'fx';
}

/** Ghost-note probability multiplier by semantic role. */
export function ghostMultiplier(role: PadRole): number {
  switch (role) {
    case 'snare': return 0.9;
    case 'clap': return 0.75;
    case 'perc': return 0.65;
    case 'tom': return 0.45;
    case 'closedHat': return 0.3;
    case 'openHat': return 0.15;
    case 'kick': return 0.08;
    case 'fx': return 0.2;
    default: return 0.4;
  }
}
