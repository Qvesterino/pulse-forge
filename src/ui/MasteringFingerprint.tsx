import { useEffect, useState } from "react";
import type { EncodedMasterFingerprint } from "../mastering/fingerprintClient";

export function MasteringFingerprint({ fingerprint }: { fingerprint: EncodedMasterFingerprint }) {
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => setCopyStatus(""), [fingerprint.hex]);

  if (fingerprint.status !== "computed" || !fingerprint.hex) {
    return (
      <small className="mastering-file-fingerprint" role="status">
        File SHA-256 not computed: {fingerprint.reason ?? "fingerprint unavailable"}
      </small>
    );
  }

  const digest = fingerprint.hex;
  const copyFingerprint = async () => {
    try {
      await navigator.clipboard.writeText(digest);
      setCopyStatus("SHA-256 copied.");
    } catch {
      setCopyStatus("Clipboard unavailable. Select the fingerprint text to copy it manually.");
    }
  };

  return (
    <details className="mastering-file-fingerprint">
      <summary>Exact file SHA-256 · show fingerprint</summary>
      <div className="mastering-file-fingerprint-value">
        <code>{digest}</code>
        <button type="button" className="btn btn-small" onClick={() => void copyFingerprint()}>
          COPY SHA-256
        </button>
      </div>
      <small role="status" aria-live="polite">
        {copyStatus}
      </small>
    </details>
  );
}
