import type { MasterAnalysisProgressListener } from "./analysis";

const WORKER_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_MASTER_FINGERPRINT_BYTES = 512 * 1024 * 1024;
let nextRequestId = 1;

export interface EncodedMasterFingerprint {
  algorithm: "SHA-256";
  status: "computed" | "not-computed";
  hex: string | null;
  reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitProgress(onProgress: MasterAnalysisProgressListener | undefined, progress: number): void {
  try {
    onProgress?.({ progress: Math.max(0, Math.min(1, progress)), stage: "Fingerprinting the encoded file" });
  } catch {
    // Progress UI must never fail the delivery check.
  }
}

function unavailable(reason: string): EncodedMasterFingerprint {
  return { algorithm: "SHA-256", status: "not-computed", hex: null, reason };
}

function abortError(): DOMException {
  return new DOMException("Master fingerprint cancelled", "AbortError");
}

/** Hash the exact delivery Blob in bounded chunks without creating a second whole-file buffer. */
export function fingerprintEncodedMasterAsync(
  blob: Blob,
  options: { signal?: AbortSignal; onProgress?: MasterAnalysisProgressListener } = {},
): Promise<EncodedMasterFingerprint> {
  const { signal, onProgress } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  if (!(blob instanceof Blob) || blob.size <= 0) return Promise.resolve(unavailable("The exported file is empty."));
  if (blob.size > MAX_MASTER_FINGERPRINT_BYTES) {
    return Promise.resolve(
      unavailable(
        `The file exceeds the ${Math.floor(MAX_MASTER_FINGERPRINT_BYTES / (1024 * 1024))} MiB fingerprint limit.`,
      ),
    );
  }
  if (typeof Worker === "undefined") return Promise.resolve(unavailable("This browser cannot run the SHA-256 worker."));

  let worker: Worker;
  try {
    worker = new Worker(new URL("./fingerprintWorker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    return Promise.resolve(
      unavailable(`Could not start the SHA-256 worker: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  const requestId = nextRequestId++;
  return new Promise<EncodedMasterFingerprint>((resolve, reject) => {
    let settled = false;
    let lastProgressPercent = -1;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener: () => void = () => undefined;
    const finish = (result?: EncodedMasterFingerprint, error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (watchdog !== null) clearTimeout(watchdog);
      removeAbortListener();
      worker.terminate();
      if (error !== undefined) reject(error);
      else resolve(result ?? unavailable("The SHA-256 worker returned no fingerprint."));
    };
    const resetWatchdog = (): void => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(
        () => finish(undefined, new Error("The SHA-256 worker stopped responding for 3 minutes.")),
        WORKER_IDLE_TIMEOUT_MS,
      );
    };

    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isRecord(event.data) || event.data.requestId !== requestId || typeof event.data.type !== "string") return;
      const message = event.data;
      if (message.type === "MASTER_FINGERPRINT_PROGRESS") {
        if (
          typeof message.progress === "number" &&
          Number.isFinite(message.progress) &&
          message.progress >= 0 &&
          message.progress <= 1
        ) {
          resetWatchdog();
          const progressPercent = Math.floor(message.progress * 100);
          if (progressPercent !== lastProgressPercent || progressPercent === 100) {
            lastProgressPercent = progressPercent;
            emitProgress(onProgress, message.progress);
          }
        }
        return;
      }
      if (message.type === "MASTER_FINGERPRINT_UNAVAILABLE") {
        const reason =
          typeof message.reason === "string" ? message.reason.slice(0, 500) : "The file could not be fingerprinted.";
        finish(unavailable(reason));
        return;
      }
      if (message.type === "MASTER_FINGERPRINT_ERROR") {
        const reason =
          typeof message.message === "string" ? message.message.slice(0, 500) : "The SHA-256 worker failed.";
        finish(unavailable(reason));
        return;
      }
      if (message.type === "MASTER_FINGERPRINT_RESULT") {
        if (typeof message.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(message.sha256)) {
          finish(unavailable("The SHA-256 worker returned a malformed digest."));
          return;
        }
        finish({ algorithm: "SHA-256", status: "computed", hex: message.sha256, reason: null });
      }
    });
    worker.addEventListener("error", (event) => {
      finish(unavailable(`SHA-256 worker failed: ${event.message || "unknown worker error"}`));
    });
    worker.addEventListener("messageerror", () => {
      finish(unavailable("The SHA-256 worker returned an unreadable response."));
    });

    if (signal) {
      const onAbort = () => finish(undefined, abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        finish(undefined, abortError());
        return;
      }
    }

    try {
      resetWatchdog();
      emitProgress(onProgress, 0);
      worker.postMessage({ type: "MASTER_FINGERPRINT_START", requestId, blob });
    } catch (error) {
      finish(
        unavailable(
          `Could not send the exported file to the SHA-256 worker: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });
}
