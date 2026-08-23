import { useState } from "react";
import { useServices } from "./context";
import {
  fetchFreesoundPreview,
  freesoundSampleId,
  loadFreesoundToken,
  saveFreesoundToken,
  searchFreesound,
  type FreesoundResult,
} from "../samples/freesound";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";

/**
 * Freesound section in the sample browser: search CC0 one-shots, audition
 * the HQ preview, import into the bank. Imported sounds become ordinary
 * user samples — persisted, sliceable, assignable everywhere.
 */
export function FreesoundSection({ onImport }: { onImport: (asset: UserSampleAsset) => void }) {
  const services = useServices();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(loadFreesoundToken);
  const [tokenDraft, setTokenDraft] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FreesoundResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());

  const search = async () => {
    if (!query.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const found = await searchFreesound(query.trim(), { token });
      setResults(found);
      if (found.length === 0) setError("No CC0 results — try a different term.");
    } catch (err) {
      setResults([]);
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  /** Audition: fetch the preview once, decode into the bank, play it. */
  const preview = async (result: FreesoundResult) => {
    const id = freesoundSampleId(result);
    try {
      if (!services.bank.get(id)) {
        const bytes = await fetchFreesoundPreview(result);
        const ctx = services.engine.context;
        if (!ctx) return;
        const buffer = await ctx.decodeAudioData(bytes.slice(0));
        services.bank.add(id, buffer);
      }
      services.engine.previewAsset(id);
    } catch (err) {
      setError(`Preview failed: ${String(err instanceof Error ? err.message : err)}`);
    }
  };

  const importSound = async (result: FreesoundResult) => {
    setBusy(true);
    setError(null);
    try {
      const id = freesoundSampleId(result);
      // One download: decode a copy into the bank, keep the raw bytes for
      // IndexedDB persistence (decodeAudioData detaches what it gets).
      const raw = await fetchFreesoundPreview(result);
      if (!services.bank.get(id)) {
        const ctx = services.engine.context;
        if (!ctx) throw new Error("Audio engine not ready");
        services.bank.add(id, await ctx.decodeAudioData(raw.slice(0)));
      }
      const buffer = services.bank.get(id)!;
      const asset: UserSampleAsset = {
        id,
        name: `${result.name.slice(0, 30)} · fs`,
        fileName: `${result.name.slice(0, 30)} (freesound preview).mp3`,
        category: "Custom",
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        createdAt: new Date().toISOString(),
      };
      await services.userSamples.save(asset, raw);
      setImportedIds((prev) => new Set(prev).add(String(result.id)));
      onImport(asset);
    } catch (err) {
      setError(`Import failed: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="freesound-section">
      <button
        type="button"
        className={`btn btn-small freesound-toggle${open ? " active" : ""}`}
        aria-pressed={open}
        onClick={() => setOpen((v) => !v)}
      >
        FREESOUND · CC0
      </button>

      {open && (
        <div className="freesound-body">
          {token ? (
            <>
              <div className="freesound-search">
                <input
                  value={query}
                  placeholder="kick, snare, vinyl crackle…"
                  aria-label="Search freesound"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void search();
                  }}
                />
                <button type="button" className="btn btn-small" disabled={busy || !query.trim()} onClick={() => void search()}>
                  {busy ? "…" : "GO"}
                </button>
              </div>
              {error && <div className="freesound-error">{error}</div>}
              <div className="freesound-results">
                {results.map((result) => (
                  <div key={result.id} className="sample-row">
                    <button
                      type="button"
                      className="sample-preview"
                      title={`Preview by ${result.username}`}
                      aria-label={`Preview ${result.name}`}
                      onClick={() => void preview(result)}
                    >
                      ▶
                    </button>
                    <span className="freesound-name" title={`${result.name} by ${result.username} (${result.durationSec.toFixed(1)}s, CC0)`}>
                      {result.name} <em>· {result.username}</em>
                    </span>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy || importedIds.has(String(result.id))}
                      title="Import the HQ MP3 preview as a user sample (preview quality, CC0)"
                      onClick={() => void importSound(result)}
                    >
                      {importedIds.has(String(result.id)) ? "✓" : "IMPORT"}
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="freesound-token">
              <p className="collab-hint">
                Paste a free freesound.org API token — get one in 30 seconds at{" "}
                <a href="https://freesound.org/api/apply" target="_blank" rel="noreferrer">
                  freesound.org/api/apply
                </a>
                . It stays in this browser only.
              </p>
              <div className="freesound-search">
                <input
                  value={tokenDraft}
                  placeholder="API token"
                  aria-label="Freesound API token"
                  onChange={(e) => setTokenDraft(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    saveFreesoundToken(tokenDraft);
                    setToken(tokenDraft.trim());
                  }}
                >
                  SAVE
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
