import { useCallback, useRef, useState } from "react";
import { useServices } from "./context";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import { addAudioClip, fittedLoopPlacement, type FittedLoopPlacement } from "../commands/commands";
import { ticksPerBar } from "../project-model/schema";
import { importAudioFile } from "./sample-import";
import {
  audioImportAcceptAttribute,
  describeAudioImportFormats,
  isAudioImportFile,
  MAX_AUDIO_IMPORT_BYTES,
} from "../audio-import-capabilities";

interface DropZoneProps {
  onImport: (asset: UserSampleAsset) => void;
  /**
   * Called once after a multi-file drop with every imported asset — the
   * sampler auto-mapping hook (keyzones/RR from file names, see
   * `autoMapVelocityLayers`).
   */
  onBatchImport?: (assets: UserSampleAsset[]) => void;
  className?: string;
}

/**
 * Drag & drop zone for importing audio files. Accepts every container a browser
 * can decode (see `audio-import-capabilities.ts` — the list is decode-driven and
 * deliberately wider than what KYX can export), decodes them via AudioContext,
 * and adds them to the user sample bank + IndexedDB.
 */
export function DropZone({ onImport, onBatchImport, className }: DropZoneProps) {
  const services = useServices();
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Post-import fit offer: a single freshly imported loop with a steady
  // detected tempo offers one-click fitted timeline placement.
  const [fitOffer, setFitOffer] = useState<{ asset: UserSampleAsset; placement: FittedLoopPlacement } | null>(null);
  // U6 — UN-SUNO shortcut: the File behind a single import, so the panel can
  // analyze the ORIGINAL (the asset alone would need re-decoding from the bank).
  const [analyzeOffer, setAnalyzeOffer] = useState<{ file: File; sampleId: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Place the offered loop on the timeline, fitted — one undoable command. */
  const placeOfferedLoop = useCallback(() => {
    if (!fitOffer) return;
    try {
      const doc = services.store.doc;
      const track = doc.tracks[0];
      if (!track) {
        setError("No track in project");
        return;
      }
      const atBar = Math.max(0, Math.floor(services.transport.position / ticksPerBar(doc)));
      services.store.execute(
        addAudioClip(doc, track.id, fitOffer.asset.id, atBar, fitOffer.placement.lengthBars, {
          gain: 1,
          stretchRate: fitOffer.placement.rate,
          stretchMode: "stretch",
        }),
      );
      setFitOffer(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not place loop");
    }
  }, [fitOffer, services]);

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      // Audit 10 D1: a second drop/click during an in-flight batch used to
      // start a competing decode loop (two setImporting(false) races, last
      // error wins). One batch at a time.
      if (importing) return;
      setImporting(true);
      setError(null);
      setFitOffer(null);
      setAnalyzeOffer(null);
      // The whole batch lives under try/finally: `onBatchImport` (and the
      // per-batch auto-map it drives) is a caller-provided callback that can
      // throw. Without the finally, that throw rejected this async handler
      // before `setImporting(false)` and the zone showed "Decoding…" forever,
      // refusing every later drop through the `if (importing) return` guard.
      try {
        const fileArray = Array.from(files);
        const importedBatch: UserSampleAsset[] = [];
        const skipped: string[] = [];

        for (const file of fileArray) {
          // Validate file type — SKIP (not abort): dropping 20 WAVs where #3 is
          // a .txt must not silently discard files 4–20 (Audit 10 D2).
          const isAccepted = isAudioImportFile(file);
          if (!isAccepted) {
            skipped.push(file.name);
            continue;
          }

          // Validate size BEFORE reading — decoded PCM multiplies the bytes,
          // so an oversized file must fail fast instead of OOM-ing the tab.
          if (file.size > MAX_AUDIO_IMPORT_BYTES) {
            skipped.push(`${file.name} (over ${Math.floor(MAX_AUDIO_IMPORT_BYTES / 1024 / 1024)} MB)`);
            continue;
          }

          try {
            const asset = await importAudioFile(services, file);
            onImport(asset);
            importedBatch.push(asset);
          } catch (err) {
            // Persistence failures now propagate out of userSamples.save — show
            // them distinctly from decode failures instead of leaving ghost
            // samples that are silently silent after reload.
            const message =
              err instanceof Error && err.message && !/decode/i.test(err.message)
                ? err.message
                : `Failed to decode: ${file.name}`;
            setError(message);
            console.error("[DropZone] import error:", err);
          }
        }
        if (skipped.length > 0) {
          // D2: say WHAT was skipped — the old early-return silently discarded
          // every file after the first bad one.
          setError(
            `Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} — Unsupported format: ${skipped.slice(0, 3).join(", ")}${
              skipped.length > 3 ? "…" : ""
            }`,
          );
        }
        if (onBatchImport && importedBatch.length > 1) {
          // A caller-provided batch hook (the sampler auto-map) can throw; left
          // unwrapped it rejected this `void`-invoked handler and surfaced only
          // as an unhandled rejection. Surface it as the zone's error state.
          try {
            onBatchImport(importedBatch);
          } catch (err) {
            console.error("[DropZone] batch import callback failed:", err);
            setError(err instanceof Error ? err.message : "Batch import post-processing failed");
          }
        }
        // Single-loop import with a steady tempo → offer fitted placement.
        // Batches skip the offer (the browser rows keep their BPM badges).
        if (importedBatch.length === 1) {
          const [only] = importedBatch;
          void only;
          const doc = services.store.doc;
          const placement =
            only.bpm !== undefined ? fittedLoopPlacement(only.duration, only.bpm, doc.bpm, ticksPerBar(doc)) : null;
          if (placement) setFitOffer({ asset: only, placement });
          // UN-SUNO shortcut offer — hand the File AND the bank id to the
          // Reference Map panel, which owns the analyze pipeline (it may be
          // closed; the offer then just does nothing until the user opens it).
          // The sample id lets BUILD PROJECT attach the original as an audio lane.
          const file = fileArray[0];
          if (file) setAnalyzeOffer({ file, sampleId: only.id });
        }
      } finally {
        setImporting(false);
      }
    },
    [services, onBatchImport, onImport, importing],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        void importFiles(e.dataTransfer.files);
      }
    },
    [importFiles],
  );

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        void importFiles(e.target.files);
        e.target.value = ""; // reset for re-import of same file
      }
    },
    [importFiles],
  );

  return (
    <div
      className={`drop-zone${dragOver ? " drop-zone-active" : ""}${className ? ` ${className}` : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label="Drop audio files here or click to browse"
      onKeyDown={(e) => {
        // Enter only — Space stays free for the global play/pause shortcut.
        if (e.key === "Enter") handleClick();
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={audioImportAcceptAttribute()}
        multiple
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
      {analyzeOffer && !importing && (
        <div className="dropzone-analyze-offer" data-testid="dropzone-analyze-offer">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("pf:unsuno-analyze", { detail: analyzeOffer }));
              setAnalyzeOffer(null);
            }}
            data-testid="dropzone-analyze-go"
            title="Otvorí REF panel a analyzuje tento súbor — potom 🎛 BUILD PROJECT postaví editovateľný projekt"
          >
            🎛 UN-SUNO: analyzovať → projekt
          </button>
        </div>
      )}
      {fitOffer && !importing && (
        <div
          className="drop-zone-fit"
          role="status"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <span className="drop-zone-text">
            🥁 {fitOffer.asset.name} · {Math.round(fitOffer.asset.bpm ?? 0)} BPM → {fitOffer.placement.lengthBars}-bar
            fitted clip (×{fitOffer.placement.rate.toFixed(2)})
          </span>
          <span className="drop-zone-fit-actions">
            <button type="button" className="btn btn-small" onClick={placeOfferedLoop}>
              Place on timeline
            </button>
            <button
              type="button"
              className="btn btn-small"
              aria-label="Dismiss fit offer"
              onClick={() => setFitOffer(null)}
            >
              ✕
            </button>
          </span>
        </div>
      )}
      {importing ? (
        <span className="drop-zone-text">Decoding…</span>
      ) : error ? (
        <span className="drop-zone-text drop-zone-error">{error}</span>
      ) : (
        <>
          <span className="drop-zone-text">{dragOver ? "Drop to import" : "Drop audio or click"}</span>
          <span className="drop-zone-hint">{describeAudioImportFormats()}</span>
        </>
      )}
    </div>
  );
}
