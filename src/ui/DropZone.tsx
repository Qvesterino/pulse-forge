import { useCallback, useRef, useState } from "react";
import { useServices } from "./context";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";
import { decodeAudioFile, userSampleId } from "../persistence/UserSampleRepository";

interface DropZoneProps {
  onImport: (asset: UserSampleAsset) => void;
  className?: string;
}

const ACCEPTED_TYPES = ["audio/wav", "audio/wave", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/flac", "audio/aiff", "audio/x-aiff"];
const ACCEPTED_EXTENSIONS = /\.(wav|mp3|ogg|flac|aiff|opus)$/i;

/**
 * Drag & drop zone for importing audio files. Accepts WAV, MP3, OGG, FLAC,
 * AIFF files, decodes them via AudioContext, and adds them to the user
 * sample bank + IndexedDB.
 */
export function DropZone({ onImport, className }: DropZoneProps) {
  const services = useServices();
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importFiles = useCallback(async (files: FileList | File[]) => {
    setImporting(true);
    setError(null);
    const fileArray = Array.from(files);

    for (const file of fileArray) {
      // Validate file type
      const isAccepted = ACCEPTED_TYPES.includes(file.type) || ACCEPTED_EXTENSIONS.test(file.name);
      if (!isAccepted) {
        setError(`Unsupported format: ${file.name}`);
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
        const buffer = await decodeAudioFile(file, ctx);
        const id = userSampleId(file.name);

        // Add to audio bank (immediately playable)
        services.bank.add(id, buffer);

        // Persist metadata
        const asset: UserSampleAsset = {
          id,
          name: file.name.replace(/\.[^.]+$/, ""),
          fileName: file.name,
          category: "Custom",
          duration: buffer.duration,
          sampleRate: buffer.sampleRate,
          channels: buffer.numberOfChannels,
          createdAt: new Date().toISOString(),
        };
        await services.userSamples.save(asset);

        onImport(asset);
      } catch (err) {
        setError(`Failed to decode: ${file.name}`);
        console.error("[DropZone] decode error:", err);
      }
    }
    setImporting(false);
  }, [services, onImport]);

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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      void importFiles(e.dataTransfer.files);
    }
  }, [importFiles]);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void importFiles(e.target.files);
      e.target.value = ""; // reset for re-import of same file
    }
  }, [importFiles]);

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
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleClick(); }}
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
          <span className="drop-zone-text">
            {dragOver ? "Drop to import" : "Drop audio or click"}
          </span>
          <span className="drop-zone-hint">WAV · MP3 · OGG · FLAC · AIFF</span>
        </>
      )}
    </div>
  );
}
