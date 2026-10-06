import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "./context";
import {
  PITCH_CLASSES,
  REFERENCE_STAGE_LABELS,
  analyzeReferenceAsync,
  applyResonanceCutsCommand,
  attributeMatchToStrips,
  bpmCommand,
  buildReferenceMatch,
  confidenceLabel,
  decodeReferenceFile,
  describeResonance,
  effectiveBpm,
  grooveCommand,
  keyCommand,
  markerCommand,
  matchStripMoves,
  applyMatchCommand,
  sectionMarkerCommand,
  toMono,
  toPercent,
  type MatchStrip,
  type ReferenceMatchReport,
  type ReferenceKeyCandidate,
  type ReferenceMap,
  type ReferenceMode,
  type ReferenceStage,
  type TempoCandidate,
} from "../reference";
import { transcribeTrackAsync } from "../reference/reference-client";
import { analyzeSectionMix, type SectionMixFinding } from "../analysis/sectionMixDoctor";
import { restyleCommand, artistLabels } from "../reference/restyle";
import {
  projectFingerprint,
  similarityAdvisory,
  sourceFingerprintFromTranscription,
  type SimilarityVerdict,
} from "../analysis/similarity-advisory";
import { separateHPSS } from "../analysis/hpss";
import { unsunoCommand } from "../reference/unsuno";
import { downloadBlob } from "../export/download";
import { encodeWav } from "../rendering/wav";
import { sanitizeFilename } from "../rendering/wav";
import { MAX_AUDIO_IMPORT_BYTES } from "./DropZone";
import { type ProjectDocument } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import type { Command } from "../commands/types";
import { setMasterConfig } from "../commands/master";
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

