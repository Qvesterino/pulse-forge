import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "./context";
import {
  PITCH_CLASSES,
  REFERENCE_STAGE_LABELS,
  analyzeReferenceAsync,
  bpmCommand,
  confidenceLabel,
  decodeReferenceFile,
  effectiveBpm,
  grooveCommand,
  keyCommand,
  markerCommand,
  sectionMarkerCommand,
  toMono,
  toPercent,
  type ReferenceKeyCandidate,
  type ReferenceMap,
  type ReferenceMode,
  type ReferenceStage,
  type TempoCandidate,
} from "../reference";
import { downloadBlob } from "../export/download";
import { sanitizeFilename } from "../rendering/wav";
import { MAX_AUDIO_IMPORT_BYTES } from "./DropZone";
import { type ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import { useDoc } from "./context";

/**
 * Reference Map — F4-lite surface.
 *
 * Drops a finished track and reports what it is: tempo (with the half/double
 * reading a producer actually argues about), key + Camelot code, and how sure
 * the engine is. Everything here is a *display projection* of an immutable
 * {@link ReferenceMap} — the panel never edits the analysis, it records user
 * corrections alongside it.
 *
 * Why corrections are local rather than a rewrite: the F1 contract is "same
 * file → same output". Baking a user correction into the map would make the
 * export lie about what the engine found, and the two answers are genuinely
 * different facts — "the detector says 128, I say 132" is the useful record.
 * So the export carries `detected` and `confirmed` side by side.
 *
 * The analysis itself is pure: no RNG, no network, no time dependence. That is
 * what makes the JSON export comparable between sessions and machines.
 *
 * No raw-DOM injection anywhere (invariant #10) — every user-controlled string
 * (the dropped file name) is rendered through JSX, which escapes it, and only
 * reaches the filesystem through `sanitizeFilename`. Note: the invariant
 * scanner matches the forbidden token as raw text, so naming it in this
 * comment would itself trip the check.
 */

const ACCEPTED_EXTENSIONS = /\.(wav|wave|mp3|ogg|oga|flac|aiff|aif|m4a|aac|opus|webm)$/i;
const MIN_BPM = 20;
const MAX_BPM = 400;

type TabId = "map" | "rhythm" | "harmony" | "diag";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "map", label: "MAPA" },
  { id: "rhythm", label: "RYTMUS" },
  { id: "harmony", label: "HARMONIA" },
  { id: "diag", label: "DIAGNOSTIKA" },
];

/** A user correction, kept beside the detected value rather than over it. */
interface Correction {
  bpm: number | null;
  tonic: string | null;
  mode: ReferenceMode | null;
  /** Which reading of the detected tempo the user believes. */
  reading: "as-detected" | "half" | "double";
}

interface Analyzed {
  /** Sanitized — this string reaches the download name. */
  fileName: string;
  map: ReferenceMap;
  /** Downsampled onset envelope for the MAPA waveform. */
  envelope: number[];
  frameRate: number;
}

const EMPTY_CORRECTION: Correction = { bpm: null, tonic: null, mode: null, reading: "as-detected" };

/** Reading-adjusted tempo, or null when the detector found nothing to adjust. */
function applyReading(bpm: number | null, reading: Correction["reading"]): number | null {
  if (bpm === null) return null;
  if (reading === "half") return bpm / 2;
  if (reading === "double") return bpm * 2;
  return bpm;
}

