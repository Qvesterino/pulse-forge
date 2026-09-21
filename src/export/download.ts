/**
 * Trigger a browser download for a generated Blob. Extracted from
 * ExportPanel so share surfaces beyond the export panel (IntentPanel share
 * CTA, gallery, …) reuse one implementation.
 *
 * This is THE save boundary for every artifact export (project JSON, WAV,
 * MIDI, packs, favorites): a non-DOM shell replaces file saving in exactly
 * one place (the Electron shell already intercepts the anchor click via the
 * `will-download` event). The 5 s revoke delay is the repo-wide safety net —
 * Safari needs the URL alive until after the click has been processed.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL?.(url), 5000);
}