type TabId = "map" | "rhythm" | "harmony" | "diag" | "match";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "map", label: "MAPA" },
  { id: "rhythm", label: "RYTMUS" },
  { id: "harmony", label: "HARMONIA" },
  { id: "diag", label: "DIAGNOSTIKA" },
  { id: "match", label: "MATCH" },
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
  /** Original decoded channels — the MATCH tab re-measures the reference. */
  channels: Float32Array[];
  sampleRate: number;
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
      setMixFindings(null);
      setMixFix(null);
      setSourceFingerprint(null);
      setSimilarity(null);

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
          channels: decoded.channels,
          sampleRate: decoded.sampleRate,
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
  // U6 — UN-SUNO reconstruction flow: two-step confirm, then one command.
  const [buildBusy, setBuildBusy] = useState(false);
  const [buildConfirm, setBuildConfirm] = useState(false);
  // S4 — separation choice for BUILD: off (full mix), hpss (Tier-1 guide
  // stems), model (htdemucs, only when the fetched+gated manifest exists).
  const [separation, setSeparation] = useState<"off" | "hpss" | "model">("off");
  const [modelAvailable, setModelAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { stemModelFlagOn, probeStemModelManifest, manifestGatePassed } =
          await import("../analysis/stem-model/gate");
        if (!stemModelFlagOn()) return;
        const manifest = await probeStemModelManifest();
        if (alive && manifest && manifestGatePassed(manifest)) setModelAvailable(true);
      } catch {
        /* availability is a bonus — the select degrades */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  // U5 — mix-doctor findings over the SOURCE, measured at build time; the
  // fix chip (when the full-source report has a mechanical fix) applies a
  // master config as one more undo step.
  // S2 — stems export: HPSS guide stems for any analyzed track, three WAVs.
  const [stemsBusy, setStemsBusy] = useState(false);
  const [mixFindings, setMixFindings] = useState<SectionMixFinding[] | null>(null);
  const [mixFix, setMixFix] = useState<{ tiltDb: number; masterGain: number; label: string } | null>(null);
  // RE-STYLE REMIX BRIDGE — keep the composition, swap the band.
  const [restyleArtist, setRestyleArtist] = useState("");
  // Similarity advisory — the SOURCE fingerprint captured at build time,
  // compared against the CURRENT project on demand.
  const [sourceFingerprint, setSourceFingerprint] = useState<ReturnType<
    typeof sourceFingerprintFromTranscription
  > | null>(null);
  const [similarity, setSimilarity] = useState<SimilarityVerdict | null>(null);

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

  // U6 — BUILD PROJECT: transcribe the analyzed signal (tempo/key/chords/
  // bass/drums — all three layers live now) and rebuild it as an editable
  // project in ONE undoable command. Corrected values win over detections
  // exactly like every other Apply action here; without a correction the
  // chord-sequence key from the transcription itself stays authoritative.
  const buildProject = useCallback(async () => {
    if (!analysis || buildBusy) return;
    setBuildBusy(true);
    setError(null);
    try {
      // Yield one frame so the busy state paints before the synchronous
      // transcription blocks the thread for a second or two.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const mono = toMono(analysis.channels);
      const sectionsOfResult = analysis.map.structure?.sections.map((section) => ({
        role: section.role,
        startSec: section.startSec,
        endSec: section.endSec,
        energy: section.energy,
      }));
      // U6 — the heavy transcription runs in the reference worker (sync
      // fallback where module workers are unavailable); never blocks the UI.
      const transcription = await transcribeTrackAsync(mono, analysis.sampleRate, {
        sections: sectionsOfResult,
        separation,
      });
      setSourceFingerprint(sourceFingerprintFromTranscription(transcription));
      setSimilarity(null); // new build → previous advisory is stale
      const result = unsunoCommand(
        doc,
        {
          transcription,
          sections: sectionsOfResult,
        },
        {
          reading: correction.reading,
          confirmedBpm: correction.bpm,
          confirmedKey: correction.tonic && shownMode ? { tonic: correction.tonic, mode: shownMode } : null,
          sourceSampleId: sourceSampleRef.current,
        },
      );
      if (!result.command) {
        setApplied(`UN-SUNO: ${result.summary}`);
        setBuildConfirm(false);
        return;
      }
      services.store.execute(result.command);
      // U4.5 completion: the command stays pure, so the WARP warm-up for the
      // freshly attached source clip happens here, caller-side.
      if (result.needsWarpWarm && sourceSampleRef.current) {
        const fresh = services.store.doc;
        const clip = fresh.arrangement.audioClips?.find((c) => c.bufferId === sourceSampleRef.current);
        if (clip) services.engine.warmWarpForClip(clip);
      }
      setApplied(`UN-SUNO: ${result.summary} (one undo step)`);
      // U5 — mix-doctor beside you: measure the SOURCE the project came
      // from. Balance/masking findings are report-only; the master-fix chip
      // (tilt / master trim) comes from the existing mechanical-fix rule.
      try {
        setMixFindings(analyzeSectionMix(analysis.channels, analysis.sampleRate, sectionsOfResult ?? []));
        const { analyzeMixHealth, deriveMixAutoFix } = await import("../analysis/mixDoctor");
        setMixFix(deriveMixAutoFix(analyzeMixHealth(analysis.channels, analysis.sampleRate)));
      } catch {
        setMixFindings(null);
        setMixFix(null);
      }
      setBuildConfirm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconstruction failed.");
    } finally {
      setBuildBusy(false);
    }
  }, [analysis, buildBusy, correction.reading, correction.bpm, correction.tonic, doc, services.store, shownMode]);

  // S2 — export the analyzed track's HPSS guide stems as three WAVs
  // (percussive / harmonic / bass). Deterministic: the same file always
  // produces byte-identical WAVs (separateHPSS is pinned bit-identical,
  // the encoder is a pure function).
  const exportStems = useCallback(async () => {
    if (!analysis || stemsBusy) return;
    setStemsBusy(true);
    setError(null);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const mono = toMono(analysis.channels);
      const stems = separateHPSS(mono, analysis.sampleRate, { maxSeconds: 120 });
      if (!stems) {
        setApplied("Stems: signal too quiet to separate.");
        return;
      }
      const context = services.engine.ensureContext() as AudioContext;
      const base = analysis.fileName.replace(/\.[^.]+$/, "");
      const exportOne = (stem: Float32Array, suffix: string): void => {
        const buffer = context.createBuffer(1, stem.length, analysis.sampleRate);
        buffer.copyToChannel(new Float32Array(stem), 0);
        downloadBlob(new Blob([encodeWav(buffer, 16)], { type: "audio/wav" }), `${base}-${suffix}.wav`);
      };
      exportOne(stems.percussive, "percussive");
      exportOne(stems.harmonic, "harmonic");
      exportOne(stems.bass, "bass");
      setApplied(`Exported 3 guide stems (percussive / harmonic / bass) — deterministic per input.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stems export failed.");
    } finally {
      setStemsBusy(false);
    }
  }, [analysis, stemsBusy, services.engine]);

  // DropZone shortcut: an imported file can ask this panel to analyze it.
  // The bank id rides along so BUILD PROJECT can attach the original.
  const sourceSampleRef = useRef<string | null>(null);
  useEffect(() => {
    const onExternal = (event: Event) => {
      const detail = (event as CustomEvent<{ file: File; sampleId?: string }>).detail;
      if (detail?.file instanceof File) {
        sourceSampleRef.current = detail.sampleId ?? null;
        void analyze(detail.file);
      }
    };
    window.addEventListener("pf:unsuno-analyze", onExternal);
    return () => window.removeEventListener("pf:unsuno-analyze", onExternal);
  }, [analyze]);

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

  // ---------------------------------------------------------------------------
  // MATCH — "ako ďaleko som od referencie" (reference-matching wave).
  //
  // Renders the CURRENT project pre-master (the match measures the MIX, not
  // the master's reaction to it — the match-eq precedent), measures both
  // sides through the SAME analyzers, and shows the deltas. Per-track
  // attribution renders each content track as its own stem so a band gap can
  // name the strip that owns it. APPLY lands the master match-EQ curve +
  // loudness trim + every unmuted fader move as ONE undo step. Nothing is
  // auto-applied.
  // ---------------------------------------------------------------------------
  const [matchReport, setMatchReport] = useState<ReferenceMatchReport | null>(null);
  const [matchStrips, setMatchStrips] = useState<MatchStrip[]>([]);
  const [matchBusy, setMatchBusy] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);

  const runMatch = useCallback(async () => {
    if (!analysis) return;
    setMatchBusy(true);
    setMatchError(null);
    setMatchReport(null);
    setMatchStrips([]);
    try {
      const { renderProject } = await import("../rendering/renderer");
      const buffer = await renderProject(doc, services.bank, {
        mode: "pattern",
        sampleRate: 44100,
        tailSeconds: 0.3,
        masterProcessing: false,
      });
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
      const report = buildReferenceMatch(
        { channels, sampleRate: buffer.sampleRate },
        { channels: analysis.channels, sampleRate: analysis.sampleRate },
      );
      setMatchReport(report);

      // Per-track attribution: render each content track as its own pre-master
      // stem so a band gap can name the strip that owns it. Failures degrade
      // to no attribution, never a broken measurement.
      const strips = await collectMatchStrips(doc, services.bank);
      setMatchStrips(strips);
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : "Match failed.");
    } finally {
      setMatchBusy(false);
    }
  }, [analysis, doc, services.bank]);

  const applyMatch = useCallback(() => {
    if (!matchReport) return;
    // ONE command: master match-EQ curve + loudness trim + every unmuted
    // per-track fader move folded into a single undo step.
    const moves = matchStripMoves(matchReport, matchStrips);
    const command = applyMatchCommand(doc, matchReport, moves);
    if (!command) {
      setApplied("Nothing worth applying — the mix already matches.");
      return;
    }
    services.store.execute(command);
    setApplied(command.label);
  }, [matchReport, matchStrips, doc, services.store]);

  /** Cut every detected resonance on ONE track (the native EQ's two free
   *  bands) as a single undo step. */
  const applyResonancesForStrip = useCallback(
    (strip: MatchStrip) => {
      const peaks = strip.resonances ?? [];
      const command = applyResonanceCutsCommand(doc, strip.id, peaks);
      if (!command) {
        setApplied(`No resonances to cut on ${strip.name}.`);
        return;
      }
      services.store.execute(command);
      setApplied(`${strip.name}: ${command.label}`);
    },
    [doc, services.store],
  );

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
            <label className="reference-separation-field" data-testid="reference-separation-field">
              <span>Separácia</span>
              <select
                value={separation}
                onChange={(e) => setSeparation(e.target.value as "off" | "hpss" | "model")}
                data-testid="reference-separation"
                disabled={!analysis}
              >
                <option value="off">vyp (plný mix)</option>
                <option value="hpss">HPSS guide</option>
                <option value="model" disabled={!modelAvailable}>
                  model (htdemucs{modelAvailable ? " — WebGPU/wasm" : ""})
                </option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => void exportStems()}
              disabled={!analysis || stemsBusy}
              data-testid="reference-export-stems"
              title="UN-SUNO Tier-1: exportuje 3 guide stemy (percussive / harmonic / bass) ako WAV — deterministické pre rovnaký vstup"
            >
              {stemsBusy ? "SEPARUJEM…" : "🎛 Export stems (3)"}
            </button>
            {buildConfirm ? (
              <span className="reference-build-confirm" data-testid="reference-build-confirm">
                <span className="reference-build-confirm-text">Postaviť projekt z tejto analýzy?</span>
                <button
                  type="button"
                  onClick={() => void buildProject()}
                  disabled={buildBusy}
                  data-testid="reference-build-go"
                  title="Vytvorí tracky, patterny a markery z transkripcie — jedno Ctrl-Z vráti všetko"
                >
                  {buildBusy ? "STAVIA…" : "Postaviť"}
                </button>
                <button type="button" onClick={() => setBuildConfirm(false)} disabled={buildBusy}>
                  Zrušiť
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setBuildConfirm(true)}
                disabled={!analysis || buildBusy}
                data-testid="reference-build"
                title="UN-SUNO: rozloží track na editovateľný projekt — tracky, patterny, markery (jedno undo)"
              >
                🎛 BUILD PROJECT
              </button>
            )}
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
            {mixFindings && (mixFindings.length > 0 || mixFix) && (
              <ul className="unsuno-mix-findings" data-testid="unsuno-mix-findings">
                {mixFindings.map((finding, index) => (
                  <li key={`${finding.kind}-${finding.section ?? "track"}-${index}`} className="unsuno-mix-finding">
                    <span className="unsuno-mix-finding-text" title={finding.evidence}>
                      🔎 {finding.message}
                    </span>
                  </li>
                ))}
                {mixFix && (
                  <li className="unsuno-mix-finding">
                    <button
                      type="button"
                      className="btn btn-small"
                      data-testid="unsuno-mix-fix"
                      onClick={() => {
                        const patch: { tiltDb?: number; masterGain?: number } = {};
                        if (mixFix.tiltDb !== 0) patch.tiltDb = mixFix.tiltDb;
                        if (mixFix.masterGain !== 1) patch.masterGain = mixFix.masterGain;
                        if (Object.keys(patch).length === 0) return;
                        services.store.execute(setMasterConfig(services.store.doc, patch));
                        setApplied(`Mix fix: ${mixFix.label} (one undo step)`);
                      }}
                      title={`Mechanicky bezpečný fix: ${mixFix.label}`}
                    >
                      🔧 Opraviť: {mixFix.label}
                    </button>
                  </li>
                )}
              </ul>
            )}
            {sourceFingerprint && (
              <div className="restyle-row">
                <button
                  type="button"
                  className="btn btn-small"
                  data-testid="similarity-go"
                  onClick={() =>
                    setSimilarity(similarityAdvisory(sourceFingerprint, projectFingerprint(services.store.doc)))
                  }
                  title="Numerický kompozičný overlap projektu vs zdrojový track — NIE právna clearance"
                >
                  🔍 Similarity advisory
                </button>
                {similarity && (
                  <span className="similarity-verdict" data-testid="similarity-verdict">
                    <b>{Math.round(similarity.overall * 100)} %</b> — {similarity.verdict}.{" "}
                    <span className="similarity-disclaimer">{similarity.disclaimer}</span>
                  </span>
                )}
              </div>
            )}
            {applied?.includes("UN-SUNO") && (
              <div className="restyle-row" data-testid="restyle-row">
                <input
                  list="restyle-artists"
                  value={restyleArtist}
                  onChange={(e) => setRestyleArtist(e.target.value)}
                  placeholder="🎨 re-style ako umelec (napíš meno alebo vyber)…"
                  data-testid="restyle-artist-input"
                  aria-label="Artist for re-style"
                />
                <datalist id="restyle-artists">
                  {artistLabels().map((label) => (
                    <option key={label} value={label} />
                  ))}
                </datalist>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={!restyleArtist.trim()}
                  data-testid="restyle-go"
                  onClick={() => {
                    const result = restyleCommand(services.store.doc, restyleArtist);
                    if (!result.command) {
                      setApplied(`Re-style: ${result.summary}`);
                      return;
                    }
                    services.store.execute(result.command);
                    setRestyleArtist("");
                    setApplied(`🎨 ${result.summary} (one undo step)`);
                  }}
                  title="Zamení kapelu (kit + inštrumenty + mix) — kompozícia (patterny, noty) zostáva; jedno undo"
                >
                  🎨 RE-STYLE
                </button>
              </div>
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
            {tab === "match" && (
              <MatchTab
                report={matchReport}
                strips={matchStrips}
                busy={matchBusy}
                error={matchError}
                hasAnalysis={analysis !== null}
                onRun={runMatch}
                onApply={applyMatch}
                onApplyResonances={applyResonancesForStrip}
                canApply={
                  matchReport !== null &&
                  (matchReport.curve !== null ||
                    matchReport.loudnessTrimDb !== null ||
                    matchStripMoves(matchReport, matchStrips).some((m) => m.gainDb !== 0))
                }
              />
            )}
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

/**
 * Render the project's content tracks as individual pre-master stems and
 * measure each — the mix-diagnosis attribution path, bounded to the same 14
 * strips the agent tool caps at. Per-track failures are swallowed (a stem that
 * will not render simply is not attributed; the match measurement itself still
 * stands). Only tracks with playable content are rendered: an empty track
 * owning nothing is not a finding.
 */
async function collectMatchStrips(doc: ProjectDocument, bank: SampleBank): Promise<MatchStrip[]> {
  const { renderProject } = await import("../rendering/renderer");
  const { buildStemProject } = await import("../rendering/stems");
  const { analyzeMixHealth } = await import("../analysis/mixDoctor");
  const { analyzeResonances } = await import("../reference/resonance");
  const contentTracks = new Set<string>();
  for (const pattern of doc.patterns) {
    for (const trackId of Object.keys(pattern.notes ?? {})) {
      if ((pattern.notes?.[trackId] ?? []).length > 0) contentTracks.add(trackId);
    }
    for (const padId of Object.keys(pattern.rows ?? {})) {
      if ((pattern.rows?.[padId] ?? []).some((v) => v > 0)) {
        const owner = doc.tracks.find((t) => t.kind === "drum" && t.pads.some((pad) => pad.id === padId));
        if (owner) contentTracks.add(owner.id);
      }
    }
  }
  for (const clip of doc.arrangement.audioClips ?? []) contentTracks.add(clip.trackId);

  const candidates = doc.tracks.filter((t) => t.kind !== "group" && contentTracks.has(t.id)).slice(0, 14);
  const strips: MatchStrip[] = [];
  for (const track of candidates) {
    try {
      const stemDoc = buildStemProject(doc, (candidate) => candidate.id === track.id);
      const buffer = await renderProject(stemDoc, bank, {
        mode: "pattern",
        sampleRate: 44100,
        tailSeconds: 0.3,
        masterProcessing: false,
      });
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
      const report = analyzeMixHealth(channels, buffer.sampleRate);
      strips.push({
        id: track.id,
        name: track.name,
        kind: track.kind === "drum" ? "drum" : "instrument",
        lufs: report.integratedLufs,
        bandShares: report.bandShares,
        hasContent: true,
        muted: track.mute === true,
        // Narrow problem peaks in this stem's own spectrum — the per-track
        // "cut 120 Hz" detector. Mono sum so a hard-panned strip is not
        // analysed half-empty.
        resonances: analyzeResonances(toMono(channels), buffer.sampleRate),
      });
    } catch {
      // Degrade to no attribution for this strip.
    }
  }
  return strips;
}

/**
 * MATCH — "ako ďaleko som od referencie". The measured comparison: both
 * sides through the same analyzers, the band table in dB-of-share, and the
 * concrete APPLY (master match-EQ curve + loudness trim, one undo step).
 *
 * Honesty rules rendered, not just measured:
 *   - nothing auto-applies — the button is the only path to a command;
 *   - sub-deadzone gaps read "—" not "0.0 dB" (no trivia chasing);
 *   - the reference's own descriptors are NEVER shown as a target — only the
 *     measured DIFFERENCE is a suggestion (the F2 §2.2 rule).
 */
function MatchTab({
  report,
  strips,
  busy,
  error,
  hasAnalysis,
  onRun,
  onApply,
  onApplyResonances,
  canApply,
}: {
  report: ReferenceMatchReport | null;
  strips: readonly MatchStrip[];
  busy: boolean;
  error: string | null;
  hasAnalysis: boolean;
  onRun: () => void;
  onApply: () => void;
  onApplyResonances: (strip: MatchStrip) => void;
  canApply: boolean;
}) {
  // Per-track attribution is derived from the measured report + strips — pure,
  // computed at render, so it can never drift from the table above it.
  const moves = report ? matchStripMoves(report, strips) : [];
  const attributions = report ? attributeMatchToStrips(report, strips) : [];
  // Resonances come from the per-strip spectra; show only strips that found a
  // narrow problem peak, worst-first.
  const resonantStrips = strips
    .map((strip) => ({ strip, peaks: strip.resonances ?? [] }))
    .filter((entry) => entry.peaks.length > 0)
    .sort((a, b) => (b.peaks[0]?.prominenceDb ?? 0) - (a.peaks[0]?.prominenceDb ?? 0));
  return (
    <div className="reference-match" data-testid="reference-match">
      <div className="reference-match-header">
        <button type="button" onClick={onRun} disabled={!hasAnalysis || busy} data-testid="reference-match-run">
          {busy ? "Measuring…" : "Measure the mix vs the reference"}
        </button>
        {report && (
          <button
            type="button"
            onClick={onApply}
            disabled={!canApply}
            title={
              canApply
                ? "Apply the match-EQ curve + loudness trim (one undo step)"
                : "Nothing worth moving — the mix already matches"
            }
            data-testid="reference-match-apply"
          >
            APPLY MATCH
          </button>
        )}
      </div>

      {error && (
        <p className="panel-error" role="alert" data-testid="reference-match-error">
          {error}
        </p>
      )}

      {report && (
        <>
          <p className="reference-summary" data-testid="reference-match-summary">
            {report.summary}
          </p>

          <table className="reference-match-table" data-testid="reference-match-table">
            <thead>
              <tr>
                <th>Band</th>
                <th>Range</th>
                <th>Mix</th>
                <th>Reference</th>
                <th>Δ</th>
              </tr>
            </thead>
            <tbody>
              {report.bands.map((row) => (
                <tr
                  key={row.band}
                  className={
                    !row.empty && Math.abs(row.deltaDb) >= 1.5 ? "is-gapped" : row.empty ? "is-empty" : undefined
                  }
                  data-testid={`reference-match-band-${row.band}`}
                >
                  <td>{row.label}</td>
                  <td>{row.hz}</td>
                  <td>{row.mixDb.toFixed(1)} dB</td>
                  <td>{row.refDb.toFixed(1)} dB</td>
                  <td>
                    {/* A band empty on BOTH sides has no information in its
                        delta — showing a filter-leakage number as a gap would
                        send the user after a band neither mix occupies. */}
                    {row.empty || Math.abs(row.deltaDb) < 1.5
                      ? "—"
                      : `${row.deltaDb > 0 ? "+" : ""}${row.deltaDb.toFixed(1)} dB`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="reference-match-meta">
            <dt>Loudness</dt>
            <dd data-testid="reference-match-loudness">
              {report.loudness.mixLufs === null || report.loudness.refLufs === null
                ? "unmeasurable"
                : `mix ${report.loudness.mixLufs} vs ref ${report.loudness.refLufs} LUFS → ${
                    report.loudnessTrimDb === null
                      ? "no trim worth making"
                      : `${report.loudnessTrimDb > 0 ? "+" : ""}${report.loudnessTrimDb} dB trim`
                  }`}
            </dd>
            <dt>Stereo</dt>
            <dd data-testid="reference-match-stereo">
              {report.stereo.verdict === "unknown"
                ? "unmeasurable"
                : report.stereo.verdict === "wider-reference"
                  ? `the reference is wider (side ratio ${report.stereo.refSideRatio}) — widen the mix or pick a narrower reference`
                  : report.stereo.verdict === "narrow-reference"
                    ? `the reference is narrower (side ratio ${report.stereo.refSideRatio})`
                    : "similar width"}
            </dd>
            {report.curve && (
              <>
                <dt>Match-EQ curve</dt>
                <dd data-testid="reference-match-curve">
                  low {report.curve.low > 0 ? "+" : ""}
                  {report.curve.low} · low-mid {report.curve.lowMid > 0 ? "+" : ""}
                  {report.curve.lowMid} · high-mid {report.curve.highMid > 0 ? "+" : ""}
                  {report.curve.highMid} · high {report.curve.high > 0 ? "+" : ""}
                  {report.curve.high} dB
                </dd>
              </>
            )}
          </dl>

          {/* Per-track attribution — WHO owns the bands with a real gap. Only
              bands whose top strip holds ≥40% of that band's energy appear;
              an ownership guess below that is an invented target, not a
              measurement. Rendered from the measured report + strips, so it
              can never disagree with the table above. */}
          {attributions.length > 0 && (
            <div className="reference-match-attribution" data-testid="reference-match-attribution">
              <h4>Who owns the gap</h4>
              <ul>
                {moves.map((move) => (
                  <li key={move.band.band} data-testid={`reference-match-owner-${move.band.band}`}>
                    {move.reason}
                  </li>
                ))}
              </ul>
              <p className="panel-sub">
                Ownership is energy-weighted (loudness × band share), the same math the agent's mix diagnosis uses.
                Moves are half the measured gap, clamped ±3 dB, and apply as one undo.
              </p>
            </div>
          )}

          {/* Problem frequencies — narrow resonances found in each strip's own
              spectrum, each with a bounded EQ cut on the native EQ's free
              surgical band. A flat spectrum yields nothing here (no invented
              problems); the cut is the panel's per-track APPLY, one undo. */}
          {resonantStrips.length > 0 && (
            <div className="reference-match-resonances" data-testid="reference-match-resonances">
              <h4>Problem frequencies</h4>
              <ul>
                {resonantStrips.map(({ strip, peaks }) => (
                  <li key={strip.id} data-testid={`reference-match-resonance-${strip.id}`}>
                    <strong>{strip.name}</strong>
                    <ul>
                      {peaks.map((peak) => (
                        <li key={`${strip.id}-${peak.hz}`}>{describeResonance(peak)}</li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={() => onApplyResonances(strip)}
                      data-testid={`reference-match-resonance-apply-${strip.id}`}
                      title="Notch these peaks on this track (one undo step)"
                    >
                      CUT on {strip.name}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="panel-sub">
                Found by an averaged periodogram: local maxima above the local spectral median, with Q from each
                peak&apos;s −3 dB bandwidth. The cut is 0.7× the prominence, clamped −12 dB, on the EQ&apos;s free band.
              </p>
            </div>
          )}

          <p className="panel-sub reference-match-note">
            Shape, not volume: the curve is de-meaned (a match is never a hidden gain move) and clamped ±6 dB. APPLY is
            one undo step — re-measure after to see what landed.
          </p>
        </>
      )}

      {!report && !busy && !error && (
        <p className="panel-sub">
          Renders the current pattern pre-master and compares it with the reference: band by band, in loudness-invariant
          shares. The APPLY button lands a master match-EQ curve + loudness trim — always yours to press, never
          automatic.
        </p>
      )}
    </div>
  );
}
