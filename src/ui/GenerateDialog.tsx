import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { usePatterns, useServices, useTracks } from "./context";
import { applyGenerationResultCommand } from "../commands/commands";
import type { GenerateOptions } from "../ai/types";
import { GENRES, DEFAULT_GENERATE_OPTIONS } from "../ai/types";
import { getStyleNamesForGenre } from "../ai/grooves/index";
import { generateAsyncResult } from "../intent/pipeline";
import type { GenerationResult } from "../intent/types";
import { PAD_NAMES } from "../ai/types";
import { nextSeed } from "../shared/dice";

function randomSeed(prev?: string): string {
  return nextSeed(prev ?? String(Date.now()), "generate");
}

/** Mini step sequencer preview */
function PatternPreview({ rows, activePads }: { rows: number[][]; activePads: number[] }) {
  if (!rows || activePads.length === 0) return null;
  return (
    <div className="preview-grid" role="img" aria-label="Pattern preview">
      <div className="preview-ruler">
        {Array.from({ length: 16 }, (_, i) => (
          <div key={i} className={`preview-step-num${i % 4 === 0 ? " beat" : ""}`}>
            {i + 1}
          </div>
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
                title={
                  vel > 0
                    ? `${PAD_NAMES[padIdx] ?? `P${padIdx}`} step ${step + 1}: ${Math.round(vel * 100)}%`
                    : undefined
                }
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
  // Fine-grained selectors (GOAL 04): GenerateDialog only reads tracks (for
  // drum/instrument filter) and patterns (for the source-pattern picker).
  // Subscribing to the whole doc re-renders this dialog on every unrelated
  // edit (a track-mute, a macro mapping change).
  const tracks = useTracks();
  const patterns = usePatterns();
  const doc = services.store.getDoc();

  const [genre, setGenre] = useState<GenerateOptions["genre"]>(DEFAULT_GENERATE_OPTIONS.genre);
  const [style, setStyle] = useState<string>("");
  const [seed, setSeed] = useState(() => randomSeed());
  const [stepCount, setStepCount] = useState(DEFAULT_GENERATE_OPTIONS.stepCount);
  const [ghostWeight, setGhostWeight] = useState(DEFAULT_GENERATE_OPTIONS.ghostWeight);
  const [microWeight, setMicroWeight] = useState(DEFAULT_GENERATE_OPTIONS.microWeight);
  const [velocityVariation, setVelocityVariation] = useState(DEFAULT_GENERATE_OPTIONS.velocityVariation);
  const [temperature, setTemperature] = useState(DEFAULT_GENERATE_OPTIONS.temperature);
  const [patternName, setPatternName] = useState("");
  const [replaceMode, setReplaceMode] = useState<"new" | "replace">("new");
  const [drumTrackId, setDrumTrackId] = useState<string>("");
  const [instrumentTrackId, setInstrumentTrackId] = useState<string>("");
  const [sourcePatternId, setSourcePatternId] = useState<string>("");
  const [applyGrooveSettings, setApplyGrooveSettings] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const seedInputRef = useRef<HTMLInputElement>(null);

  const styles = getStyleNamesForGenre(genre);
  const drumTracks = tracks.filter((t) => t.kind === "drum");
  const instrumentTracks = tracks.filter((t) => t.kind === "instrument");

  // One normalized option object is shared by preview and Apply. The intent
  // pipeline then creates one plan for either mode, so the preview cannot
  // silently drift from the content eventually committed by the command.
  const generationOptions = useMemo<GenerateOptions>(
    () => ({
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
    }),
    [
      genre,
      style,
      seed,
      stepCount,
      ghostWeight,
      microWeight,
      velocityVariation,
      temperature,
      replaceMode,
      drumTrackId,
      instrumentTrackId,
      sourcePatternId,
      applyGrooveSettings,
    ],
  );

  // Live preview through the canonical async generation path. The previewed
  // GenerationResult is what APPLY commits — the command never regenerates.
  // Each options/doc change supersedes the previous request: an abort +
  // monotonic request token make a stale async completion a no-op, so an
  // older generation can never overwrite a newer preview.
  const [preview, setPreview] = useState<{ options: GenerateOptions; result: GenerationResult | null }>({
    options: generationOptions,
    result: null,
  });
  const [pending, setPending] = useState(false);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    generateAsyncResult(doc, generationOptions, { mode: "preview", signal: controller.signal })
      .then((result) => {
        if (requestRef.current !== requestId) return;
        setPreview({ options: generationOptions, result });
      })
      .catch((err) => {
        // Only aborts reject; a superseded request is ignored, a live one
        // keeps the previous preview instead of flashing empty.
        if (requestRef.current !== requestId) return;
        const aborted =
          (err instanceof DOMException && err.name === "AbortError") ||
          (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError");
        if (!aborted) setPreview({ options: generationOptions, result: null });
      })
      .finally(() => {
        if (requestRef.current === requestId) setPending(false);
      });
    return () => controller.abort();
  }, [doc, generationOptions]);

  // Unmount cleanup (dialog close) — stop any in-flight generation.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const previewRows = useMemo(() => {
    const pattern = preview.result?.proposal?.pattern;
    const target = generationOptions.drumTrackId
      ? (drumTracks.find((track) => track.id === generationOptions.drumTrackId) ?? drumTracks[0])
      : drumTracks[0];
    if (!pattern || !target) return { rows: [] as number[][], activePads: [] as number[] };
    const rows = target.pads.map((pad) => pattern.rows[pad.id] ?? []);
    return {
      rows,
      activePads: rows.map((row, index) => (row.some((value) => value > 0) ? index : -1)).filter((index) => index >= 0),
    };
  }, [preview.result, generationOptions, drumTracks]);

  useEffect(() => {
    if (open && seedInputRef.current) {
      seedInputRef.current.focus();
      seedInputRef.current.select();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
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
    // Apply exactly the previewed GenerationResult — never regenerate. The
    // pending guard guarantees the previewed options match the current ones
    // (a superseded preview cannot be committed).
    if (pending) return;
    const result = preview.result;
    if (!result?.proposal || preview.options !== generationOptions) return;
    services.store.execute(applyGenerationResultCommand(doc, result, patternName || undefined));
    onClose();
  }, [pending, preview, generationOptions, patternName, doc, services, onClose]);

  const handleRandomSeed = useCallback(() => setSeed((prev) => randomSeed(prev)), []);

  if (!open) return null;

  return (
    <div className="generate-dialog-backdrop" role="dialog" aria-label="Generate pattern">
      <div className="generate-dialog" ref={dialogRef}>
        <div className="generate-dialog-header">
          <span className="generate-dialog-title">GENERATE PATTERN</span>
          <button type="button" className="btn btn-small" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="generate-dialog-body">
          {/* Mode toggle */}
          <div className="generate-field">
            <label className="generate-label">MODE</label>
            <div className="generate-mode-row">
              <button
                type="button"
                className={`btn btn-small${replaceMode === "new" ? " active-solo" : ""}`}
                onClick={() => setReplaceMode("new")}
              >
                NEW
              </button>
              <button
                type="button"
                className={`btn btn-small${replaceMode === "replace" ? " active-solo" : ""}`}
                onClick={() => setReplaceMode("replace")}
              >
                REPLACE
              </button>
            </div>
          </div>

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
            <select className="generate-select" value={style} onChange={(e) => setStyle(e.target.value)}>
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
              <button type="button" className="btn btn-small" onClick={handleRandomSeed} title="Random seed">
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

          {/* Track targeting */}
          <div className="generate-divider" />
          <div className="generate-advanced-title">TARGETS</div>

          {drumTracks.length > 1 && (
            <div className="generate-field">
              <label className="generate-label">DRUM TRACK</label>
              <select className="generate-select" value={drumTrackId} onChange={(e) => setDrumTrackId(e.target.value)}>
                <option value="">First drum track</option>
                {drumTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {instrumentTracks.length > 0 && (
            <div className="generate-field">
              <label className="generate-label">INSTRUMENT</label>
              <select
                className="generate-select"
                value={instrumentTrackId}
                onChange={(e) => setInstrumentTrackId(e.target.value)}
              >
                <option value="">First instrument</option>
                {instrumentTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Source pattern for seed derivation */}
          {patterns.length > 0 && (
            <div className="generate-field">
              <label className="generate-label">SOURCE PATTERN</label>
              <select
                className="generate-select"
                value={sourcePatternId}
                onChange={(e) => setSourcePatternId(e.target.value)}
              >
                <option value="">None (use seed)</option>
                {patterns.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || `Pattern`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Groove integration */}
          <div className="generate-field">
            <label className="generate-label">APPLY GROOVE</label>
            <button
              type="button"
              className={`btn btn-small${applyGrooveSettings ? " active-solo" : ""}`}
              onClick={() => setApplyGrooveSettings(!applyGrooveSettings)}
            >
              {applyGrooveSettings ? "ON" : "OFF"}
            </button>
          </div>

          {/* Preview */}
          <div className="generate-divider" />
          <div className="generate-advanced-title">PREVIEW</div>
          <PatternPreview rows={previewRows.rows} activePads={previewRows.activePads} />
          {!pending && preview.result && !preview.result.proposal && (
            <div className="generate-advanced-title" role="alert">
              Generation rejected — adjust the intent or seed.
            </div>
          )}

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
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={pending || !preview.result?.proposal || preview.options !== generationOptions}
            onClick={handleGenerate}
          >
            {pending ? "…" : "GENERATE"}
          </button>
        </div>
      </div>
    </div>
  );
}