export function ReferenceMapPanel() {
  const services = useServices();
  const [tab, setTab] = useState<TabId>("map");
  const [analysis, setAnalysis] = useState<Analyzed | null>(null);
  const [stage, setStage] = useState<ReferenceStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [correction, setCorrection] = useState<Correction>(EMPTY_CORRECTION);
  const [bpmDraft, setBpmDraft] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  // Monotonic job id. A result is only accepted if it belongs to the newest
  // job — otherwise switching tabs/files mid-analysis lets a slow decode
  // land on top of the result the user is already looking at.
  const jobRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const analyze = useCallback(
    async (file: File) => {
      setError(null);
      setAnalysis(null);
      setCorrection(EMPTY_CORRECTION);
      setBpmDraft("");

      if (!ACCEPTED_EXTENSIONS.test(file.name)) {
        setError("Unsupported file. Use WAV, MP3, OGG, FLAC, AIFF, M4A or OPUS.");
        return;
      }
      // Ceiling checked BEFORE decode: decoding a 400 MB file first and
      // rejecting afterwards is the tab-killing failure mode this cap exists
      // to prevent.
      if (file.size > MAX_AUDIO_IMPORT_BYTES) {
        setError(`File is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 25 MB.`);
        return;
      }
      if (file.size === 0) {
        setError("That file is empty.");
        return;
      }

      const job = ++jobRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStage("decoding");

      try {
        const context = services.engine.ensureContext();
        const decoded = await decodeReferenceFile(file, context as AudioContext);
        // Discard: a newer file was picked (or the panel closed) while this
        // one was still decoding.
        if (!aliveRef.current || job !== jobRef.current) return;

        const mono = toMono(decoded.channels);
        const output = await analyzeReferenceAsync({
          mono,
          // Stereo width needs the ORIGINAL channels — mid/side is the
          // difference between left and right, so the mono downmix has no
          // side component and would report width 0 for every file.
          channels: decoded.channels,
          metadata: {
            // Sanitized up front so the exported JSON and the download name
            // carry a safe string, not just the on-screen one.
            name: sanitizeFilename(file.name),
            size: file.size,
            duration: decoded.duration,
            sampleRate: decoded.sampleRate,
            channels: decoded.channels.length,
          },
          onStage: (next) => {
            if (aliveRef.current && job === jobRef.current) setStage(next);
          },
          signal: controller.signal,
        });
        if (!aliveRef.current || job !== jobRef.current) return;

        setAnalysis({
          fileName: sanitizeFilename(file.name),
          map: output.result,
          envelope: output.onsetEnvelope,
          frameRate: output.onsetFrameRate,
        });
        setStage("done");
      } catch (err) {
        if (!aliveRef.current || job !== jobRef.current) return;
        setStage(null);
        setError(err instanceof Error ? err.message : "Analysis failed.");
      }
    },
    [services.engine],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragOver(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) void analyze(file);
    },
    [analyze],
  );

  const onPick = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) void analyze(file);
      // Reset so picking the same file twice still re-runs the change event.
      event.target.value = "";
    },
    [analyze],
  );

  const exportJson = useCallback(() => {
    if (!analysis) return;
    const { map } = analysis;
    const confirmedBpm = correction.bpm ?? applyReading(map.rhythm.bpm, correction.reading);
    const payload = {
      engineVersion: map.diagnostics.engineVersion,
      schemaVersion: map.diagnostics.schemaVersion,
      file: map.metadata,
      detected: {
        bpm: map.rhythm.bpm,
        key: map.tonal.tonic,
        mode: map.tonal.mode,
        camelot: map.tonal.camelot,
        confidence: {
          rhythm: toPercent(map.rhythm.confidence) / 100,
          tonal: toPercent(map.tonal.confidence) / 100,
        },
      },
      confirmed: {
        bpm: confirmedBpm,
        key: correction.tonic ?? map.tonal.tonic,
        mode: correction.mode ?? map.tonal.mode,
        reading: correction.reading,
        edited: correction.bpm !== null || correction.tonic !== null,
      },
      rhythm: map.rhythm,
      tonal: map.tonal,
      structure: map.structure ?? null,
      descriptors: map.descriptors ?? null,
      diagnostics: map.diagnostics,
      warnings: map.warnings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    downloadBlob(blob, `${analysis.fileName.replace(/\.[^.]+$/, "") || "reference"}-map.json`);
  }, [analysis, correction]);

  const commitBpm = useCallback((raw: string) => {
    setBpmDraft(raw);
    const trimmed = raw.trim();
    if (trimmed === "") {
      setCorrection((c) => ({ ...c, bpm: null }));
      return;
    }
    const value = Number(trimmed);
    // Reject out-of-range and non-numeric input rather than clamping it
    // silently: a typed "1300" is a typo the user should see, not a value
    // quietly rounded into plausible-looking nonsense.
    if (!Number.isFinite(value) || value < MIN_BPM || value > MAX_BPM) return;
    setCorrection((c) => ({ ...c, bpm: value }));
  }, []);

  const rhythmBpm = analysis?.map.rhythm.bpm ?? null;
  const readingBpm = applyReading(rhythmBpm, correction.reading);
  const shownBpm = correction.bpm ?? readingBpm;
  const halfCandidate = useMemo<TempoCandidate | null>(
    () => analysis?.map.rhythm.candidates.find((c) => c.relation === "half-time") ?? null,
    [analysis],
  );
  const doubleCandidate = useMemo<TempoCandidate | null>(
    () => analysis?.map.rhythm.candidates.find((c) => c.relation === "double-time") ?? null,
    [analysis],
  );
  const keyCandidates = analysis?.map.tonal.candidates ?? [];
  const shownTonic = correction.tonic ?? analysis?.map.tonal.tonic ?? null;
  const shownMode = correction.mode ?? analysis?.map.tonal.mode ?? null;

  // ---------------------------------------------------------------------------
  // F4-full — acting on the reference.
  //
  // Every handler routes through the pure builders in `src/reference/apply.ts`
  // and executes ONE command, so each action is a single undo step. The panel
  // never mutates the document itself.
  // ---------------------------------------------------------------------------
  const doc = useDoc();
  const [beatsPerPhrase, setBeatsPerPhrase] = useState(8);
  const [swingPercent, setSwingPercent] = useState(0);
  const [applied, setApplied] = useState<string | null>(null);

  const runCommand = useCallback(
    (build: (d: ProjectDocument) => Command | null, fallback: string) => {
      const command = build(doc);
      if (!command) {
        setApplied(fallback);
        return;
      }
      services.store.execute(command);
      setApplied(command.label);
    },
    [doc, services.store],
  );

  const applyBpm = useCallback(() => {
    if (!analysis) return;
    const bpm = effectiveBpm(analysis.map, correction.reading, correction.bpm);
    if (bpm === null) {
      setApplied("No tempo detected — nothing applied.");
      return;
    }
    runCommand((d) => bpmCommand(d, bpm), "");
  }, [analysis, correction, runCommand]);

  const applyKey = useCallback(() => {
    if (!shownTonic || !shownMode) {
      setApplied("No key detected — nothing applied.");
      return;
    }
    runCommand((d) => keyCommand(d, shownTonic, shownMode), "");
  }, [shownTonic, shownMode, runCommand]);

  const applyMarkers = useCallback(() => {
    if (!analysis) return;
    const bpm = shownBpm ?? readingBpm ?? doc.bpm;
    const label = analysis.fileName.replace(/\.[^.]+$/, "");
    const sections = analysis.map.structure?.sections ?? [];
    // Sections are the honest import: the marker says "the drop is here"
    // because the energy analysis put it there. Equal-length phrases are the
    // fallback for a signal with no detectable structure (a flat drone), and
    // the label says which one ran.
    if (sections.length > 0) {
      runCommand((d) => sectionMarkerCommand(d, analysis.map, { bpm, label }), "No sections to import.");
      return;
    }
    runCommand(
      (d) => markerCommand(d, analysis.map, { beatsPerPhrase, bpm, label }),
      "Not enough beats for a phrase marker.",
    );
  }, [analysis, beatsPerPhrase, shownBpm, readingBpm, doc.bpm, runCommand]);

  const applyGroove = useCallback(() => {
    // Manual, not detected: F1 does not measure swing. The slider is the
    // producer's own judgement, and the command writes exactly that.
    runCommand((d) => grooveCommand(d, { swing: swingPercent / 100 }), "Set a swing value first.");
  }, [swingPercent, runCommand]);

  // Tick length is tempo-dependent, so marker placement is only correct if the
  // project is actually running at the reference tempo when the user imports.
  const tempoMismatch = shownBpm !== null && Math.abs(shownBpm - doc.bpm) > 0.5;

  return (
    <div className="panel reference-map-panel" data-testid="reference-map-panel">
      <header className="panel-header">
        <h2>Reference Map</h2>
        <p className="panel-sub">
          Drop a finished track. Tempo, key and how sure the engine is — no upload, no guesswork. The same file always
          gives the same answer.
        </p>
      </header>

      {error && (
        <p className="panel-error" role="alert" data-testid="reference-error">
          {error}
        </p>
      )}

      <div
        className={`reference-dropzone${dragOver ? " is-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        data-testid="reference-dropzone"
      >
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.wav,.mp3,.ogg,.flac,.aiff,.m4a,.opus"
          onChange={onPick}
          style={{ display: "none" }}
          data-testid="reference-file-input"
        />
        {stage && stage !== "done" ? (
          <span data-testid="reference-stage">{REFERENCE_STAGE_LABELS[stage]}…</span>
        ) : (
          <span>Drop a track or click to choose — WAV / MP3 / FLAC / OGG / M4A, up to 25 MB</span>
        )}
      </div>

      {analysis && (
        <>
          <div className="reference-primary" data-testid="reference-primary">
            <div className="reference-primary-bpm" data-testid="reference-bpm">
              {shownBpm === null ? "—" : `${shownBpm.toFixed(2)} BPM`}
            </div>
            <div className="reference-primary-key" data-testid="reference-key">
              {shownTonic === null
                ? "—"
                : `${shownTonic} ${shownMode ?? ""}`.trim() +
                  (analysis.map.tonal.camelot ? ` · ${analysis.map.tonal.camelot}` : "")}
            </div>
            <div className="reference-confidence" data-testid="reference-confidence">
              {rhythmBpm === null && analysis.map.tonal.tonic === null
                ? "Nothing detected"
                : confidenceLabel(toPercent(analysis.map.tonal.confidence))}
            </div>
            {analysis.map.warnings.length > 0 && (
              <ul className="reference-warnings" data-testid="reference-warnings">
                {analysis.map.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="reference-controls">
            <label className="reference-bpm-field">
              BPM
              <input
                type="number"
                min={MIN_BPM}
                max={MAX_BPM}
                step="0.01"
                value={bpmDraft !== "" ? bpmDraft : (readingBpm?.toFixed(2) ?? "")}
                placeholder="detected"
                onChange={(e) => commitBpm(e.target.value)}
                data-testid="reference-bpm-input"
              />
            </label>
            <div className="reference-reading" role="group" aria-label="Tempo reading">
              <button
                type="button"
                onClick={() => setCorrection((c) => ({ ...c, reading: "half" }))}
                disabled={halfCandidate === null && rhythmBpm === null}
                data-testid="reference-half"
              >
                Half
              </button>
              <button
                type="button"
                onClick={() => setCorrection((c) => ({ ...c, reading: "as-detected" }))}
                disabled={correction.reading === "as-detected"}
                data-testid="reference-as-detected"
              >
                As detected
              </button>
              <button
                type="button"
                onClick={() => setCorrection((c) => ({ ...c, reading: "double" }))}
                disabled={doubleCandidate === null && rhythmBpm === null}
                data-testid="reference-double"
              >
                Double
              </button>
            </div>
            <label className="reference-key-field">
              Key
              <select
                value={shownTonic ?? ""}
                onChange={(e) => setCorrection((c) => ({ ...c, tonic: e.target.value || null }))}
                data-testid="reference-key-select"
              >
                <option value="">—</option>
                {PITCH_CLASSES.map((pc) => (
                  <option key={pc} value={pc}>
                    {pc}
                  </option>
                ))}
              </select>
            </label>
            <label className="reference-mode-field">
              Mode
              <select
                value={shownMode ?? ""}
                onChange={(e) =>
                  setCorrection((c) => ({ ...c, mode: (e.target.value || null) as ReferenceMode | null }))
                }
                data-testid="reference-mode-select"
              >
                <option value="">—</option>
                <option value="major">major</option>
                <option value="minor">minor</option>
              </select>
            </label>
            <button type="button" onClick={exportJson} data-testid="reference-export">
              Export JSON
            </button>
          </div>

          <section className="reference-apply" data-testid="reference-apply">
            <h4>Apply to project</h4>
            {tempoMismatch && (
              <p className="panel-sub" data-testid="reference-tempo-warning">
                Project is at {doc.bpm} BPM but the reference reads {shownBpm?.toFixed(2)}. Apply the tempo first —
                marker positions are measured in project ticks, which change with tempo.
              </p>
            )}
            <div className="reference-apply-row">
              <button type="button" onClick={applyBpm} disabled={shownBpm === null} data-testid="reference-apply-bpm">
                Set project BPM
              </button>
              <button
                type="button"
                onClick={applyKey}
                disabled={shownTonic === null || shownMode === null}
                data-testid="reference-apply-key"
              >
                Set project key
              </button>
            </div>
            <div className="reference-apply-row">
              <label>
                Phrase
                <select
                  value={beatsPerPhrase}
                  onChange={(e) => setBeatsPerPhrase(Number(e.target.value))}
                  data-testid="reference-phrase-length"
                >
                  <option value={4}>1 bar</option>
                  <option value={8}>2 bars</option>
                  <option value={16}>4 bars</option>
                  <option value={32}>8 bars</option>
                </select>
              </label>
              <button type="button" onClick={applyMarkers} data-testid="reference-apply-markers">
                Import phrase markers
              </button>
            </div>
            <div className="reference-apply-row">
              <label>
                Swing {swingPercent}%
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={swingPercent}
                  onChange={(e) => setSwingPercent(Number(e.target.value))}
                  data-testid="reference-swing"
                />
              </label>
              <button type="button" onClick={applyGroove} data-testid="reference-apply-groove">
                Apply groove feel
              </button>
            </div>
            <p className="panel-sub reference-apply-note">
              Swing is yours, not the engine's — the analyzer does not measure feel. Each action is one undo step.
            </p>
            {applied && (
              <p className="reference-applied" role="status" data-testid="reference-applied">
                {applied}
              </p>
            )}
          </section>

          <nav className="reference-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                data-testid={`reference-tab-${t.id}`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="reference-tabpanel" role="tabpanel" data-testid={`reference-panel-${tab}`}>
            {tab === "map" && <MapTab analysis={analysis} />}
            {tab === "rhythm" && <RhythmTab map={analysis.map} half={halfCandidate} double={doubleCandidate} />}
            {tab === "harmony" && <HarmonyTab map={analysis.map} candidates={keyCandidates} />}
            {tab === "diag" && <DiagTab map={analysis.map} fileName={analysis.fileName} />}
          </div>
        </>
      )}
    </div>
  );
}

/** MAPA — onset envelope with the detected beat grid drawn over it. */
function MapTab({ analysis }: { analysis: Analyzed }) {
  const { envelope, frameRate, map } = analysis;
  const duration = map.diagnostics.analyzedSeconds;
  // The envelope is max-pooled to ~1500 buckets, so bucket i stands for a
  // span of source frames — recover the span to place beat markers honestly.
  const full = map.diagnostics.onsetEnvelopeLength;
  const step = envelope.length > 0 ? full / envelope.length : 1;
  const peak = useMemo(() => envelope.reduce((m, v) => Math.max(m, v), 0) || 1, [envelope]);
  const sampleCount = envelope.length > 0 ? Math.min(envelope.length, 320) : 0;
  const stride = envelope.length > 0 ? envelope.length / sampleCount : 1;
  const [seekTo, setSeekTo] = useState<number | null>(null);
  const sections = map.structure?.sections ?? [];
  const pct = (sec: number): number => (duration > 0 ? Math.min(100, Math.max(0, (sec / duration) * 100)) : 0);

  return (
    <div className="reference-map" data-testid="reference-map">
      {sections.length > 0 && (
        <div className="reference-sections" data-testid="reference-sections">
          {sections.map((s, i) => (
            <button
              key={i}
              type="button"
              className={`reference-section reference-section-${s.role}`}
              style={{
                left: `${pct(s.startSec)}%`,
                width: `${Math.max(1, pct(s.endSec) - pct(s.startSec))}%`,
              }}
              onClick={() => setSeekTo(s.startSec)}
              title={`${s.role} — ${s.startSec.toFixed(1)}s · energy ${(s.energy * 100).toFixed(0)}%`}
              data-testid={`reference-section-${s.role}`}
            >
              {s.role}
            </button>
          ))}
        </div>
      )}
      <div className="reference-wave" style={{ height: 72 }}>
        {Array.from({ length: sampleCount }, (_, i) => {
          const v = envelope[Math.floor(i * stride)] ?? 0;
          return (
            <span key={i} className="reference-wave-bar" style={{ height: `${Math.max(2, (v / peak) * 100)}%` }} />
          );
        })}
        {map.rhythm.beatTimes.map((t, i) => {
          const bucket = duration > 0 ? (t * frameRate) / step / stride : 0;
          if (bucket < 0 || bucket > sampleCount) return null;
          return <span key={i} className="reference-beat" style={{ left: `${(bucket / sampleCount) * 100}%` }} />;
        })}
        {seekTo !== null && <span className="reference-seek" style={{ left: `${pct(seekTo)}%` }} />}
      </div>
      {map.structure && map.structure.energyCurve.length > 0 && (
        <EnergyStrip
          curve={map.structure.energyCurve}
          average={map.structure.averageEnergy}
          onSeek={(position) => setSeekTo(position * duration)}
        />
      )}
      <p className="panel-sub">
        {map.diagnostics.frameCount} frames · {map.rhythm.beatTimes.length} beats · {duration.toFixed(1)}s
        {sections.length > 0 && ` · ${sections.length} sections`}
        {seekTo !== null && ` · @ ${seekTo.toFixed(2)}s`}
      </p>
    </div>
  );
}

/** F2 energy curve as a thin strip under the waveform; clicking a point seeks there. */
function EnergyStrip({
  curve,
  average,
  onSeek,
}: {
  curve: Array<{ position: number; energy: number }>;
  average: number;
  onSeek: (position: number) => void;
}) {
  const peak = curve.reduce((m, p) => Math.max(m, p.energy), 0) || 1;
  return (
    <div className="reference-energy" data-testid="reference-energy">
      {curve.map((p, i) => (
        <button
          key={i}
          type="button"
          className="reference-energy-bar"
          style={{ left: `${p.position * 100}%`, height: `${Math.max(2, (p.energy / peak) * 100)}%` }}
          onClick={() => onSeek(p.position)}
          title={`energy ${(p.energy * 100).toFixed(0)}% @ ${(p.position * 100).toFixed(0)}%`}
          aria-label={`Energy ${(p.energy * 100).toFixed(0)} percent at ${(p.position * 100).toFixed(0)} percent`}
        />
      ))}
      <span className="reference-energy-avg" style={{ bottom: `${average * 100}%` }} aria-hidden="true" />
    </div>
  );
}

function RhythmTab({
  map,
  half,
  double,
}: {
  map: ReferenceMap;
  half: TempoCandidate | null;
  double: TempoCandidate | null;
}) {
  return (
    <div className="reference-rhythm" data-testid="reference-rhythm">
      <dl>
        <dt>Tempo</dt>
        <dd>{map.rhythm.bpm === null ? "not determined" : `${map.rhythm.bpm.toFixed(2)} BPM`}</dd>
        <dt>Confidence</dt>
        <dd>
          {confidenceLabel(toPercent(map.rhythm.confidence))} ({toPercent(map.rhythm.confidence)}%)
        </dd>
        <dt>Stability</dt>
        <dd>{map.rhythm.stability}</dd>
        <dt>Beat offset</dt>
        <dd>{map.rhythm.beatOffsetSeconds === null ? "—" : `${map.rhythm.beatOffsetSeconds.toFixed(3)}s`}</dd>
        <dt>Half-time</dt>
        <dd>{half === null ? "—" : `${half.bpm.toFixed(2)} BPM`}</dd>
        <dt>Double-time</dt>
        <dd>{double === null ? "—" : `${double.bpm.toFixed(2)} BPM`}</dd>
      </dl>
      <h4>Candidates</h4>
      <ul>
        {map.rhythm.candidates.map((c) => (
          <li key={`${c.relation}-${c.bpm}`}>
            {c.bpm.toFixed(2)} BPM — {c.relation}
          </li>
        ))}
      </ul>
      {map.rhythm.warning && <p className="panel-sub">{map.rhythm.warning}</p>}
    </div>
  );
}

function HarmonyTab({ map, candidates }: { map: ReferenceMap; candidates: ReferenceKeyCandidate[] }) {
  const chroma = map.tonal.chroma;
  const peak = chroma.reduce((m, v) => Math.max(m, v), 0) || 1;
  return (
    <div className="reference-harmony" data-testid="reference-harmony">
      <div className="reference-chroma">
        {chroma.map((v, i) => (
          <div key={PITCH_CLASSES[i]} className="reference-chroma-bin">
            <span className="reference-chroma-bar" style={{ height: `${Math.max(2, (v / peak) * 100)}%` }} />
            <small>{PITCH_CLASSES[i]}</small>
          </div>
        ))}
      </div>
      <p>
        {map.tonal.tonic === null
          ? "Key not determined"
          : `${map.tonal.tonic} ${map.tonal.mode} · ${map.tonal.camelot} · ${confidenceLabel(toPercent(map.tonal.confidence))}`}
      </p>
      <h4>Key candidates</h4>
      <ol>
        {candidates.map((c) => (
          <li key={`${c.tonic}-${c.mode}`}>
            {c.tonic} {c.mode} — {c.score.toFixed(3)}
          </li>
        ))}
      </ol>
      {map.tonal.warning && <p className="panel-sub">{map.tonal.warning}</p>}
    </div>
  );
}

function DiagTab({ map, fileName }: { map: ReferenceMap; fileName: string }) {
  const d = map.diagnostics;
  return (
    <div className="reference-diag" data-testid="reference-diag">
      <dl>
        <dt>File</dt>
        <dd>{fileName}</dd>
        <dt>Engine</dt>
        <dd>{d.engineVersion}</dd>
        <dt>Schema</dt>
        <dd>{d.schemaVersion}</dd>
        <dt>Source rate</dt>
        <dd>{map.metadata.sampleRate} Hz</dd>
        <dt>Analysis rate</dt>
        <dd>{d.analysisSampleRate} Hz</dd>
        <dt>FFT / hop</dt>
        <dd>
          {d.fftSize} / {d.hopSize}
        </dd>
        <dt>Frames</dt>
        <dd>
          {d.frameCount} (chroma {d.tonalFrameCount})
        </dd>
        <dt>Peak / RMS</dt>
        <dd>
          {d.peakAmplitude.toFixed(4)} / {d.rmsLevel.toFixed(4)}
        </dd>
        <dt>Processed in</dt>
        <dd>{d.processingMs} ms</dd>
      </dl>
      <Descriptors map={map} />
    </div>
  );
}

/**
 * F2 §2.2 — the "what is it made of" block. Descriptors only: these describe
 * the reference and are never presented as a mastering target or a suggested
 * EQ curve.
 */
function Descriptors({ map }: { map: ReferenceMap }) {
  const d = map.descriptors;
  if (!d) return null;
  const width = d.stereo.width > 0.5 ? "wide" : d.stereo.width < 0.2 ? "narrow" : "moderate";
  const bright = d.spectral.brightness > 0.5 ? "bright" : "warm / dark";
  return (
    <div className="reference-descriptors" data-testid="reference-descriptors">
      <h4>What it is made of</h4>
      <p className="reference-summary" data-testid="reference-summary">
        {d.summary}
      </p>
      <dl>
        <dt>Character</dt>
        <dd>
          {bright} — centroid {d.spectral.centroidHz.toFixed(0)} Hz, rolloff {d.spectral.rolloffHz.toFixed(0)} Hz
        </dd>
        <dt>Balance</dt>
        <dd>
          low {(d.spectral.lowEnergy * 100).toFixed(0)}% · mid {(d.spectral.midEnergy * 100).toFixed(0)}% · high{" "}
          {(d.spectral.highEnergy * 100).toFixed(0)}%
        </dd>
        <dt>Flatness</dt>
        <dd>{d.spectral.flatness.toFixed(3)}</dd>
        <dt>Loudness</dt>
        <dd>
          {d.loudness.integratedLufs.toFixed(1)} LUFS-ish · peak {d.loudness.peakDbfs.toFixed(1)} dBFS
          {d.loudness.clipped && " · CLIPS"}
        </dd>
        <dt>Crest / range</dt>
        <dd>
          {d.loudness.crestFactorDb.toFixed(1)} dB · {d.loudness.dynamicRangeDb.toFixed(1)} dB
        </dd>
        <dt>Stereo</dt>
        <dd>
          {width} — width {d.stereo.width.toFixed(3)}
        </dd>
        <dt>Groove</dt>
        <dd>
          {d.groove.family.replace(/_/g, " ")} — density {d.groove.drumDensity.toFixed(2)}, syncopation{" "}
          {d.groove.syncopation.toFixed(2)}
        </dd>
      </dl>
    </div>
  );
}
