import { IncrementalSha256 } from "./sha256";

const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_FINGERPRINT_BYTES = 512 * 1024 * 1024;

interface WorkerScope extends EventTarget {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}

const scope = self as unknown as WorkerScope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fingerprintBlob(blob: Blob, requestId: number): Promise<void> {
  if (blob.size <= 0 || blob.size > MAX_FINGERPRINT_BYTES) {
    scope.postMessage({
      type: "MASTER_FINGERPRINT_UNAVAILABLE",
      requestId,
      reason:
        blob.size <= 0
          ? "The exported file is empty."
          : `The file exceeds the ${Math.floor(MAX_FINGERPRINT_BYTES / (1024 * 1024))} MiB bounded fingerprint limit.`,
    });
    return;
  }

  const sha256 = new IncrementalSha256();
  for (let offset = 0; offset < blob.size; offset += READ_CHUNK_BYTES) {
    const end = Math.min(blob.size, offset + READ_CHUNK_BYTES);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    if (chunk.byteLength !== end - offset) throw new Error("The exported file changed while it was fingerprinted.");
    sha256.update(chunk);
    scope.postMessage({ type: "MASTER_FINGERPRINT_PROGRESS", requestId, progress: end / blob.size });
  }
  scope.postMessage({ type: "MASTER_FINGERPRINT_RESULT", requestId, sha256: sha256.digestHex() });
}

scope.onmessage = (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (!isRecord(data) || data.type !== "MASTER_FINGERPRINT_START") return;
  if (!Number.isSafeInteger(data.requestId) || (data.requestId as number) <= 0) return;
  const requestId = data.requestId as number;
  if (typeof Blob === "undefined" || !(data.blob instanceof Blob)) {
    scope.postMessage({
      type: "MASTER_FINGERPRINT_ERROR",
      requestId,
      message: "The fingerprint worker requires a file Blob.",
    });
    return;
  }
  void fingerprintBlob(data.blob, requestId).catch((error: unknown) => {
    scope.postMessage({
      type: "MASTER_FINGERPRINT_ERROR",
      requestId,
      message: error instanceof Error ? error.message.slice(0, 500) : "The fingerprint worker failed.",
    });
  });
};
