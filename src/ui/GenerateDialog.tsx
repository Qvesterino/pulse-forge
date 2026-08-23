import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useDoc, useServices } from "./context";
import { generatePatternCommand } from "../commands/commands";
import type { GenerateOptions } from "../ai/types";
import { GENRES, DEFAULT_GENERATE_OPTIONS } from "../ai/types";
import { getStyleNamesForGenre, getGroovesForGenre } from "../ai/grooves/index";
import { generateDrumPattern } from "../ai/drums";
import { mulberry32, hashString } from "../shared/rng";
import { PAD_NAMES } from "../ai/types";

function randomSeed(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Mini step sequencer preview */
function PatternPreview({ rows, activePads }: { rows: number[][]; activePads: number[] }) {
  if (!rows || activePads.length === 0) return null;
  return (
    <div className="preview-grid" role="img" aria-label="Pattern preview">
      <div className="preview-ruler">
        {Array.from({ length: 16 }, (_, i) => (
          <div key={i} className={`preview-step-num${i % 4 === 0 ? " beat" : ""}`}>{i + 1}</div>
        ))}
      </div>
      {activePads.map((padIdx) => {
        const row = rows[padIdx];
        if (!row) return null;
        return (
          <div key={padIdx} className="preview-row">
            <span className="preview-pad-label" title={PAD_NAMES[padIdx] ?? `Pad ${padIdx}`}>
              {(PAD_NAMES[padIdx] ?? `P${padIdx}`).slice(0, 4)}
            </span>
            {row.slice(0, 16).map((vel, step) => (
              <div
                key={step}
                className={`preview-cell${vel > 0 ? " active" : ""}${step % 4 === 0 ? " beat" : ""}`}
                style={vel > 0 ? { opacity: 0.3 + vel * 0.7 } : undefined}
                title={vel > 0 ? `${PAD_NAMES[padIdx] ?? `P${padIdx}`} step ${step + 1}: ${Math.round(vel * 100)}%` : undefined}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
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
  const [replaceMode, setReplaceMode] = useState<'new' | 'replace'>('new');
  const [drumTrackId, setDrumTrackId] = useState<string>("");
  const [instrumentTrackId, setInstrumentTrackId] = useState<string>("");
  const [sourcePatternId, setSourcePatternId] = useState<string>("");
  const [applyGrooveSettings, setApplyGrooveSettings] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const seedInputRef = useRef<HTMLInputElement>(null);

  const styles = getStyleNamesForGenre(genre);
  const drumTracks = doc.tracks.filter(t => t.kind === 'drum');
  const instrumentTracks = doc.tracks.filter(t => t.kind === 'instrument');

  // Live preview
  const preview = useMemo(() => {
    const preSeed = hashString(`${genre}|${seed}`);
    const preRand = mulberry32(preSeed);
    const grooves = getGroovesForGenre(genre);
    const groove = style
      ? grooves.find(g => g.name.toLowerCase() === style.toLowerCase()) ?? grooves[0]
      : grooves[Math.floor(preRand() * grooves.length)];
    if (!groove) return { rows: [] as number[][], activePads: [] as number[] };
    const mainSeed = hashString(`${genre}|${seed}|${groove.id}`);
    const rand = mulberry32(mainSeed);
    const { rows } = generateDrumPattern(groove, { ...DEFAULT_GENERATE_OPTIONS, genre, seed, stepCount: 16, ghostWeight, microWeight, velocityVariation, temperature }, rand);
    return { rows, activePads: groove.activePads };
  }, [genre, style, seed, ghostWeight, microWeight, velocityVariation, temperature]);

  useEffect(() => {
    if (open && seedInputRef.current) {
      seedInputRef.current.focus();
      seedInputRef.current.select();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) onClose();
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
      replaceMode,
      drumTrackId: drumTrackId || undefined,
      instrumentTrackIds: instrumentTrackId ? [instrumentTrackId] : undefined,
      sourcePatternId: sourcePatternId || undefined,
      applyGrooveSettings,
    };
    services.store.execute(generatePatternCommand(doc, options, patternName || undefined));
    onClose();
  }, [genre, style, seed, stepCount, ghostWeight, microWeight, velocityVariation, temperature, replaceMode, drumTrackId, instrumentTrackId, patternName, doc, services, onClose]);

  const handleRandomSeed = useCallback(() => setSeed(randomSeed()), []);

  if (!open) return null;

  return (
    <div className="generate-dialog-backdrop" role="dialog" aria-label="Generate pattern">
      <div className="generate-dialog" ref={dialogRef}>
        <div className="generate-dialog-header">
          <span className="generate-dialog-title">GENERATE PATTERN</span>
          <button type="button" className="btn btn-small" onClick={onClose}>✕</button>
        </div>

        <div className="generate-dialog-body">
          {/* Mode toggle */}
          <div className="generate-field">
            <label className="generate-label">MODE</label>
            <div className="generate-mode-row">
              <button
                type="button"
                className={`btn btn-small${replaceMode === 'new' ? ' active-solo' : ''}`}
                onClick={() => setReplaceMode('new')}
              >
                NEW
              </button>
              <button
                type="button"
                className={`btn btn-small${replaceMode === 'replace' ? ' active-solo' : ''}`}
                onClick={() => setReplaceMode('replace')}
              >
                REPLACE
              </button>
            </div>
          </div>

          {/* Genre */}
          <div className="generate-field">
            <label className="generate-label">GENRE</label>
            <select className="generate-select" value={genre}
              onChange={(e) => { setGenre(e.target.value as GenerateOptions["genre"]); setStyle(""); }}>
              {GENRES.map((g) => <option key={g} value={g}>{g.charAt(0).toUpperCase() + g.slice(1)}</option>)}
            </select>
          </div>

          {/* Style */}
          <div className="generate-field">
            <label className="generate-label">STYLE</label>
            <select className="generate-select" value={style} onChange={(e) => setStyle(e.target.value)}>
              <option value="">Random</option>
              {styles.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* Seed */}
          <div className="generate-field">
            <label className="generate-label">SEED</label>
            <div className="generate-seed-row">
              <input ref={seedInputRef} type="text" className="generate-seed-input" value={seed}
                onChange={(e) => setSeed(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleGenerate(); }} maxLength={16} />
              <button type="button" className="btn btn-small" onClick={handleRandomSeed} title="Random seed">🎲</button>
            </div>
          </div>

          {/* Length */}
          <div className="generate-field">
            <label className="generate-label">LENGTH</label>
            <select className="generate-select" value={stepCount} onChange={(e) => setStepCount(Number(e.target.value))}>
              <option value={16}>16 steps</option>
              <option value={32}>32 steps</option>
              <option value={64}>64 steps</option>
            </select>
          </div>

          {/* Pattern name */}
          <div className="generate-field">
            <label className="generate-label">NAME</label>
            <input type="text" className="generate-seed-input" value={patternName}
              onChange={(e) => setPatternName(e.target.value)} placeholder={`${genre} ${seed.slice(0, 4)}`} maxLength={32} />
          </div>

          {/* Track targeting */}
          <div className="generate-divider" />
          <div className="generate-advanced-title">TARGETS</div>

          {drumTracks.length > 1 && (
            <div className="generate-field">
              <label className="generate-label">DRUM TRACK</label>
              <select className="generate-select" value={drumTrackId} onChange={(e) => setDrumTrackId(e.target.value)}>
                <option value="">First drum track</option>
                {drumTracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}

          {instrumentTracks.length > 0 && (
            <div className="generate-field">
              <label className="generate-label">INSTRUMENT</label>
              <select className="generate-select" value={instrumentTrackId} onChange={(e) => setInstrumentTrackId(e.target.value)}>
                <option value="">First instrument</option>
                {instrumentTracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}

          {/* Source pattern for seed derivation */}
          {doc.patterns.length > 0 && (
            <div className="generate-field">
              <label className="generate-label">SOURCE PATTERN</label>
              <select className="generate-select" value={sourcePatternId} onChange={(e) => setSourcePatternId(e.target.value)}>
                <option value="">None (use seed)</option>
                {doc.patterns.map((p) => <option key={p.id} value={p.id}>{p.name || `Pattern`}</option>)}
              </select>
            </div>
          )}

          {/* Groove integration */}
          <div className="generate-field">
            <label className="generate-label">APPLY GROOVE</label>
            <button
              type="button"
              className={`btn btn-small${applyGrooveSettings ? ' active-solo' : ''}`}
              onClick={() => setApplyGrooveSettings(!applyGrooveSettings)}
            >
              {applyGrooveSettings ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Preview */}
          <div className="generate-divider" />
          <div className="generate-advanced-title">PREVIEW</div>
          <PatternPreview rows={preview.rows} activePads={preview.activePads} />

          {/* Advanced controls */}
          <div className="generate-divider" />
          <div className="generate-advanced-title">ADVANCED</div>

          <div className="generate-slider-row">
            <label className="generate-label">GHOSTS</label>
            <input type="range" className="generate-slider" min={0} max={1} step={0.05} value={ghostWeight} onChange={(e) => setGhostWeight(Number(e.target.value))} />
            <span className="generate-value">{Math.round(ghostWeight * 100)}%</span>
          </div>

          <div className="generate-slider-row">
            <label className="generate-label">MICRO</label>
            <input type="range" className="generate-slider" min={0} max={1} step={0.05} value={microWeight} onChange={(e) => setMicroWeight(Number(e.target.value))} />
            <span className="generate-value">{Math.round(microWeight * 100)}%</span>
          </div>

          <div className="generate-slider-row">
            <label className="generate-label">VEL·VAR</label>
            <input type="range" className="generate-slider" min={0} max={1} step={0.05} value={velocityVariation} onChange={(e) => setVelocityVariation(Number(e.target.value))} />
            <span className="generate-value">{Math.round(velocityVariation * 100)}%</span>
          </div>

          <div className="generate-slider-row">
            <label className="generate-label">TEMP</label>
            <input type="range" className="generate-slider" min={0.2} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} />
            <span className="generate-value">{temperature.toFixed(1)}</span>
          </div>
        </div>

        <div className="generate-dialog-footer">
          <button type="button" className="btn btn-small" onClick={onClose}>CANCEL</button>
          <button type="button" className="btn btn-small btn-primary" onClick={handleGenerate}>GENERATE</button>
        </div>
      </div>
    </div>
  );
}
