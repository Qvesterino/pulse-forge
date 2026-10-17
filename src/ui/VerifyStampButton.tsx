import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "./context";
import { startJob } from "../services/jobCenter";
import { verifyRenderStamp, type VerifyRenderStampOutcome } from "../export/verifyRenderStamp";
import type { LastRenderStamp } from "../export/renderManifest";

/**
 * VERIFY LAST EXPORT (Wave 2/C, the reproduction half).
 *
 * The manifest inside an exported WAV claims the file can be reproduced. This
 * button CHECKS that claim: it re-renders the open project with the exact
 * settings the file records and compares the PCM hashes — a match means the
 * audio is bit-identical, not merely similar. A mismatch is shown, never
 * smoothed over: it means the project (or the quality switch) changed since
 * the file was written.
 *
 * The re-render is a long operation, so it runs as a Job Center job: visible,
 * cancellable from the Activity Center, and it cannot leave a stuck flag if
 * this panel unmounts mid-flight.
 */

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError")
  );
}

export function VerifyStampButton({ stamp }: { stamp: LastRenderStamp | null }) {
  const services = useServices();
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<VerifyRenderStampOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const verify = useCallback(async () => {
    if (stamp == null) return;
    setBusy(true);
    setError(null);
    setVerdict(null);
    const job = startJob({
      kind: "verify",
      label: `Verify ${stamp.fileName}`,
      key: "render-stamp-verify",
      cancellable: true,
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    job?.signal.addEventListener("abort", abort, { once: true });
    try {
      const outcome = await verifyRenderStamp({
        manifest: stamp.manifest,
        doc: services.store.getDoc(),
        bank: services.bank,
        signal: controller.signal,
      });
      // Only a bit-identical match reads as success in the Job Center. A
      // mismatch (or an unhashable file) settles as a FAILED job, so the
      // completion notice can never say "✓" about a file that did not
      // reproduce.
      if (outcome.status === "match") job?.done("bit-identical");
      else job?.fail(outcome.status);
      if (mounted.current) setVerdict(outcome);
    } catch (err) {
      if (isAbortError(err)) {
        job?.fail("cancelled");
        return;
      }
      const message = err instanceof Error ? err.message : "Verification failed.";
      job?.fail(message);
      if (mounted.current) setError(message);
    } finally {
      job?.signal.removeEventListener("abort", abort);
      if (mounted.current) setBusy(false);
    }
  }, [services, stamp]);

  if (stamp == null) return null;

  return (
    <div className="export-verify" role="group" aria-label="Reproduce last export">
      <button
        type="button"
        className="btn"
        disabled={busy}
        title="Re-render this project with the settings stamped in the exported file and compare the PCM hashes (bit-identical proof)"
        onClick={() => void verify()}
      >
        {busy ? "VERIFYING…" : "VERIFY LAST EXPORT"}
      </button>
      {verdict != null && (
        <span className={verdict.status === "match" ? "save-status" : "save-status save-error"} role="status">
          {verdict.detail}
        </span>
      )}
      {error != null && (
        <span className="save-status save-error" role="alert" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
