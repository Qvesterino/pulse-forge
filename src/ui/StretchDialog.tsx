import { useEffect, useRef, useState } from "react";

/**
 * TIME-STRETCH dialog — the FL-style face for the clip stretch engine.
 *
 * Replaces the old `window.prompt("Stretch rate…")` with a real dialog:
 * rate slider (0.25–4), resample-vs-preserve mode toggle, live playback
 * math (source seconds → played seconds) and a one-click Fit from the
 * detected loop tempo. Apply commits ONE undoable `updateAudioClip`
 * command via the caller's onApply — the dialog itself never touches the
 * store, so it stays unit-testable without services.
 */

export const STRETCH_RATE_MIN = 0.25;
export const STRETCH_RATE_MAX = 4;

export type StretchMode = "resample" | "stretch";

/** Clamp to the engine range (mirrors the updateAudioClip 0.25–4 gate). */
export function clampStretchRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.round(Math.min(STRETCH_RATE_MAX, Math.max(STRETCH_RATE_MIN, rate)) * 100) / 100;
}

/**
 * Played seconds of source material at a rate (0.5 = half speed = twice as
 * long). Returns 0 when the source length is unknown.
 */
export function stretchedPlaybackSec(sourceSec: number, rate: number): number {
  if (!(sourceSec > 0) || !(rate > 0)) return 0;
  return sourceSec / rate;
}

/**
 * Fit rate locking a detected loop tempo to the project tempo — the same
 * formula as the `fitAudioClipTempo` command (null when out of range).
 */
export function fitRate(detectedBpm: number, projectBpm: number): number | null {
  if (!Number.isFinite(detectedBpm) || detectedBpm < 40 || detectedBpm > 240) return null;
  if (!Number.isFinite(projectBpm) || projectBpm <= 0) return null;
  return clampStretchRate(detectedBpm / projectBpm);
}

export interface StretchDialogProps {
  clipName: string;
  /** Source buffer seconds (0 when the buffer is not loaded). */
  sourceSec: number;
  initialRate: number;
  initialMode: StretchMode;
  /** Detected loop tempo, if the loop has a steady pulse. */
  detectedBpm: number | null;
  projectBpm: number;
  onApply: (rate: number, mode: StretchMode) => void;
  onClose: () => void;
}

export function StretchDialog({
  clipName,
  sourceSec,
  initialRate,
  initialMode,
  detectedBpm,
  projectBpm,
  onApply,
  onClose,
}: StretchDialogProps) {
  const [rate, setRate] = useState(() => clampStretchRate(initialRate));
  const [mode, setMode] = useState<StretchMode>(initialMode);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [onClose]);

  const fit = detectedBpm != null ? fitRate(detectedBpm, projectBpm) : null;
  const playsSec = stretchedPlaybackSec(sourceSec, rate);

  return (
    <div className="generate-dialog-backdrop" role="dialog" aria-label="Time-stretch audio clip">
      <div className="generate-dialog" ref={dialogRef}>
        <div className="generate-dialog-header">
          <span className="generate-dialog-title">TIME-STRETCH · {clipName}</span>
          <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close stretch dialog">
            ✕
          </button>
        </div>
        <div className="generate-dialog-body">
          <div className="generate-field">
            <label className="generate-label" htmlFor="stretch-rate">
              RATE · ×{rate.toFixed(2)}
            </label>
            <input
              id="stretch-rate"
              type="range"
              min={STRETCH_RATE_MIN}
              max={STRETCH_RATE_MAX}
              step={0.01}
              value={rate}
              onChange={(e) => setRate(clampStretchRate(Number(e.target.value)))}
              aria-label="Stretch rate"
            />
          </div>
          <div className="generate-field">
            <span className="generate-label">MODE</span>
            <div role="group" aria-label="Stretch mode">
              <button
                type="button"
                className={`btn btn-small${mode === "resample" ? " intent-use-btn" : ""}`}
                onClick={() => setMode("resample")}
                title="Pitch follows time (FL-style repitch)"
              >
                Resample · pitch+time
              </button>{" "}
              <button
                type="button"
                className={`btn btn-small${mode === "stretch" ? " intent-use-btn" : ""}`}
                onClick={() => setMode("stretch")}
                title="Keep pitch (granular / phase-vocoder)"
              >
                Stretch · keep pitch
              </button>
            </div>
          </div>
          <div className="intent-detected" aria-label="Stretch preview">
            {sourceSec > 0
              ? `Source ${sourceSec.toFixed(2)}s → plays ${playsSec.toFixed(2)}s${mode === "stretch" ? " · pitch kept" : " · pitch ×" + rate.toFixed(2)}`
              : `Rate ×${rate.toFixed(2)}${mode === "stretch" ? " · pitch kept" : " · pitch follows"}`}
          </div>
          {fit != null && detectedBpm != null && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setRate(fit);
                setMode("stretch");
              }}
              title="Lock the detected loop tempo to the project tempo (pitch-preserving)"
            >
              Fit {Math.round(detectedBpm)} → {Math.round(projectBpm)} BPM (×{fit.toFixed(2)})
            </button>
          )}
          {fit == null && <div className="intent-detected">No steady tempo detected — fit unavailable.</div>}
        </div>
        <div className="generate-dialog-footer">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setRate(1);
              setMode("resample");
            }}
            title="Back to 1.00 resample"
          >
            Reset
          </button>
          <button type="button" className="btn btn-small" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-small intent-use-btn" onClick={() => onApply(rate, mode)}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
