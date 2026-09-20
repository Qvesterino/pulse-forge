import { useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "./context";
import { parseIntentText } from "../intent/text-parser";
import { generateAsyncResult, resultForCandidate } from "../intent/pipeline";
import { applyGenerationResultCommand } from "../commands/commands";
import { applyArrangeOps } from "../intent/arrangeWords";
import { buildSong, applySongCommand, reviseSection, replacePatternInPlaceCommand } from "../intent/song";
import { applyMixIntent, planMixProfile } from "../intent/mix";
import { routeIntentText, REVISE_DELTA, type ReviseAttribute } from "../intent/route";
import { normalizeIntent } from "../intent/normalize";
import type { IntentInput } from "../intent/types";
import { rankerMode } from "../ai/ranking/ranker-client";
import { playAuditionBuffer, renderAuditionBuffer, stopAudition } from "../intent/audition";
import { semanticIntentFor } from "../intent/semantic";
import { takeIntentPrefill } from "../landing/handoff";
import { PublishToGalleryButton } from "../gallery/PublishButton";
import { renderProject } from "../rendering/renderer";
import { sanitizeFilename } from "../rendering/wav";
import { canExportVideo, recordVideo } from "../export/video";
import { downloadBlob } from "../export/download";
import { encodeShareCode, shareAppUrl } from "../export/shareCode";
import { funnelEvent } from "../services/funnel";
import type { GenerationResult, RankedCandidate } from "../intent/types";

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
        { mode: "apply", signal: controller.signal, includeBank: true },
      );
      if (controller.signal.aborted) return;
      if (!result.proposal) {
        const reason = result.diagnostics.errors[0] ?? result.diagnostics.fallbackReason ?? "generation rejected";
        setError(`Generation failed: ${reason} — try a different intent.`);
        return;
      }
      lastIntentRef.current = result.plan.intent;
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
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const intentInput = parsed?.input ?? {};
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
        buffer = await renderAuditionBuffer(doc, services.bank, candidate.pattern);
        buffersRef.current.set(candidate.candidateIndex, buffer);
      }
      if (playTokenRef.current !== token) return; // superseded meanwhile
      playAuditionBuffer(buffer, () => setPlayingIndex(null));
      setPlayingIndex(candidate.candidateIndex);
      setStatus(`▶ auditioning candidate #${candidate.candidateIndex + 1}`);
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
    services.store.execute(applyGenerationResultCommand(doc, picked, picked.plan.intent.genre || undefined));
    setBankResult(null);
    buffersRef.current = new Map();
    setStatus(
      candidate ? `✓ applied candidate #${candidate.candidateIndex + 1} (${candidate.source})` : `✓ pattern applied`,
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
  const [songBusy, setSongBusy] = useState(false);
  const generateSong = async () => {
    if (!text.trim() || songBusy || busy) return;
    setSongBusy(true);
    setError(null);
    setStatus(null);
    setBankResult(null);
    setJustApplied(false);
    stopAudition();
    try {
      const intentInput = parsed?.input ?? {};
      const build = await buildSong(
        doc,
        {
          ...intentInput,
          seed: `song-${Date.now()}`,
          roles: intentInput.roles ?? ["drums", "bass", "chords", "lead"],
        },
        {
          onProgress: (done, label, total) => setStatus(`♪ building song — ${label} (${done}/${total})`),
        },
      );
      services.store.execute(applySongCommand(doc, build));
      setStatus(`✓ ${build.name} — ${build.sections.length} sections, ${build.totalBars} bars (one undo step)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSongBusy(false);
    }
  };

  // D3 unified bar: route the text to the right executor — arrange ops,
  // mix profile, or (default) candidate generation.
  const [routeBusy, setRouteBusy] = useState(false);
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
      } else if (route.kind === "mix") {
        stopAudition();
        const intentInput = parsed?.input ?? {};
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
          const intentInput: IntentInput = { ...(parsed?.input ?? {}) };
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
      </div>
      {candidates && candidates.length > 0 && (
        <div className="intent-candidates" aria-label="Candidate bank">
          {candidates.map((candidate) => {
            const isWinner =
              bankResult?.proposal?.pattern.generation?.ranker?.selectedIndex === candidate.candidateIndex;
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
    </div>
  );
}

function rankerModeLabel(): string {
  const mode = rankerMode();
  return mode === "active" ? "ONNX active" : mode === "shadow" ? "shadow (heuristic)" : "ranker off";
}
