/**
 * RECORDING STORAGE QUOTA ERROR — the shared "the browser ran out of disk"
 * signal for live capture.
 *
 * Surfaced when the recording recovery store runs the IndexedDB out of disk
 * budget while arming a recording session. The UI can offer a "free up space"
 * path; the recording tab must NOT silently retry.
 *
 * It lives in the shared layer for the same reason the owner id does: the
 * capture recorder (audio engine) recognizes this error to report it
 * honestly, and the architecture layer gate forbids the audio engine from
 * importing the persistence module. Both sides must agree on ONE error type,
 * so the class is defined here and re-exported by the persistence module.
 */
export class RecordingStorageQuotaError extends Error {
  override readonly name = "RecordingStorageQuotaError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}
