import { useEffect, useMemo, useRef, useState } from "react";
import { useServices, useDoc } from "./context";
import { parseIntentText } from "../intent/text-parser";
import { generateAsyncResult, resultForCandidate } from "../intent/pipeline";
import { applyGenerationResultCommand } from "../commands/commands";
import { rankerMode } from "../ai/ranking/ranker-client";
import {
  playAuditionBuffer,
  renderAuditionBuffer,
  stopAudition,
} from "../intent/audition";
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
  const doc = useDoc();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A1 audition state — the ranked bank lives on the result; buffers are
  // cached per candidate so replaying is instant after the first render.
  const [bankResult, setBankResult] = useState<GenerationResult | null>(null);
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

  /** Live parse preview — shows what the engine understood from the text. */
  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    return parseIntentText(text);
  }, [text]);

  const candidates = bankResult?.bank ?? null;

  const generate = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    setBankResult(null);
    setPlayingIndex(null);
    stopAudition();
    buffersRef.current = new Map();
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    try {
      const intentInput = parsed?.input ?? {};
      const result: GenerationResult = await generateAsyncResult(
        doc,
        {
          ...intentInput,
          seed: `intent-${Date.now()}`,
          candidateCount: 3,
          // T2: two extra candidates sampled from the ONNX symbolic drum
          // prior join the same bank; a missing model just shrinks the bank.
          symbolicCandidates: 2,
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
    const picked = candidate
      ? resultForCandidate(bankResult, candidate.candidateIndex)
      : bankResult;
    services.store.execute(applyGenerationResultCommand(doc, picked, picked.plan.intent.genre || undefined));
    setBankResult(null);
    buffersRef.current = new Map();
    setStatus(
      candidate
        ? `✓ applied candidate #${candidate.candidateIndex + 1} (${candidate.source})`
        : `✓ pattern applied`,
    );
  };

  const detectedText = parsed?.detected.length ? parsed.detected.map((d) => `● ${d}`).join("  ") : null;

  return (
    <div className="intent-panel" aria-label="Intent Engine">
      <div className="intent-header">
        <span className="intent-title">INTENT</span>
        <span className="intent-subtitle">describe → audition → choose</span>
      </div>
      <textarea
        className="intent-textarea"
        placeholder="dark rolling techno at 140 with lead…"
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
      <button
        type="button"
        className="btn intent-generate-btn"
        disabled={!text.trim() || busy}
        onClick={() => void generate()}
      >
        {busy ? "GENERATING…" : "GENERATE"}
      </button>
      {candidates && candidates.length > 0 && (
        <div className="intent-candidates" aria-label="Candidate bank">
          {candidates.map((candidate) => {
            const isWinner = bankResult?.proposal?.pattern.generation?.ranker?.selectedIndex === candidate.candidateIndex;
            const isPlaying = playingIndex === candidate.candidateIndex;
            const isRendering = renderingIndex === candidate.candidateIndex;
            return (
              <div
                key={candidate.candidateIndex}
                className={`intent-candidate-row${isWinner ? " winner" : ""}`}
              >
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
