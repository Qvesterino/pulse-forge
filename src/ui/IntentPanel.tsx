import { useMemo, useState } from "react";
import { useServices, useDoc } from "./context";
import { parseIntentText } from "../intent/text-parser";
import { normalizeIntent } from "../intent/normalize";
import { planGeneration } from "../intent/plan";
import { generatePattern } from "../ai/generator";
import { inspectPatternInvariants } from "../ai/invariants";
import { generatePatternCommand } from "../commands/commands";
import type { IntentSpec } from "../intent/types";

/**
 * INTENT dock panel — the "hlavný ťahák" (VISION §10): type what you want,
 * the engine generates + ranks candidates and delivers the best one.
 *
 * Text → parseIntentText → normalizeIntent → planGeneration → provider
 * → candidate bank → ONNX ranker (shadow/active) → pattern → command.
 */
export function IntentPanel() {
  const services = useServices();
  const doc = useDoc();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    try {
      const intentInput = parsed?.input ?? {};
      const intent: IntentSpec = normalizeIntent({
        ...intentInput,
        seed: `intent-${Date.now()}`,
        candidateCount: 3,
        roles: intentInput.roles ?? ["drums", "bass"],
      });
      const plan = planGeneration(intent, doc);

      // Use the local provider's candidate bank + ranker (via the pipeline)
      const pattern = generatePattern(doc, plan.options);
      const report = inspectPatternInvariants(doc, pattern, {
        checkScale: Boolean(plan.options.key ?? doc.key),
        key: plan.options.key ?? doc.key,
      });
      if (!report.ok) {
        setError("Generated pattern failed invariant checks — try a different intent.");
        return;
      }
      services.store.execute(generatePatternCommand(doc, plan.options, intent.genre || undefined));
      setStatus(`✓ pattern generated (${rankerModeLabel()})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
  try {
    const mode = localStorage.getItem("pf:intent-ranker") ?? "shadow";
    return mode === "active" ? "ONNX active" : "shadow (heuristic)";
  } catch {
    return "shadow";
  }
}
