import { useCallback, useRef, useState } from "react";
import { useServices } from "./context";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import { userSampleId } from "../persistence/UserSampleRepository";
import { detectLoopBpm } from "../audio-engine/bpm-detect";

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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      setImporting(true);
      setError(null);
      const fileArray = Array.from(files);
      const importedBatch: UserSampleAsset[] = [];

      for (const file of fileArray) {
        // Validate file type
        const isAccepted = ACCEPTED_TYPES.includes(file.type) || ACCEPTED_EXTENSIONS.test(file.name);
        if (!isAccepted) {
          setError(`Unsupported format: ${file.name}`);
          setImporting(false);
          return;
        }

        // Validate size BEFORE reading — decoded PCM multiplies the bytes,
        // so an oversized file must fail fast instead of OOM-ing the tab.
        if (file.size > MAX_AUDIO_IMPORT_BYTES) {
          setError(
            `File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB — limit ${(
              MAX_AUDIO_IMPORT_BYTES /
              1024 /
              1024
            ).toFixed(0)} MB)`,
          );
          setImporting(false);
          return;
        }

        try {
          const ctx = services.engine.context;
          if (!ctx) {
            setError("Audio engine not ready");
            setImporting(false);
            return;
          }
          // Read the encoded bytes once: decodeAudioData detaches the buffer
          // it receives, so hand it a copy and keep the original for IDB.
          const raw = await file.arrayBuffer();
          const buffer = await ctx.decodeAudioData(raw.slice(0));
          const id = userSampleId(file.name);

          // Add to audio bank (immediately playable)
          services.bank.add(id, buffer);

          // One-time tempo detection for the "Fit to project BPM" workflow.
          // Best-effort: a failed/absent detection just leaves `bpm` unset.
          let bpm: number | undefined;
          try {
            const detected = detectLoopBpm(buffer.getChannelData(0), buffer.sampleRate);
            if (detected) bpm = detected.bpm;
          } catch (err) {
            console.warn("[DropZone] bpm detection failed:", err);
          }

          // Persist metadata + encoded bytes (survives reloads since DB v5)
          const asset: UserSampleAsset = {
            id,
            name: file.name.replace(/\.[^.]+$/, ""),
            fileName: file.name,
            category: "Custom",
            duration: buffer.duration,
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
            createdAt: new Date().toISOString(),
            ...(bpm !== undefined ? { bpm } : {}),
          };
          await services.userSamples.save(asset, raw);

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
      if (onBatchImport && importedBatch.length > 1) {
        onBatchImport(importedBatch);
      }
      setImporting(false);
    },
    [services, onBatchImport, onImport],
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
