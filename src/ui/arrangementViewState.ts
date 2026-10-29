/**
 * CF-11 — per-project arrangement view state that survives the ARR dock tab
 * closing (the panel unmounts on every re-route) and a page reload.
 *
 * View-layer policy, same as snap: localStorage, never the document. Keyed by
 * PROJECT id so switching projects cannot leak one project's geometry into
 * another. Every field is defensively re-validated on load — a malformed or
 * hand-edited payload degrades to "no saved view" instead of throwing.
 */

export interface ArrangementViewState {
  zoom: number;
  scrollLeft: number;
  selectedClipId: string | null;
  selectedAudioClipId: string | null;
}

const PREFIX = "pf:arr-view:";

export function loadArrangementViewState(docId: string): Partial<ArrangementViewState> {
  try {
    const raw = localStorage.getItem(PREFIX + docId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<ArrangementViewState>;
    const out: Partial<ArrangementViewState> = {};
    if (typeof parsed.zoom === "number" && Number.isFinite(parsed.zoom) && parsed.zoom > 0) out.zoom = parsed.zoom;
    if (typeof parsed.scrollLeft === "number" && Number.isFinite(parsed.scrollLeft) && parsed.scrollLeft >= 0) {
      out.scrollLeft = parsed.scrollLeft;
    }
    if (typeof parsed.selectedClipId === "string") out.selectedClipId = parsed.selectedClipId;
    if (typeof parsed.selectedAudioClipId === "string") out.selectedAudioClipId = parsed.selectedAudioClipId;
    return out;
  } catch {
    return {};
  }
}

export function saveArrangementViewState(docId: string, state: ArrangementViewState): void {
  try {
    localStorage.setItem(PREFIX + docId, JSON.stringify(state));
  } catch {
    // Quota/private mode must not break editing — the view state is a comfort.
  }
}
