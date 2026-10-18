/**
 * Trigger a browser download for a generated Blob. Extracted from
 * ExportPanel so share surfaces beyond the export panel (IntentPanel share
 * CTA, gallery, …) reuse one implementation.
 *
 * This is THE save boundary for every artifact export (project JSON, WAV,
 * MIDI, packs, favorites): a non-DOM shell replaces file saving in exactly
 * one place. The Electron shell intercepts the anchor click via
 * `will-download`; the Android shell (ADR 0052) provides a SAF
 * `saveDocument` through `window.kyxNative.files`, which is preferred when
 * present. Without a bridge the anchor path is unchanged. The 5 s revoke
 * delay is the repo-wide safety net — Safari needs the URL alive until after
 * the click has been processed.
 */
import { getNativeFilesBridge } from "../mobile/nativeBridge";
import { saveBlobViaNative } from "../mobile/nativeFiles";

function browserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL?.(url), 5000);
}

export function downloadBlob(blob: Blob, filename: string): void {
  if (getNativeFilesBridge()) {
    // SAF must be able to show its own create-document UI. If it fails or the
    // user cancels, fall back to the browser download path.
    void saveBlobViaNative(blob, filename).then((saved) => {
      if (!saved) browserDownload(blob, filename);
    });
    return;
  }
  browserDownload(blob, filename);
}
