import { useEffect, useMemo, useRef, useState } from "react";
import { useServices, useDoc } from "./context";
import { parseIntentText } from "../intent/text-parser";
import { generateAsyncResult } from "../intent/pipeline";
import { applyGenerationResultCommand } from "../commands/commands";
import { rankerMode } from "../ai/ranking/ranker-client";
import type { GenerationResult } from "../intent/types";

/**
 * INTENT dock panel — the "hlavný ťahák" (VISION §10): type what you want,
 * the engine generates + ranks candidates and delivers the best one.
 *
 * The UI only orchestrates: parse the text → request generation through the
 * canonical Intent Engine entry point → apply the returned result as one
 * undoable command. All candidate generation, invariant gating, ranking and
 * provenance live behind the engine boundary (intent pipeline + provider);
 * this panel never regenerates or re-validates engine output.
 */
export function IntentPanel() {
  const services = useServices();
  const doc = useDoc();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // A pending generation must not touch state after unmount (or after a
  // newer generate() superseded it) — the AbortController + token make the
  // continuation a no-op.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  /** Live parse preview — shows what the engine understood from the text. */
  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    return parseIntentText(text);
  }, [text]);

  const generate = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
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
          roles: intentInput.roles ?? ["drums", "bass"],
        },
        { mode: "apply", signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (!result.proposal) {
        const reason = result.diagnostics.errors[0] ?? result.diagnostics.fallbackReason ?? "generation rejected";
        setError(`Generation failed: ${reason} — try a different intent.`);
        return;
      }
      // Apply exactly the result the engine produced — no regeneration, one
      // undo step, provenance preserved (seed, hashes, ranker metadata).
      services.store.execute(applyGenerationResultCommand(doc, result, result.plan.intent.genre || undefined));
      const fallback = result.status === "fallback" ? " — heuristic fallback" : "";
      setStatus(`✓ pattern generated (${rankerModeLabel()}${fallback})`);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const detectedText = parsed?.detected.length ? parsed.detected.map((d) => `● ${d}`).join("  ") : null;

  return (
    <div className="intent-panel" aria-label="Intent Engine">
      <div className="intent-header">
        <span className="intent-title">INTENT</span>
        <span className="intent-subtitle">describe → generate → rank</span>
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
    </div>
  );
}

function rankerModeLabel(): string {
  const mode = rankerMode();
  return mode === "active" ? "ONNX active" : mode === "shadow" ? "shadow (heuristic)" : "ranker off";
}
