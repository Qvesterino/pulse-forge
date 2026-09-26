import { useCallback, useEffect, useRef, useState } from "react";
import { type ModelPack, MODEL_PACKS } from "../ai/packs/registry";
import { downloadPack, evictPack, type ModelPackStatus, type PackProgress } from "../ai/packs/modelPackManager";

/**
 * Optional AI model pack card (ROADMAP-FULL-DAW Phase 5): explicit-request
 * download with size + license + live progress + cancellation, SHA-256
 * verified, stored in the durable Cache API bucket. Self-contained on
 * purpose — mounting it anywhere is a single JSX line.
 */

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function packStatusText(status: ModelPackStatus): string {
  if (status === "ready") return "INSTALLED — works offline";
  if (status === "partial") return "PARTIAL — re-download to repair";
  return "NOT INSTALLED";
}

function PackCard({ pack }: { pack: ModelPack }) {
  const [status, setStatus] = useState<ModelPackStatus>("absent");
  const [progress, setProgress] = useState<PackProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(typeof caches !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle);
    let cancelled = false;
    void (async () => {
      try {
        const { packStatus } = await import("../ai/packs/modelPackManager");
        const next = await packStatus(pack);
        if (!cancelled) setStatus(next);
      } catch {
        /* stays "absent" */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pack]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async () => {
    setError(null);
    setProgress({ bytesDone: 0, totalBytes: null, fileIndex: 0, fileCount: pack.files.length });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await downloadPack(pack, { signal: controller.signal, onProgress: setProgress });
      setStatus("ready");
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      const { packStatus } = await import("../ai/packs/modelPackManager");
      setStatus(await packStatus(pack));
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  }, [pack]);

  const remove = useCallback(async () => {
    try {
      await evictPack(pack);
      setStatus("absent");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [pack]);

  const busy = progress !== null;
  const pct =
    progress && progress.totalBytes && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesDone / progress.totalBytes) * 100))
      : null;

  return (
    <section className="help-group" aria-labelledby={`pack-${pack.id}`}>
      <h3 id={`pack-${pack.id}`} className="help-group-title">
        {pack.label.toUpperCase()} — ≈{pack.approxSizeMb} MB
      </h3>
      <ul className="help-list">
        <li className="help-row">
          <span className="help-label">
            {pack.purpose} <span className="help-gesture-detail">— {pack.fallbackNote}</span>
          </span>
        </li>
        <li className="help-row">
          <span className="help-label">
            License:{" "}
            <a href={pack.licenseUrl} target="_blank" rel="noreferrer noopener">
              {pack.license}
            </a>
          </span>
          <span className="help-bindings">{packStatusText(status)}</span>
        </li>
        {!supported && (
          <li className="help-row">
            <span className="help-label">
              Downloads need Cache Storage + WebCrypto (unavailable in this browser context).
            </span>
          </li>
        )}
        {supported && (
          <li className="help-row">
            <span className="help-bindings">
              {!busy && status !== "ready" && (
                <button type="button" className="btn btn-small" onClick={() => void start()}>
                  DOWNLOAD
                </button>
              )}
              {!busy && status === "ready" && (
                <button type="button" className="btn btn-small" onClick={() => void remove()}>
                  REMOVE
                </button>
              )}
              {busy && (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => abortRef.current?.abort()}
                  aria-label="Cancel download"
                >
                  CANCEL
                </button>
              )}
            </span>
          </li>
        )}
        {busy && (
          <li className="help-row" role="status">
            <span className="help-label">
              {pct !== null ? `${pct}% — ` : ""}
              {formatBytes(progress.bytesDone)}
              {progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ""}
              {` (file ${progress.fileIndex + 1}/${progress.fileCount})`}
            </span>
          </li>
        )}
        {error && (
          <li className="help-row" role="alert">
            <span className="help-label">{error}</span>
          </li>
        )}
      </ul>
    </section>
  );
}

export function ModelPacksSection() {
  if (MODEL_PACKS.length === 0) return null;
  return (
    <div className="help-gestures" aria-label="Optional AI model packs">
      <h3 className="help-group-title">AI MODELS — OPTIONAL DOWNLOADS</h3>
      {MODEL_PACKS.map((pack) => (
        <PackCard key={pack.id} pack={pack} />
      ))}
    </div>
  );
}
