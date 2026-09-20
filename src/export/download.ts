/**
 * Trigger a browser download for a generated Blob. Extracted from
 * ExportPanel so share surfaces beyond the export panel (IntentPanel share
 * CTA, gallery, …) reuse one implementation.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL?.(url), 5000);
}
