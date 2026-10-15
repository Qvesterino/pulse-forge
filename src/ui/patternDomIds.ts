export const ACTIVE_PATTERN_PANEL_ID = "kyx-active-pattern-panel";

export function patternTabDomId(patternId: string): string {
  return `kyx-pattern-tab-${encodeURIComponent(patternId)}`;
}
