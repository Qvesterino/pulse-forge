import { useCallback, useEffect, useRef, useState } from "react";
import { galleryBaseUrl } from "../gallery/galleryApi";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import { useServices } from "./context";
import { importAudioFile } from "./sample-import";

/**
 * SEND-TO-KYX intake tray (2. vlna) — receives audio pushed from the browser
 * extension (or any local tool) through the collab server's bounded intake
 * FIFO. Polls the list, imports on click through the SAME decode/persist
 * path as the DropZone (sample-import.importAudioFile), removes what it
 * consumed. Local-only surface: the intake lives on the user's own collab
 * server (127.0.0.1 by default), never on a public endpoint.
 */

interface IntakeItem {
  id: string;
  name: string;
  sourceUrl: string | null;
  bytes: number;
  createdAt: string;
}

const POLL_MS = 8000;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

export function IntakeTray({
  onImported,
  className,
}: {
  onImported?: (asset: UserSampleAsset) => void;
  className?: string;
}) {
  const services = useServices();
  const [items, setItems] = useState<IntakeItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`${galleryBaseUrl()}/api/intake`);
      if (!res.ok) return; // intake endpoint absent (old server) — tray stays quiet
      const body = (await res.json()) as { items?: IntakeItem[] };
      setItems(Array.isArray(body.items) ? body.items : []);
      setError(null);
    } catch {
      /* server down — the tray is best-effort */
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const importItem = useCallback(
    async (item: IntakeItem) => {
      setImporting(item.id);
      setError(null);
      try {
        const res = await fetch(`${galleryBaseUrl()}/api/intake/${item.id}`);
        if (!res.ok) throw new Error(`intake fetch failed (${res.status})`);
        const body = (await res.json()) as { item?: { name?: string; dataB64?: string } };
        const dataB64 = body.item?.dataB64 ?? "";
        if (!dataB64) throw new Error("intake item has no audio payload");
        const binary = atob(dataB64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const file = new File([bytes], item.name, { type: "audio/wav" });
        const asset = await importAudioFile(services, file);
        onImported?.(asset);
        seen.current.add(item.id);
        await fetch(`${galleryBaseUrl()}/api/intake/${item.id}`, { method: "DELETE" });
        setItems((prev) => prev.filter((candidate) => candidate.id !== item.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setImporting(null);
      }
    },
    [services, onImported],
  );

  const dismiss = useCallback(async (id: string) => {
    try {
      await fetch(`${galleryBaseUrl()}/api/intake/${id}`, { method: "DELETE" });
    } catch {
      /* best-effort */
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  if (items.length === 0 && !error) return null;

  return (
    <div className={className ?? "intake-tray"} aria-label="Sent to KYX">
      <span className="intake-tray-label">📡 SENT TO KYX</span>
      {items.map((item) => (
        <span key={item.id} className="intake-tray-item">
          <span title={item.sourceUrl ?? undefined}>
            {item.name} · {formatBytes(item.bytes)}
          </span>
          <button
            type="button"
            disabled={importing !== null}
            onClick={() => void importItem(item)}
            title="Decode into the user sample bank"
          >
            {importing === item.id ? "…" : "→ SAMPLE"}
          </button>
          <button type="button" onClick={() => void dismiss(item.id)} title="Discard without importing">
            ✕
          </button>
        </span>
      ))}
      {error && <span className="intake-tray-error">{error}</span>}
    </div>
  );
}
