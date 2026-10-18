/**
 * SAF bridge helpers (ADR 0052).
 *
 * The native shell exposes Android's Storage Access Framework through
 * `window.kyxNative.files`. `downloadBlob` uses `saveDocument` as its save
 * path when the bridge exists; `pickDocuments` is the explicit SAF import
 * path for surfaces that need it (large WAV packs, folder-like flows).
 *
 * Everything here is a no-op/empty result without a bridge so the PWA keeps
 * its normal anchor-download and `<input type=file>` behavior.
 */
import { getNativeFilesBridge } from "./nativeBridge";

export function hasNativeFileSave(): boolean {
  return getNativeFilesBridge() !== null;
}

export async function saveBlobViaNative(blob: Blob, filename: string): Promise<boolean> {
  const bridge = getNativeFilesBridge();
  if (!bridge) return false;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await bridge.saveDocument({
      name: filename,
      mimeType: blob.type || "application/octet-stream",
      bytes,
    });
    return result?.saved !== false;
  } catch (error) {
    console.warn("[native-files] SAF save failed, falling back to browser download:", error);
    return false;
  }
}

export async function pickNativeFiles(options?: { mimeTypes?: string[]; multiple?: boolean }): Promise<File[]> {
  const bridge = getNativeFilesBridge();
  if (!bridge) return [];
  try {
    const payloads = await bridge.pickDocuments(options);
    const files: File[] = [];
    for (const payload of payloads ?? []) {
      if (!payload || typeof payload.name !== "string" || !payload.name) continue;
      const raw = payload.bytes;
      const bytes = raw instanceof Uint8Array ? raw : Array.isArray(raw) ? Uint8Array.from(raw) : null;
      if (!bytes?.length) continue;
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      files.push(new File([copy.buffer], payload.name, { type: payload.mimeType || "application/octet-stream" }));
    }
    return files;
  } catch (error) {
    console.warn("[native-files] SAF open failed:", error);
    return [];
  }
}
