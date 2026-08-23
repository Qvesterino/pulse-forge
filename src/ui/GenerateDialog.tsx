import { useState, useCallback, useRef, useEffect } from "react";
import { useDoc, useServices } from "./context";
import { generatePatternCommand } from "../commands/commands";
import type { GenerateOptions } from "../ai/types";
import { GENRES, DEFAULT_GENERATE_OPTIONS } from "../ai/types";
import { getStyleNamesForGenre } from "../ai/grooves/index";

function randomSeed(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function GenerateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const services = useServices();
  const doc = useDoc();

  const [genre, setGenre] = useState<GenerateOptions["genre"]>(DEFAULT_GENERATE_OPTIONS.genre);
  const [style, setStyle] = useState<string>("");
  const [seed, setSeed] = useState(() => randomSeed());
  const [stepCount, setStepCount] = useState(DEFAULT_GENERATE_OPTIONS.stepCount);
  const [ghostWeight, setGhostWeight] = useState(DEFAULT_GENERATE_OPTIONS.ghostWeight);
  const [microWeight, setMicroWeight] = useState(DEFAULT_GENERATE_OPTIONS.microWeight);
  const [velocityVariation, setVelocityVariation] = useState(DEFAULT_GENERATE_OPTIONS.velocityVariation);
  const [temperature, setTemperature] = useState(DEFAULT_GENERATE_OPTIONS.temperature);
  const [patternName, setPatternName] = useState("");

  const dialogRef = useRef<HTMLDivElement>(null);
  const seedInputRef = useRef<HTMLInputElement>(null);

  const styles = getStyleNamesForGenre(genre);

  // Focus seed input when dialog opens
  useEffect(() => {
    if (open && seedInputRef.current) {
      seedInputRef.current.focus();
      seedInputRef.current.select();
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Consume the event so the app-level shortcut handler does not also
        // act on it (e.g. stopping the transport).
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  const handleGenerate = useCallback(() => {
    const options: GenerateOptions = {
      genre,
      style: style || undefined,
      seed,
      stepCount,
      ghostWeight,
      microWeight,
      velocityVariation,
      temperature,
    };
    services.store.execute(generatePatternCommand(doc, options, patternName || undefined));
    onClose();
  }, [genre, style, seed, stepCount, ghostWeight, microWeight, velocityVariation, temperature, patternName, doc, services, onClose]);

  const handleRandomSeed = useCallback(() => {
    setSeed(randomSeed());
  }, []);

  if (!open) return null;

  return (
    <div className="generate-dialog-backdrop" role="dialog" aria-label="Generate pattern">
      <div className="generate-dialog" ref={dialogRef}>
        <div className="generate-dialog-header">
          <span className="generate-dialog-title">GENERATE PATTERN</span>
          <button type="button" className="btn btn-small" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="generate-dialog-body">
          {/* Genre */}
          <div className="generate-field">
            <label className="generate-label">GENRE</label>
            <select
              className="generate-select"
              value={genre}
              onChange={(e) => {
                setGenre(e.target.value as GenerateOptions["genre"]);
                setStyle("");
              }}
            >
              {GENRES.map((g) => (
                <option key={g} value={g}>
                  {g.charAt(0).toUpperCase() + g.slice(1)}
                </option>
              ))}
            </select>
          </div>

          {/* Style */}
          <div className="generate-field">
            <label className="generate-label">STYLE</label>
            <select
              className="generate-select"
              value={style}
              onChange={(e) => setStyle(e.target.value)}
            >
              <option value="">Random</option>
              {styles.map((s: string) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {/* Seed */}
          <div className="generate-field">
            <label className="generate-label">SEED</label>
            <div className="generate-seed-row">
              <input
                ref={seedInputRef}
                type="text"
                className="generate-seed-input"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleGenerate();
                }}
                maxLength={16}
              />
              <button
                type="button"
                className="btn btn-small"
                onClick={handleRandomSeed}
                title="Random seed"
              >
                🎲
              </button>
            </div>
          </div>

          {/* Length */}
          <div className="generate-field">
            <label className="generate-label">LENGTH</label>
            <select
              className="generate-select"
              value={stepCount}
              onChange={(e) => setStepCount(Number(e.target.value))}
            >
              <option value={16}>16 steps</option>
              <option value={32}>32 steps</option>
              <option value={64}>64 steps</option>
            </select>
          </div>

          {/* Pattern name */}
          <div className="generate-field">
            <label className="generate-label">NAME</label>
            <input
              type="text"
              className="generate-seed-input"
              value={patternName}
              onChange={(e) => setPatternName(e.target.value)}
              placeholder={`${genre} ${seed.slice(0, 4)}`}
              maxLength={32}
            />
          </div>

          {/* Advanced controls */}
          <div className="generate-divider" />
          <div className="generate-advanced-title">ADVANCED</div>

          <div className="generate-slider-row">
            <label className="generate-label">GHOSTS</label>
            <input
              type="range"
              className="generate-slider"
              min={0}
              max={1}
              step={0.05}
              value={ghostWeight}
              onChange={(e) => setGhostWeight(Number(e.target.value))}
            />
            <span className="generate-value">{Math.round(ghostWeight * 100)}%</span>
          </div>

          <div className="generate-slider-row">
            <label className="generate-label">MICRO</label>
            <input
              type="range"
              className="generate-slider"
              min={0}
              max={1}
              step={0.05}
              value={microWeight}
              onChange={(e) => setMicroWeight(Number(e.target.value))}
            />
            <span className="generate-value">{Math.round(microWeight * 100)}%</span>
          </div>

          <div className="generate-slider-row">
            <label className="generate-label">VEL·VAR</label>
            <input
              type="range"
              className="generate-slider"
              min={0}
              max={1}
              step={0.05}
              value={velocityVariation}
              onChange={(e) => setVelocityVariation(Number(e.target.value))}
            />
            <span className="generate-value">{Math.round(velocityVariation * 100)}%</span>
          </div>

          <div className="generate-slider-row">
            <label className="generate-label">TEMP</label>
            <input
              type="range"
              className="generate-slider"
              min={0.2}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
            />
            <span className="generate-value">{temperature.toFixed(1)}</span>
          </div>
        </div>

        <div className="generate-dialog-footer">
          <button type="button" className="btn btn-small" onClick={onClose}>
            CANCEL
          </button>
          <button type="button" className="btn btn-small btn-primary" onClick={handleGenerate}>
            GENERATE
          </button>
        </div>
      </div>
    </div>
  );
}
