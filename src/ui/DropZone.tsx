import { useCallback, useRef, useState } from "react";
import { useServices } from "./context";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import { addAudioClip, fittedLoopPlacement, type FittedLoopPlacement } from "../commands/commands";
import { BAR_TICKS } from "../project-model/types";
import { importAudioFile } from "./sample-import";

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

const ACCEPTED_TYPES = [
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/flac",
  "audio/aiff",
  "audio/x-aiff",
];
const ACCEPTED_EXTENSIONS = /\.(wav|mp3|ogg|flac|aiff|opus)$/i;

// Import size ceiling (release roadmap 1.4): decoded PCM is ~5–10× the file
// size — a 25 MB cap keeps the worst-case decode well under tab-killing
// memory while comfortably above any musical one-shot/loop.
export const MAX_AUDIO_IMPORT_BYTES = 25 * 1024 * 1024;

/**
 * Drag & drop zone for importing audio files. Accepts WAV, MP3, OGG, FLAC,
 * AIFF files, decodes them via AudioContext, and adds them to the user
 * sample bank + IndexedDB.
 */
export function DropZone({ onImport, onBatchImport, className }: DropZoneProps) {
  const services = useServices();
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Post-import fit offer: a single freshly imported loop with a steady
  // detected tempo offers one-click fitted timeline placement.
  const [fitOffer, setFitOffer] = useState<{ asset: UserSampleAsset; placement: FittedLoopPlacement } | null>(null);
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
      const atBar = Math.max(0, Math.floor(services.transport.position / BAR_TICKS));
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
      const fileArray = Array.from(files);
      const importedBatch: UserSampleAsset[] = [];
      const skipped: string[] = [];

      for (const file of fileArray) {
        // Validate file type — SKIP (not abort): dropping 20 WAVs where #3 is
        // a .txt must not silently discard files 4–20 (Audit 10 D2).
        const isAccepted = ACCEPTED_TYPES.includes(file.type) || ACCEPTED_EXTENSIONS.test(file.name);
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
        onBatchImport(importedBatch);
      }
      // Single-loop import with a steady tempo → offer fitted placement.
      // Batches skip the offer (the browser rows keep their BPM badges).
      if (importedBatch.length === 1) {
        const [only] = importedBatch;
        const doc = services.store.doc;
        const placement =
          only.bpm !== undefined
            ? fittedLoopPlacement(only.duration, only.bpm, doc.bpm, doc.timeSignature.numerator)
            : null;
        if (placement) setFitOffer({ asset: only, placement });
      }
      setImporting(false);
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
        accept=".wav,.mp3,.ogg,.flac,.aiff,.opus"
        multiple
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
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
          <span className="drop-zone-hint">WAV · MP3 · OGG · FLAC · AIFF</span>
        </>
      )}
    </div>
  );
}
