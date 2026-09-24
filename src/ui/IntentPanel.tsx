import { useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "./context";
import { parseIntentText } from "../intent/text-parser";
import { generateAsyncResult, resultForCandidate } from "../intent/pipeline";
import { parseProductionIntent } from "../intent/production";
import { parseSectionRequests, type SectionParse } from "../intent/sections";
import {
  applySessionCandidateCommand,
  lastGeneration,
  promptHistory,
  rememberGeneration,
  rememberPrompt,
  resolveSessionReference,
} from "../intent/session-context";
import {
  applyGenerationResultCommand,
  applyGenerationResultWithFxCommand,
  applyProductionIntentCommand,
  setMasterConfig,
} from "../commands/commands";
import { applyArrangeOps } from "../intent/arrangeWords";
import { reviseSection, replacePatternInPlaceCommand, applySongCommand, type SongBuildSection } from "../intent/song";
import { composeFullTrack, type ComposeResult } from "../intent/compose";
import { analyzeAudioReference } from "../intent/audio-reference";
import { analyzeVoiceIdea } from "../intent/voice-idea";
import { PcmMicRecorder } from "../audio-engine/PcmMicRecorder";
import { patternLengthTicks } from "../midi/hum-to-notes";
import { extractGrooveGrid, grooveRowsForPads, type GrooveExtraction } from "../intent/groove-extraction";
import { inferPadRole } from "../ai/pad-roles";
import { setAudioReferenceConditioning } from "../intent/semantic-conditioning";
import { downmixToMono, resampleLinear } from "../sample-library/audio-index";
import { applyEffectIntent, applyMixIntent, planMixProfile } from "../intent/mix";
import { applyLoudnessIntent, applyPreviewLoudness } from "../intent/loudness";
import { analyzeLoudnessBuffer } from "../audio-engine/kweighting";
import { routeIntentText, REVISE_DELTA, type ReviseAttribute } from "../intent/route";
import { normalizeIntent } from "../intent/normalize";
import type { IntentInput } from "../intent/types";
import type { NoteEvent } from "../project-model/types";
import { rankerMode } from "../ai/ranking/ranker-client";
import { playAuditionBuffer, renderAuditionBuffer, renderSongAuditionBuffer, stopAudition } from "../intent/audition";
import { semanticIntentFor } from "../intent/semantic";
import { takeIntentPrefill, takeRegenFlag } from "../landing/handoff";
import { freshRegenSeed, intentSnapshotOfDoc, promptFromIntent } from "../gallery/intentCarry";
import { PublishToGalleryButton } from "../gallery/PublishButton";
import { renderProject } from "../rendering/renderer";
import { sanitizeFilename } from "../rendering/wav";
import { canExportVideo, recordVideo } from "../export/video";
import { downloadBlob } from "../export/download";
import { encodeShareCode, shareAppUrl } from "../export/shareCode";
import { funnelEvent } from "../services/funnel";
import type { GenerationResult, RankedCandidate } from "../intent/types";
import type { ProjectDocument } from "../project-model/types";

/**
 * INTENT dock panel — the "hlavný ťahák" (VISION §10): type what you want,
 * the engine generates + ranks candidates and you AUDITION them before choosing.
 *
 * The UI only orchestrates: parse the text → request generation through the
 * canonical Intent Engine entry point (with the full candidate bank) →
 * play any candidate offline through the real render chain → apply the chosen
 * one as one undoable command. All candidate generation, invariant gating,
 * ranking and provenance live behind the engine boundary; this panel never
 * regenerates or re-validates engine output.
 */

/** B1: a `?regen=1` arrival auto-runs exactly one generation per page load —
    StrictMode must not double-fire it. */
let regenAutoRan = false;

export function IntentPanel() {
  const services = useServices();
  const doc = services.store.getDoc();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A1 audition state — the ranked bank lives on the result; buffers are
  // cached per candidate so replaying is instant after the first render.
  const [bankResult, setBankResult] = useState<GenerationResult | null>(null);
  const [semanticChip, setSemanticChip] = useState<string | null>(null);
  // Prompt history strip (vibe-code wave 2): reactivity tick over the
  // module-level session history.
  const [historyTick, setHistoryTick] = useState(0);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [renderingIndex, setRenderingIndex] = useState<number | null>(null);
  const buffersRef = useRef<Map<number, AudioBuffer>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const playTokenRef = useRef(0);

  // A pending generation must not touch state after unmount (or after a
  // newer generate() superseded it) — the AbortController + token make the
  // continuation a no-op. Audition playback must not outlive the panel.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      stopAudition();
    };
  }, []);

  // Audit 13 D2: a PROJECT SWITCH swaps `services` while this panel stays
  // mounted — abort the in-flight generation and drop its candidate bank so
  // the old project's proposal can never be applied into the new project.
  useEffect(() => {
    abortRef.current?.abort();
    stopAudition();
    setBankResult(null);
    setPlayingIndex(null);
    setSongDraft(null);
    setJustApplied(false);
  }, [services]);

  // Landing handoff (viral growth plan A2): the prompt that forged the beat
  // now playing pre-fills the field, so "tweak it and Forge another" is one
  // edit away. Take-semantics — the stash clears on read.
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const prefill = takeIntentPrefill();
    if (!prefill) return;
    setText(prefill);
    setStatus("Your beat is loaded below — tweak the prompt or forge another.");
    promptInputRef.current?.focus();
  }, []);

  // B1 gallery REGEN: `?regen=1` opened the studio with a beat that carries
  // intent provenance — pre-fill the field with the beat's own character and
  // auto-run ONE fresh-seed generation ("another one like this"). StrictMode
  // double-mounts this effect; the module-level guard keeps it single-shot.
  // runGeneration is declared below — a mount-time call reads it fine (hoisted
  // const via closure at effect-run time), so this effect sits here beside the
  // prefill one it mirrors.
  useEffect(() => {
    if (!takeRegenFlag()) return;
    if (regenAutoRan) return;
    regenAutoRan = true;
    const snapshot = intentSnapshotOfDoc(doc);
    if (!snapshot) {
      setStatus("This beat carries no intent provenance — describe your variation instead.");
      return;
    }
    setText(promptFromIntent(snapshot) || "regenerated take");
    setStatus("🎲 Regenerating — same character, fresh take…");
    void runGeneration({ ...(snapshot as IntentInput), seed: freshRegenSeed() }, new AbortController());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Live parse preview — shows what the engine understood from the text. */
  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    return parseIntentText(text);
  }, [text]);

  const candidates = bankResult?.bank ?? null;

  // C2 revise: the intent of the LAST generation — "more energetic" re-runs
  // THIS intent with a shifted slider (same seed = same beat, new character).
  const lastIntentRef = useRef<IntentInput | null>(null);

  // A3 share moment: right after USE the beat belongs to the user — that is
  // the moment of pride and the moment to share. The CTA row appears after
  // every successful apply and hides when a new generation starts.
  const [justApplied, setJustApplied] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);
  const videoSupported = useMemo(() => canExportVideo(), []);

  const runGeneration = async (intentInput: IntentInput, controller: AbortController) => {
    try {
      const result: GenerationResult = await generateAsyncResult(
        doc,
        {
          ...intentInput,
          seed: intentInput.seed || `intent-${Date.now()}`,
          candidateCount: intentInput.candidateCount ?? 3,
          // T2: two extra candidates sampled from the ONNX symbolic drum
          // prior join the same bank; a missing model just shrinks the bank.
          symbolicCandidates: intentInput.symbolicCandidates ?? 2,
          roles: intentInput.roles ?? ["drums", "bass"],
        },
        { mode: "apply", signal: controller.signal, includeBank: true, sound: { bank: services.bank } },
      );
      if (controller.signal.aborted) return;
      if (!result.proposal) {
        const reason = result.diagnostics.errors[0] ?? result.diagnostics.fallbackReason ?? "generation rejected";
        setError(`Generation failed: ${reason} — try a different intent.`);
        return;
      }
      lastIntentRef.current = result.plan.intent;
      // Session context (vibe-code wave 2): the bank stays addressable —
      // "that second one, darker" resolves against it next prompt.
      rememberGeneration({
        text: intentInput.seed ? text.trim() || intentInput.seed : text.trim(),
        intent: intentInput,
        candidates: (result.bank ?? []).map((entry, index) => ({
          index,
          pattern: entry.pattern,
          intent: result.plan.intent,
        })),
        appliedIndex: null,
        docId: doc.id,
        at: Date.now(),
      });
      rememberPrompt(text);
      setHistoryTick((tick) => tick + 1);
      setBankResult(result);
      const count = result.bank?.length ?? 0;
      setStatus(
        count > 0
          ? `✓ ${count} candidates — ▶ to audition, USE to apply`
          : `✓ pattern generated (${rankerModeLabel()})`,
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const generate = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    setBankResult(null);
    setPlayingIndex(null);
    setJustApplied(false);
    stopAudition();
    buffersRef.current = new Map();
    // SESSION REFERENCE (vibe-code wave 2): "that second one, darker" —
    // apply the referenced candidate from the last generation, then run the
    // residual words through the normal pipeline (production/verbs/song).
    const last = lastGeneration();
    const reference = last ? resolveSessionReference(text, last.candidates) : null;
    if (reference && last) {
      const candidate = last.candidates[reference.index];
      services.store.execute(applySessionCandidateCommand(doc, candidate.pattern));
      rememberPrompt(text);
      let statusText = `✓ candidate #${reference.index + 1} re-applied from session context`;
      const residualText = reference.rest;
      if (residualText) {
        const production = parseProductionIntent(residualText);
        if (production) {
          try {
            services.store.execute(applyProductionIntentCommand(doc, production));
            statusText += ` + ${production.goals.map((g) => g.concept).join(" + ")}`;
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }
      }
      setStatus(statusText);
      setBusy(false);
      return;
    }
    // Production intents (master doc §4.3): "make the bass deeper" tweaks the
    // EXISTING track's sound through effects — one undoable command group —
    // instead of generating a new pattern. Detection is comparative/
    // imperative phrasing, so "dark techno" still generates. A GENRE signal
    // (or section vocabulary) flips the same FX words into generation-time
    // FX instead: "wobbly drill" GENERATES with the mangler, it doesn't
    // re-tune the old pattern.
    const production = parseProductionIntent(text);
    const sectionParse = parseSectionRequests(text);
    const remainingFxText = sectionParse?.remainingText ?? text;
    const genreSignal = Boolean(parsed?.input.genre || parsed?.detected.some((chip) => chip.startsWith("♪")));
    if (production && !genreSignal && !sectionParse) {
      try {
        const cmd = applyProductionIntentCommand(doc, production);
        services.store.execute(cmd);
        setStatus(`✓ ${cmd.label} — applied (one undo step)`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setBusy(false);
      return;
    }
    // Section vocabulary in the sentence → the SONG path directly
    // ("wobbly drill with a 16-bar intro and a vinyl break" is a song
    // request, not a one-bar pattern).
    if (sectionParse) {
      setBusy(false);
      await runSongBuild(sectionParse);
      return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const intentInput = { ...(parsed?.input ?? {}), ...(refPatch ?? {}) };
    // Wave 1 — FX words remaining after section parsing ride WITH the
    // generation ("wobbly drill"): candidates carry them, USE applies
    // pattern + FX as one step.
    const globalFx = genreSignal ? parseProductionIntent(remainingFxText) : null;
    // T1 krok 2 semantic layer: when the keyword parse is WEAK (no genre
    // word, no artist preset), ask the embedding model for the nearest
    // curated reference. Confident keyword parses skip it — zero latency
    // cost when the parser already understands.
    let finalInput = intentInput;
    if (!intentInput.genre && !parsed?.detected.some((chip) => chip.startsWith("♪"))) {
      setStatus("🧠 semantic…");
      const match = await semanticIntentFor(text);
      if (controller.signal.aborted) return;
      if (match) {
        finalInput = { ...intentInput, ...match.input };
        setSemanticChip(`🧠 ${match.label} (${Math.round(match.score * 100)}%)`);
      } else {
        setSemanticChip(null);
      }
    } else {
      setSemanticChip(null);
    }
    if (globalFx) finalInput = { ...finalInput, fx: globalFx };
    await runGeneration(finalInput, controller);
  };

  const toggleAudition = async (candidate: RankedCandidate) => {
    if (playingIndex === candidate.candidateIndex) {
      stopAudition();
      setPlayingIndex(null);
      return;
    }
    const token = ++playTokenRef.current;
    setRenderingIndex(candidate.candidateIndex);
    try {
      let buffer = buffersRef.current.get(candidate.candidateIndex);
      if (!buffer) {
        // Wave: the audition HEARS the FX — the candidate's fx requests are
        // folded into the ghost document, so what you preview is what USE
        // installs. Buffers cache per candidate (fx rides the plan).
        const picked = bankResult ? resultForCandidate(bankResult, candidate.candidateIndex) : null;
        const fx = picked?.plan.intent.fx ?? null;
        buffer = await renderAuditionBuffer(doc, services.bank, candidate.pattern, fx);
        buffersRef.current.set(candidate.candidateIndex, buffer);
      }
      if (playTokenRef.current !== token) return; // superseded meanwhile
      playAuditionBuffer(buffer, () => setPlayingIndex(null));
      setPlayingIndex(candidate.candidateIndex);
      const withFx = bankResult
        ? (resultForCandidate(bankResult, candidate.candidateIndex)?.plan.intent.fx ?? null)
        : null;
      setStatus(`▶ auditioning candidate #${candidate.candidateIndex + 1}${withFx ? " — with FX" : ""}`);
    } catch (err) {
      if (playTokenRef.current === token) {
        setError(`audition failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (playTokenRef.current === token) setRenderingIndex(null);
    }
  };

  const useCandidate = (candidate: RankedCandidate | null) => {
    if (!bankResult?.proposal) return;
    stopAudition();
    setPlayingIndex(null);
    const picked = candidate ? resultForCandidate(bankResult, candidate.candidateIndex) : bankResult;
    const fx = picked.plan.intent.fx ?? null;
    services.store.execute(
      fx
        ? applyGenerationResultWithFxCommand(doc, picked, picked.plan.intent.genre || undefined)
        : applyGenerationResultCommand(doc, picked, picked.plan.intent.genre || undefined),
    );
    setBankResult(null);
    buffersRef.current = new Map();
    setStatus(
      candidate
        ? `✓ applied candidate #${candidate.candidateIndex + 1} (${candidate.source})${fx ? " + FX" : ""}`
        : `✓ pattern applied${fx ? " + FX" : ""}`,
    );
    // A3: the applied beat is the share moment — reveal Publish/Video/Copy.
    setJustApplied(true);
  };

  /** Copy a share link that opens the whole project in another tab. */
  const copyShareLink = async () => {
    funnelEvent("share_copy");
    const url = shareAppUrl(encodeShareCode(services.store.getDoc()), location.origin);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setStatus("✓ Share link copied — anyone opening it gets this project");
    } catch {
      // Clipboard permission denied / insecure context — surface the link
      // the manual way instead of failing silently (or lying about success).
      window.prompt("Copy this share link:", url);
      setStatus("Share link shown — copy it from the dialog");
    }
  };

  /** Render the applied beat and record a vertical social clip. */
  const exportVideo = async () => {
    if (videoBusy) return;
    setVideoBusy(true);
    setError(null);
    funnelEvent("share_video");
    try {
      setStatus("Rendering your beat…");
      const buffer = await renderProject(services.store.getDoc(), services.bank, {
        mode: services.playback.getSnapshot(),
        sampleRate: 44100,
      });
      setStatus("Recording video…");
      const result = await recordVideo(buffer, {
        title: services.store.getDoc().name,
        bpm: services.store.getDoc().bpm,
        seconds: buffer.duration,
        onProgress: (f) => setStatus(`Recording video… ${Math.round(f * 100)}%`),
      });
      downloadBlob(result.blob, `${sanitizeFilename(services.store.getDoc().name)}-clip.${result.ext}`);
      setStatus(`✓ Video exported — ${result.ext.toUpperCase()}, ready for Reels/Shorts/TikTok`);
    } catch (err) {
      setError(`video export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setVideoBusy(false);
    }
  };

  // A2 song builder: one intent → full arranged song (one undo step).
  // Wave 2+3 — the sentence's section vocabulary shapes the form ("16-bar
  // intro", "chorus twice", "no break") and scopes FX ("vinyl break"); the
  // intent's remaining FX words become global song chains.
  // SUNO MODE — one sentence through the FULL pipeline: song (sections,
  // transitions, scoped FX, length words) + mix profile + loudness pass.
  // Undo per stage; the loudness render must run AFTER install.
  const [songBusy, setSongBusy] = useState(false);
  // SONG DRAFT (audition-before-apply): compose builds the song + mix off to
  // the side, the user HEARS the whole arrangement through the offline
  // renderer first, then USE installs it (fresh commands against the latest
  // doc so undo stays correct). Discard drops everything, nothing applied.
  // The loudness runner is stored on the draft and runs only on USE — the
  // previous flow measured loudness but never executed its trim command.
  interface SongDraft {
    result: ComposeResult;
    /** Doc the draft was composed against — USE reuses the auditioned mix
        only while the doc is untouched (reference-equal); after interim
        edits the mix re-plans against the current doc (rebase). */
    baseDoc: ProjectDocument;
    previewDoc: ProjectDocument;
    mixNote: string;
    lengthNote: string;
    seconds: number;
    /** Preview loudness trim (master.loudnessTrimDb) — the audition plays
        the trimmed doc, USE installs this exact trim with no re-render. */
    trimDb: number;
    loudnessTarget: number;
    measuredBefore: number | null;
    /** Gated LUFS measured on the audition buffer itself (the free verify). */
    measuredAfter: number | null;
    loudnessApplied: boolean;
  }
  const [songDraft, setSongDraft] = useState<SongDraft | null>(null);
  const [songPlaying, setSongPlaying] = useState(false);
  const [songRendering, setSongRendering] = useState(false);
  const songBufferRef = useRef<AudioBuffer | null>(null);
  const songTokenRef = useRef(0);
  const songTextRef = useRef("");
  // Per-section audition — each built section pattern renders through the
  // same candidate-audition path (ghost doc off the draft's base doc, the
  // section's own scoped FX folded in), buffers cached per pattern id.
  const [playingSectionId, setPlayingSectionId] = useState<string | null>(null);
  const [renderingSectionId, setRenderingSectionId] = useState<string | null>(null);
  const sectionBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const sectionTokenRef = useRef(0);
  // Audio reference ("sprav to ako tento WAV"): patch merges into every
  // generation path, the 16-dim conditioning installs for the v2 priors.
  const [refPatch, setRefPatch] = useState<IntentInput | null>(null);
  const [refSummary, setRefSummary] = useState<string | null>(null);
  const [refBusy, setRefBusy] = useState(false);
  const [refGroove, setRefGroove] = useState<GrooveExtraction | null>(null);
  // Voice idea (Fázy 1+2): the artist hums/sings — patch carries their tempo
  // + key, humNotes become the LEAD of the SUNO MODE song.
  const [voiceIdea, setVoiceIdea] = useState<{
    notes: NoteEvent[];
    loopTicks: number;
    key: string | null;
    summary: string;
  } | null>(null);
  const [ideaRecording, setIdeaRecording] = useState(false);
  const [ideaMicMonitor, setIdeaMicMonitor] = useState(false);
  const ideaRecorderRef = useRef<PcmMicRecorder | null>(null);
  const ideaBeatSyncRef = useRef(false);
  const ideaStartTickRef = useRef<number | null>(null);
  const ideaTransportRestoreRef = useRef<{ startedByIdea: boolean; metronomeBefore: boolean } | null>(null);
  const referenceInputRef = useRef<HTMLInputElement | null>(null);
  const clearReference = () => {
    setRefPatch(null);
    setRefSummary(null);
    setRefGroove(null);
    setVoiceIdea(null);
    setAudioReferenceConditioning(null);
    setStatus("🎧 reference cleared — back to text-only intent");
  };
  const handleReferenceFile = async (file: File | null) => {
    if (!file || refBusy) return;
    setRefBusy(true);
    setStatus("🎧 listening to the reference…");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const ctx = new AudioContext();
      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(arrayBuffer);
      } finally {
        await ctx.close();
      }
      const pcm = resampleLinear(downmixToMono(buffer), buffer.sampleRate, 16000);
      const result = await analyzeAudioReference(pcm);
      if (!result) {
        setError("🎧 reference: audio models unavailable (fetch them or try later)");
        return;
      }
      const groove = extractGrooveGrid(pcm, 16000);
      setRefGroove(groove);
      setRefPatch(result.patch);
      setRefSummary(result.summary);
      setAudioReferenceConditioning(result.conditioning);
      setStatus(
        `🎧 reference: ${result.summary}${groove ? ` — groove ${groove.summary}` : ""} — patch + conditioning live`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefBusy(false);
    }
  };
  // Voice idea: record the artist humming/singing via MediaRecorder, decode,
  // then analyze — tempo + key become the patch, the hum becomes the LEAD.
  const restoreIdeaTransport = () => {
    const restore = ideaTransportRestoreRef.current;
    ideaTransportRestoreRef.current = null;
    if (!restore) return;
    if (restore.startedByIdea && services.transport.playing) services.playback.playPause();
    if (restore.startedByIdea || !services.transport.playing) {
      services.transport.setMetronome(restore.metronomeBefore);
    }
  };
  const teardownIdeaRecorder = async () => {
    const rec = ideaRecorderRef.current;
    ideaRecorderRef.current = null;
    if (rec) await rec.cancel().catch(() => undefined);
  };
  const setIdeaMicMonitoring = (enabled: boolean) => {
    setIdeaMicMonitor(enabled);
    ideaRecorderRef.current?.setMonitoring(enabled);
  };
  const startIdeaRecording = async () => {
    if (ideaRecording) return;
    try {
      services.engine.ensureContext();
      const ctx = services.engine.getLiveAudioContext();
      if (!ctx) {
        setError("🎤 audio engine not ready yet — try again in a second");
        return;
      }
      // Beat-synced hum: roll the transport first so there IS a beat to hum
      // to (pattern + click). Outside pattern playback: free-time fallback.
      const beatSync = services.playback.mode === "pattern" && typeof services.transport.position === "number";
      ideaBeatSyncRef.current = beatSync;
      ideaStartTickRef.current = null;
      ideaTransportRestoreRef.current = null;
      if (beatSync) {
        const startedByIdea = !services.transport.playing;
        ideaTransportRestoreRef.current = {
          startedByIdea,
          metronomeBefore: services.transport.metronome,
        };
        if (startedByIdea) {
          services.transport.setMetronome(true);
          services.playback.playPause();
        }
      }
      const docBpm = services.store.getDoc().bpm;
      const rec = new PcmMicRecorder({ ctx, recovery: services.recordingRecovery });
      ideaRecorderRef.current = rec;
      rec.setMonitoring(ideaMicMonitor);
      rec.onError = (message) => {
        setError(message);
        void teardownIdeaRecorder()
          .catch(() => undefined)
          .then(() => {
            restoreIdeaTransport();
            setIdeaRecording(false);
          });
      };
      await rec.start(() => {
        // Sample the transport tick as close to the first captured sample as
        // possible — the grid quantize absorbs the residue.
        if (beatSync) ideaStartTickRef.current = Math.max(0, services.transport.position);
        return {
          projectId: services.store.getDoc().id,
          trackId: "",
          trackName: "voice idea",
          placeOnTimeline: false,
          startBar: 0,
          bpm: docBpm,
        };
      });
      setIdeaRecording(true);
      const bpmNote = beatSync ? `the beat at ${docBpm} BPM` : "free time (nothing playing)";
      setStatus(`🎤 recording with ${bpmNote} — hum the hook, press stop`);
    } catch (err) {
      void teardownIdeaRecorder();
      restoreIdeaTransport();
      setError(`🎤 mic unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const stopIdeaRecording = async () => {
    if (!ideaRecording) return;
    setIdeaRecording(false);
    const rec = ideaRecorderRef.current;
    ideaRecorderRef.current = null;
    const startTick = ideaStartTickRef.current;
    const beatSync = ideaBeatSyncRef.current;
    ideaStartTickRef.current = null;
    restoreIdeaTransport();
    if (!rec) return;
    try {
      const take = await rec.stop();
      if (!take || take.buffer.length === 0) {
        setError("🎤 nothing was captured — check that the microphone is not muted");
        return;
      }
      try {
        await services.recordingRecovery.remove(take.session.id);
      } catch {
        /* recovery cleanup is best-effort */
      }
      const channel = take.buffer.getChannelData(0);
      const doc = services.store.getDoc();
      const activePattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
      const result = await analyzeVoiceIdea(channel, take.buffer.sampleRate, {
        ...(beatSync ? { bpm: doc.bpm } : {}),
        ...(beatSync && startTick !== null ? { transportStartTick: startTick } : {}),
        ...(beatSync && activePattern ? { patternLengthTicks: patternLengthTicks(activePattern) } : {}),
      });
      if (!result) {
        setError("🎤 idea: could not analyze the recording — try again, hum louder");
        return;
      }
      setRefPatch(result.patch);
      if (result.noteCount > 0) {
        setVoiceIdea({ notes: result.notes, loopTicks: result.loopTicks, key: result.key, summary: result.summary });
        setStatus(`🎤 idea: ${result.summary} — hook live, ♪ SONG builds around it`);
      } else {
        setVoiceIdea(null);
        setStatus(`🎤 idea: ${result.summary} — patch live (no steady melody detected)`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const toggleIdeaRecording = () => void (ideaRecording ? stopIdeaRecording() : startIdeaRecording());

  // Groove install: transcribed band hits become REAL rows on the active
  // pattern's drum track (one undo step).
  const installGroove = () => {
    if (!refGroove) return;
    const drumTrack = doc.tracks.find((track) => track.kind === "drum");
    if (!drumTrack || drumTrack.kind !== "drum" || drumTrack.pads.length === 0) {
      setError("🥁 groove: no drum track with pads in this project");
      return;
    }
    const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    if (!pattern) {
      setError("🥁 groove: no active pattern to install into");
      return;
    }
    const pads = drumTrack.pads.map((pad, index) => ({ id: pad.id, role: inferPadRole(pad.name, index) }));
    const rows = grooveRowsForPads(refGroove.hits, pads, refGroove.steps);
    services.store.execute(replacePatternInPlaceCommand(doc, pattern.id, { ...pattern, rows }));
    setStatus(`🥁 groove installed — ${refGroove.summary} (one undo step)`);
  };
  const buildSongDraft = async (sections?: SectionParse, reviseInput?: IntentInput) => {
    setError(null);
    setStatus(null);
    setBankResult(null);
    setJustApplied(false);
    stopAudition();
    setSongPlaying(false);
    setPlayingSectionId(null);
    songBufferRef.current = null;
    sectionBuffersRef.current = new Map();
    sectionTokenRef.current++;
    // Guard token: a superseding build, DROP or USE during the awaits below
    // bumps songTokenRef and this run must not install a stale draft.
    const buildToken = ++songTokenRef.current;
    try {
      const baseDoc = services.store.getDoc();
      const intentInput = { ...(parsed?.input ?? {}), ...(refPatch ?? {}), ...(reviseInput ?? {}) };
      const globalFx = reviseInput?.fx ?? parseProductionIntent(sections?.remainingText ?? text);
      const result = await composeFullTrack(baseDoc, songTextRef.current || text, {
        ...(sections ? { sections } : {}),
        input: { ...intentInput, ...(globalFx ? { fx: globalFx } : {}) },
        ...(reviseInput?.seed ? { seed: reviseInput.seed } : {}),
        ...(voiceIdea ? { hum: { notes: voiceIdea.notes, loopTicks: voiceIdea.loopTicks, key: voiceIdea.key } } : {}),
        bank: services.bank,
        onProgress: (label) => setStatus(`⚡ SUNO MODE — ${label}`),
      });
      // Preview doc for the audition render only — nothing is applied yet.
      // Song command is whole-doc; mix is a delta — fold mix over the song
      // so the preview hears exactly what USE would install.
      let preview: ProjectDocument = result.commands.song.execute(baseDoc);
      if (result.commands.mix) {
        try {
          preview = result.commands.mix.execute(preview);
        } catch {
          /* garnish must not block the preview */
        }
      }
      if (songTokenRef.current !== buildToken) return;
      // Loudness-in-preview: one background measure → trim, then the
      // AUDITION renders the trimmed doc — what you hear is what USE
      // installs (the audition buffer itself is the verify measurement).
      setStatus("⚡ SUNO MODE — loudness measure…");
      const loud = await applyPreviewLoudness(preview, services.bank, songTextRef.current || text);
      if (songTokenRef.current !== buildToken) return;
      preview = loud.doc;
      const seconds = Math.round((result.build.totalBars * 4 * 60) / (result.build.resolvedBpm ?? 120));
      const lengthNote = ` ≈ ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      const mixNote = result.mixSummary ? ` · mix: ${result.mixSummary}` : "";
      const trimSign = loud.trim >= 0 ? "+" : "";
      const loudNote = loud.applied
        ? ` · 🔊 ${loud.measuredBefore ?? "?"} → ${loud.target} LUFS (trim ${trimSign}${loud.trim} dB)`
        : "";
      setSongDraft({
        result,
        baseDoc,
        previewDoc: preview,
        mixNote,
        lengthNote,
        seconds,
        trimDb: loud.trim,
        loudnessTarget: loud.target,
        measuredBefore: loud.measuredBefore,
        measuredAfter: null,
        loudnessApplied: loud.applied,
      });
      const fxNote = result.build.baseIntent.fx || result.build.sections.some((s) => s.fx) ? " + FX" : "";
      const skipNote = result.skipped.length > 0 ? ` (skipped: ${result.skipped.length})` : "";
      setStatus(
        `✓ SUNO MODE — ${result.build.name} — ${result.build.sections.length} sections, ${result.build.totalBars} bars${lengthNote}${fxNote}${mixNote}${loudNote}${skipNote} — ▶ to audition, USE to keep`,
      );
      // Background audition render — PLAY enables when done.
      const token = ++songTokenRef.current;
      setSongRendering(true);
      try {
        const buffer = await renderSongAuditionBuffer(services.bank, preview);
        if (songTokenRef.current !== token) return;
        songBufferRef.current = buffer;
        // Free verify: measure what the preview actually plays.
        try {
          const channels: Float32Array[] = [];
          for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
          const reading = analyzeLoudnessBuffer(channels, buffer.sampleRate);
          if (reading.measured) {
            const after = Math.round(reading.integrated * 10) / 10;
            setSongDraft((prev) => (prev && prev.result === result ? { ...prev, measuredAfter: after } : prev));
          }
        } catch {
          /* display-only — the buffer still plays */
        }
      } catch (err) {
        if (songTokenRef.current === token) {
          setError(`song preview render failed: ${err instanceof Error ? err.message : String(err)} — USE still works`);
        }
      } finally {
        if (songTokenRef.current === token) setSongRendering(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const runSongBuild = async (sections?: SectionParse) => {
    songTextRef.current = text;
    await buildSongDraft(sections);
  };
  const generateSong = async () => {
    if (!text.trim() || songBusy || busy) return;
    setSongBusy(true);
    try {
      await runSongBuild(parseSectionRequests(text) ?? undefined);
    } finally {
      setSongBusy(false);
    }
  };
  const toggleSongAudition = () => {
    if (songPlaying) {
      stopAudition();
      setSongPlaying(false);
      return;
    }
    const buffer = songBufferRef.current;
    if (!buffer) return;
    // Full-song and section auditions share one playback channel.
    setPlayingSectionId(null);
    playAuditionBuffer(buffer, () => setSongPlaying(false));
    setSongPlaying(true);
    setStatus(`▶ auditioning full song — ${songDraft?.result.build.sections.length ?? 0} sections`);
  };
  const toggleSectionAudition = async (section: SongBuildSection) => {
    if (!songDraft) return;
    const id = section.pattern.id;
    if (playingSectionId === id) {
      stopAudition();
      setPlayingSectionId(null);
      return;
    }
    stopAudition();
    setSongPlaying(false);
    const token = ++sectionTokenRef.current;
    setRenderingSectionId(id);
    try {
      let buffer = sectionBuffersRef.current.get(id);
      if (!buffer) {
        buffer = await renderAuditionBuffer(
          songDraft.baseDoc,
          services.bank,
          section.pattern,
          section.fx ?? songDraft.result.build.baseIntent.fx ?? null,
        );
        sectionBuffersRef.current.set(id, buffer);
      }
      if (sectionTokenRef.current !== token) return;
      playAuditionBuffer(buffer, () => setPlayingSectionId(null));
      setPlayingSectionId(id);
      setStatus(`▶ auditioning ${section.label} (${section.bars} bars · ${section.roles.join("+")})`);
    } catch (err) {
      if (sectionTokenRef.current === token) {
        setError(`section preview failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (sectionTokenRef.current === token) setRenderingSectionId(null);
    }
  };
  const discardSongDraft = () => {
    songTokenRef.current++;
    sectionTokenRef.current++;
    stopAudition();
    setSongPlaying(false);
    setPlayingSectionId(null);
    songBufferRef.current = null;
    sectionBuffersRef.current = new Map();
    setSongDraft(null);
    setStatus("Song draft discarded — nothing applied.");
  };
  const useSongDraft = async () => {
    if (!songDraft || songBusy) return;
    songTokenRef.current++;
    sectionTokenRef.current++;
    stopAudition();
    setSongPlaying(false);
    setPlayingSectionId(null);
    setSongBusy(true);
    try {
      // Fresh commands against the CURRENT doc — a draft may sit open while
      // the user keeps editing; rebasing keeps undo correct.
      const current = services.store.getDoc();
      const songCmd = applySongCommand(current, songDraft.result.build);
      services.store.execute(songCmd);
      let afterSong = services.store.getDoc();
      // P4 preview==USE: the audition rendered the COMPOSED mix, so install
      // exactly that while the doc is untouched since the draft (same track
      // resolution, zero re-planning). After interim edits, re-plan against
      // the current doc so new tracks are covered (rebase).
      const draftUntouched = current === songDraft.baseDoc;
      const composedMix = draftUntouched ? songDraft.result.commands.mix : null;
      let rebased = !draftUntouched;
      try {
        if (composedMix) {
          services.store.execute(composedMix);
        } else {
          const profile = planMixProfile(songDraft.result.build.baseIntent);
          const mixCmd = applyMixIntent(afterSong, profile);
          services.store.execute(mixCmd);
        }
        afterSong = services.store.getDoc();
      } catch {
        /* no mix decisions — song alone is complete */
      }
      // Stored preview trim — no re-render: USE installs exactly what the
      // audition played. After interim edits the mix was re-planned, so the
      // trim is an estimate carried from the preview (flagged honestly).
      let loudnessNote = "";
      if (songDraft.loudnessApplied) {
        try {
          services.store.execute(setMasterConfig(services.store.getDoc(), { loudnessTrimDb: songDraft.trimDb }));
          const sign = songDraft.trimDb >= 0 ? "+" : "";
          const heard = songDraft.measuredAfter ?? songDraft.measuredBefore ?? "?";
          loudnessNote = ` — loudness ≈${heard} LUFS (trim ${sign}${songDraft.trimDb} dB${
            rebased ? ", from preview" : ""
          })`;
        } catch {
          /* master trim is garnish — the song stands without it */
        }
      }
      const fxNote =
        songDraft.result.build.baseIntent.fx || songDraft.result.build.sections.some((s) => s.fx) ? " + FX" : "";
      songBufferRef.current = null;
      sectionBuffersRef.current = new Map();
      setSongDraft(null);
      setJustApplied(true);
      setStatus(
        `✓ SUNO MODE — ${songDraft.result.build.name} — ${songDraft.result.build.sections.length} sections, ${songDraft.result.build.totalBars} bars${songDraft.lengthNote}${fxNote}${songDraft.mixNote}${rebased ? " · mix re-planned after edits" : ""}${loudnessNote} — Tip: "make bridge more energetic" + ⚡ DO IT revises one section.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSongBusy(false);
    }
  };
  // Global draft revise — same seed, shifted content slider. The song keeps
  // its identity (sections, seeds, form), only the character moves. Runs as
  // a fresh draft build so the user can still audition before USE.
  const reviseSongDraft = async (attribute: "energy" | "density", delta: number) => {
    if (!songDraft || songBusy) return;
    const base = songDraft.result.build.baseIntent;
    const fallback = attribute === "energy" ? 0.7 : 0.5;
    const current = typeof base[attribute] === "number" ? (base[attribute] as number) : fallback;
    const next = Math.max(0, Math.min(1, current + delta));
    setSongBusy(true);
    try {
      await buildSongDraft(parseSectionRequests(songTextRef.current) ?? undefined, {
        ...base,
        [attribute]: next,
        seed: base.seed,
      });
      setStatus(
        `⚡ song ${attribute} ${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)} — same seed, audition before USE`,
      );
    } finally {
      setSongBusy(false);
    }
  };

  // D3 unified bar: route the text to the right executor — arrange ops,
  // mix profile, or (default) candidate generation.
  const [routeBusy, setRouteBusy] = useState(false);
  const loudnessBusyRef = useRef(false);
  const routeAndExecute = async () => {
    if (!text.trim() || routeBusy) return;
    setRouteBusy(true);
    setError(null);
    setJustApplied(false);
    try {
      const route = routeIntentText(text, doc);
      if (route.kind === "arrange") {
        stopAudition();
        services.store.execute(applyArrangeOps(doc, route.ops));
        setStatus(`⚡ arranged — ${route.ops.length} op${route.ops.length === 1 ? "" : "s"}`);
      } else if (route.kind === "effectIntent") {
        // D1 v2a: targeted effect × target × direction
        stopAudition();
        const command = applyEffectIntent(doc, route.intent);
        services.store.execute(command);
        setStatus(`⚡ ${route.intent.detected.join(" · ")}`);
      } else if (route.kind === "production") {
        // Production intent with an explicit target ("make the drums
        // darker") — same executor as the GENERATE path: track FX, one
        // undo step. The router only sends texts that name a target track.
        stopAudition();
        try {
          const cmd = applyProductionIntentCommand(doc, route.intent);
          services.store.execute(cmd);
          setStatus(`✓ ${cmd.label} — applied (one undo step)`);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } else if (route.kind === "loudness") {
        // D1 loudness loop: measure → trim → verify
        stopAudition();
        if (loudnessBusyRef.current) return;
        loudnessBusyRef.current = true;
        setError(null);
        setStatus("🔊 measuring loudness…");
        try {
          const outcome = await applyLoudnessIntent(doc, services.bank, route.parse);
          if (!outcome.ok) {
            setError(outcome.error);
          } else {
            setStatus(
              `⚡ loudness: ${outcome.report.measuredBefore} → ${outcome.report.measuredAfter ?? "?"} LUFS (trim ${outcome.report.trim >= 0 ? "+" : ""}${outcome.report.trim} dB)`,
            );
          }
        } finally {
          loudnessBusyRef.current = false;
        }
      } else if (route.kind === "mix") {
        stopAudition();
        const intentInput = { ...(parsed?.input ?? {}), ...(refPatch ?? {}) };
        const profile = planMixProfile(normalizeIntent(intentInput), route.overrides);
        services.store.execute(applyMixIntent(doc, profile));
        setStatus(`⚡ mix: ${profile.summary.join(" · ") || `${profile.decisions.length} updates`}`);
      } else if (route.kind === "revise") {
        // C2: shift a content slider on the LAST generation and re-run with
        // the SAME seed — the beat keeps its identity, the character moves.
        stopAudition();
        if (busy) return;
        setBusy(true);
        setError(null);
        setStatus(null);
        setBankResult(null);
        setPlayingIndex(null);
        buffersRef.current = new Map();
        const controller = new AbortController();
        abortRef.current?.abort();
        abortRef.current = controller;
        const last = lastIntentRef.current;
        const delta = route.direction === "more" ? REVISE_DELTA : -REVISE_DELTA;
        const fallbackDefaults: Record<ReviseAttribute, number> = { energy: 0.7, density: 0.5 };
        if (route.targetRole) {
          // C3 TARGETED revise: the role word names the section — regenerate
          // THAT scene's pattern from its own provenance intent (same seed).
          const attribute = route.attribute as "energy" | "density";
          const outcome = reviseSection(doc, route.targetRole as never, attribute, delta);
          if (!outcome.ok) {
            setStatus(`⚡ ${outcome.error}`);
            return;
          }
          services.store.execute(replacePatternInPlaceCommand(doc, outcome.patternId, outcome.pattern));
          setStatus(`⚡ ${outcome.label}`);
        } else if (last) {
          const current = last[route.attribute] ?? fallbackDefaults[route.attribute];
          await runGeneration({ ...last, [route.attribute]: Math.max(0, Math.min(1, current + delta)) }, controller);
          setStatus(`⚡ ${route.attribute} ${route.direction === "more" ? "+0.15" : "−0.15"} — same seed`);
        } else {
          // Nothing generated yet — apply the attribute to the parsed intent.
          const intentInput: IntentInput = { ...{ ...(parsed?.input ?? {}), ...(refPatch ?? {}) } };
          intentInput[route.attribute] = fallbackDefaults[route.attribute] + delta;
          await runGeneration(intentInput, controller);
          setStatus(`⚡ ${route.attribute} → ${intentInput[route.attribute]?.toFixed(2)} (fresh pattern)`);
        }
      } else {
        await generate();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRouteBusy(false);
    }
  };

  const detectedText = parsed?.detected.length ? parsed.detected.map((d) => `● ${d}`).join("  ") : null;

  return (
    <div className="intent-panel" aria-label="Intent Engine">
      <div className="intent-header">
        <span className="intent-title">INTENT</span>
        <span className="intent-subtitle">describe → audition → choose</span>
      </div>
      <textarea
        ref={promptInputRef}
        className="intent-textarea"
        placeholder="dark rolling techno at 140 with lead… · tmavé rolujúce techno na 140, 8 taktov…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void generate();
        }}
        rows={3}
        aria-label="Intent description"
      />
      {historyTick >= 0 && promptHistory().length > 0 && (
        <div className="intent-history" aria-label="Prompt history">
          <span className="intent-history-label">RECENT</span>
          {promptHistory()
            .slice(0, 8)
            .map((entry) => (
              <button
                key={entry.at}
                type="button"
                className="intent-history-chip"
                title="Re-run this prompt"
                onClick={() => {
                  setText(entry.text);
                  void generate();
                }}
              >
                {entry.text.length > 42 ? entry.text.slice(0, 40) + "…" : entry.text}
              </button>
            ))}
        </div>
      )}
      {detectedText && (
        <div className="intent-detected" aria-label="Detected keywords">
          {detectedText}
        </div>
      )}
      {semanticChip && (
        <div className="intent-detected" aria-label="Semantic match">
          {semanticChip}
        </div>
      )}
      {error && (
        <div className="intent-error" role="alert">
          {error}
        </div>
      )}
      {status && (
        <div className="intent-status" role="status">
          {status}
        </div>
      )}
      {justApplied && (
        <div className="intent-share" aria-label="Share your beat">
          <span className="intent-share-label">Yours. Share it:</span>
          <div className="intent-share-actions">
            <PublishToGalleryButton />
            {videoSupported && (
              <button type="button" className="btn" disabled={videoBusy} onClick={() => void exportVideo()}>
                {videoBusy ? "…" : "VIDEO"}
              </button>
            )}
            <button type="button" className="btn" onClick={() => void copyShareLink()}>
              COPY LINK
            </button>
          </div>
        </div>
      )}
      <div className="intent-actions">
        <button
          type="button"
          className="btn intent-route-btn"
          disabled={!text.trim() || routeBusy}
          onClick={() => void routeAndExecute()}
          title="Smart route: arrange words → arrangement · mix words → mix · everything else → generate candidates"
        >
          {routeBusy ? "…" : "⚡ DO IT"}
        </button>
        <button
          type="button"
          className="btn intent-generate-btn"
          disabled={!text.trim() || busy || songBusy}
          onClick={() => void generate()}
        >
          {busy ? "GENERATING…" : "GENERATE"}
        </button>
        <button
          type="button"
          className="btn intent-song-btn"
          disabled={!text.trim() || busy || songBusy}
          onClick={() => void generateSong()}
          title="Build a full arranged song from this intent (intro → build → drop → break → drop → outro)"
        >
          {songBusy ? "BUILDING…" : "♪ SONG"}
        </button>
        <label
          className="intent-monitor-toggle"
          title="Hear yourself through the app — HEADPHONES ONLY (speakers feed back into the mic)"
        >
          <input
            type="checkbox"
            checked={ideaMicMonitor}
            onChange={(event) => setIdeaMicMonitoring(event.target.checked)}
          />
          🔊
        </label>
        <button
          type="button"
          className="btn intent-idea-btn"
          disabled={refBusy}
          onClick={() => void toggleIdeaRecording()}
          title="Voice idea — record yourself humming/singing the hook; the beat builds around YOUR tempo, key and melody"
        >
          {ideaRecording ? "■ STOP" : "🎤 IDEA"}
        </button>
        <button
          type="button"
          className="btn intent-ref-btn"
          disabled={refBusy}
          onClick={() => referenceInputRef.current?.click()}
          title="Audio reference — drop a WAV and the engine listens: genre + energy patch, plus a semantic conditioning vector for the v2 priors"
        >
          {refBusy ? "🎧…" : "🎧 REF"}
        </button>
        <button
          type="button"
          className="btn intent-groove-btn"
          disabled={!refGroove || refBusy}
          onClick={installGroove}
          title="Install the extracted groove (kick/snare/hat rows) into the active pattern"
        >
          🥁→DRUMS
        </button>
        <input
          ref={referenceInputRef}
          type="file"
          accept="audio/*"
          style={{ display: "none" }}
          onChange={(event) => {
            void handleReferenceFile(event.target.files?.[0] ?? null);
            event.target.value = "";
          }}
        />
      </div>
      {refPatch && (
        <div className="intent-ref-chip" role="status">
          <span className="intent-ref-chip-label">🎧 ref: {refSummary ?? "active"}</span>
          <span className="intent-ref-chip-hint">shapes every generation</span>
          <button
            type="button"
            className="intent-ref-chip-clear"
            aria-label="Clear audio reference"
            title="Clear the reference — back to text-only intent"
            onClick={clearReference}
          >
            ×
          </button>
        </div>
      )}
      {candidates && candidates.length > 0 && (
        <div className="intent-candidates" aria-label="Candidate bank">
          {candidates.map((candidate) => {
            const isWinner = candidate.candidateIndex === bankResult?.bank?.[0]?.candidateIndex;
            const isPlaying = playingIndex === candidate.candidateIndex;
            const isRendering = renderingIndex === candidate.candidateIndex;
            return (
              <div key={candidate.candidateIndex} className={`intent-candidate-row${isWinner ? " winner" : ""}`}>
                <button
                  type="button"
                  className="btn btn-small intent-audition-btn"
                  onClick={() => void toggleAudition(candidate)}
                  title={isPlaying ? "Stop audition" : "Audition this candidate"}
                >
                  {isRendering ? "…" : isPlaying ? "■" : "▶"}
                </button>
                <span className="intent-candidate-meta">
                  <span className="intent-candidate-index">#{candidates.indexOf(candidate) + 1}</span>
                  <span className={`intent-candidate-source ${candidate.source}`}>
                    {candidate.source === "symbolic-prior" ? "PRIOR" : "TPL"}
                  </span>
                  {isWinner && <span className="intent-candidate-win">★ best</span>}
                  {candidate.status === "repaired" && <span className="intent-candidate-fixed">fixed</span>}
                  <span className="intent-candidate-score" title="heuristic / ONNX score">
                    {Math.round(candidate.score * 100)}%
                    {candidate.modelScore != null ? ` · ${Math.round(candidate.modelScore * 100)}%` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-small intent-use-btn"
                  onClick={() => useCandidate(candidate)}
                  title="Apply this candidate to the project (one undo step)"
                >
                  USE
                </button>
              </div>
            );
          })}
        </div>
      )}
      {candidates && candidates.length === 0 && bankResult?.proposal && (
        <button type="button" className="btn intent-generate-btn" onClick={() => useCandidate(null)}>
          USE RESULT
        </button>
      )}
      {songDraft && (
        <div className="intent-song-draft" aria-label="Song draft preview">
          <div className="intent-candidate-row winner">
            <button
              type="button"
              className="btn btn-small intent-audition-btn"
              disabled={songRendering || !songBufferRef.current}
              onClick={toggleSongAudition}
              title={songPlaying ? "Stop song audition" : "Audition the full song"}
            >
              {songRendering ? "…" : songPlaying ? "■" : "▶"}
            </button>
            <span className="intent-candidate-meta">
              <span className="intent-candidate-index">{songDraft.result.build.name}</span>
              <span className="intent-candidate-score">
                {songDraft.result.build.sections.length} sections · {songDraft.result.build.totalBars} bars
                {songDraft.lengthNote} · {Math.round(songDraft.result.build.resolvedBpm ?? 120)} BPM
                {songDraft.loudnessApplied &&
                  (songDraft.measuredAfter != null
                    ? ` · plays ≈${songDraft.measuredAfter} LUFS`
                    : " · loudness trim set")}
              </span>
            </span>
            <button
              type="button"
              className="btn btn-small intent-use-btn"
              disabled={songBusy}
              onClick={() => void useSongDraft()}
              title="Apply this song to the project (song + mix + loudness, undoable)"
            >
              USE SONG
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={songBusy}
              onClick={discardSongDraft}
              title="Discard this draft — nothing is applied"
            >
              DROP
            </button>
          </div>
          <div className="intent-song-sections" aria-label="Song sections">
            {songDraft.result.build.sections.map((section) => {
              const id = section.pattern.id;
              const isPlaying = playingSectionId === id;
              const isRendering = renderingSectionId === id;
              return (
                <div key={id} className="intent-candidate-row">
                  <button
                    type="button"
                    className="btn btn-small intent-audition-btn"
                    disabled={songBusy || isRendering}
                    onClick={() => void toggleSectionAudition(section)}
                    title={isPlaying ? `Stop ${section.label} preview` : `Audition ${section.label} alone`}
                  >
                    {isRendering ? "…" : isPlaying ? "■" : "▶"}
                  </button>
                  <span className="intent-candidate-score" title={section.roles.join("+")}>
                    {section.label} · {section.bars}b · {section.roles.join("+")}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="intent-share-actions" aria-label="Revise song draft">
            <button
              type="button"
              className="btn btn-small"
              disabled={songBusy}
              onClick={() => void reviseSongDraft("energy", 0.15)}
              title="Same seed, more energy — audition again before USE"
            >
              E+
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={songBusy}
              onClick={() => void reviseSongDraft("energy", -0.15)}
              title="Same seed, calmer — audition again before USE"
            >
              E−
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={songBusy}
              onClick={() => void reviseSongDraft("density", 0.15)}
              title="Same seed, denser — audition again before USE"
            >
              D+
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={songBusy}
              onClick={() => void reviseSongDraft("density", -0.15)}
              title="Same seed, sparser — audition again before USE"
            >
              D−
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={songBusy}
              onClick={() => void buildSongDraft(parseSectionRequests(songTextRef.current) ?? undefined)}
              title="Fresh seed — a different take on the same sentence"
            >
              ↻ FRESH
            </button>
          </div>
          <div className="intent-detected">
            After USE: type “make bridge more energetic” + ⚡ DO IT to revise one section in place.
          </div>
        </div>
      )}
    </div>
  );
}

function rankerModeLabel(): string {
  const mode = rankerMode();
  return mode === "active" ? "ONNX active" : mode === "shadow" ? "shadow (heuristic)" : "ranker off";
}
