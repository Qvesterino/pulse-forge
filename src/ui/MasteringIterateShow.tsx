import { useEffect, useRef, useState } from "react";

/**
 * ITERATE LIGHT-SHOW — the AI mastering convergence as a performance.
 *
 * Takes the structured iteration data from op:iterate and renders each
 * adjustment as a "phase step": bars converge toward the target line,
 * param names flash as they change, and the final state (CONVERGED /
 * CAPPED) drops with a status flash. Pure visual — no audio logic.
 */

export interface IterateShowStep {
  iteration: number;
  deviceParam: string;
  from: number;
  to: number;
}

export interface IterateShowData {
  iterations: IterateShowStep[];
  converged: boolean;
}

/** Normalize steps to a 0..1 convergence progress per iteration. */
function convergenceProgress(steps: IterateShowStep[]): number[] {
  // Group by iteration, measure how much the deltas shrank vs iteration 0.
  const byIteration = new Map<number, { total: number; count: number }>();
  for (const step of steps) {
    const entry = byIteration.get(step.iteration) ?? { total: 0, count: 0 };
    entry.total += Math.abs(step.to - step.from);
    entry.count += 1;
    byIteration.set(step.iteration, entry);
  }
  const iterations = [...byIteration.keys()].sort((a, b) => a - b);
  if (iterations.length === 0) return [];
  const firstTotal = byIteration.get(iterations[0]!)?.total ?? 1;
  return iterations.map((it) => {
    const entry = byIteration.get(it)!;
    return Math.max(0, 1 - entry.total / Math.max(firstTotal, 1e-6));
  });
}

export function MasteringIterateShow({ data, onClose }: { data: IterateShowData; onClose?: () => void }) {
  const [visible, setVisible] = useState(0);
  const [dropped, setDropped] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Phase reveal: each adjustment group appears with a delay — the build.
  useEffect(() => {
    const uniqueIterations = [...new Set(data.iterations.map((s) => s.iteration))];
    let i = 0;
    timerRef.current = setInterval(() => {
      i += 1;
      setVisible(i);
      if (i >= uniqueIterations.length) {
        if (timerRef.current) clearInterval(timerRef.current);
        // THE DROP: flash the convergence status after the last phase.
        setTimeout(() => setDropped(true), 400);
      }
    }, 600);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [data.iterations.length]);

  const progress = convergenceProgress(data.iterations);
  const uniqueIterations = [...new Set(data.iterations.map((s) => s.iteration))];

  return (
    <div
      className="iterate-show"
      role="status"
      aria-label={dropped ? `AI mastering ${data.converged ? "converged" : "capped"}` : "AI mastering in progress"}
      data-dropped={dropped ? "true" : undefined}
    >
      <div className="iterate-show-header">
        <span className="iterate-show-icon">{dropped ? "⚡" : "◉"}</span>
        <span className="iterate-show-title">{dropped ? (data.converged ? "CONVERGED" : "CAPPED") : "MASTERING…"}</span>
        {onClose && (
          <button type="button" className="iterate-show-close" onClick={onClose} aria-label="Dismiss">
            ×
          </button>
        )}
      </div>
      <div className="iterate-show-phases">
        {uniqueIterations.map((it, idx) => {
          const isActive = idx < visible;
          const convergence = progress[idx] ?? 0;
          return (
            <div
              key={it}
              className={`iterate-phase${isActive ? " active" : ""}${dropped && idx === uniqueIterations.length - 1 ? " final" : ""}`}
              style={{ "--phase-delay": `${idx * 0.15}s` } as React.CSSProperties}
            >
              <div className="iterate-phase-header">
                <span className="iterate-phase-number">{String(it + 1).padStart(2, "0")}</span>
                <span className="iterate-phase-label">PHASE {it + 1}</span>
              </div>
              <div className="iterate-phase-convergence">
                <div className="iterate-phase-bar" style={{ width: `${isActive ? convergence * 100 : 0}%` }} />
                <span className="iterate-phase-pct">{isActive ? `${Math.round(convergence * 100)}%` : "…"}</span>
              </div>
              {data.iterations
                .filter((s) => s.iteration === it)
                .slice(0, 4)
                .map((step, si) => (
                  <div key={si} className={`iterate-step${isActive ? " active" : ""}`}>
                    <span className="iterate-step-param">{step.deviceParam}</span>
                    <span className="iterate-step-values">
                      {step.from.toFixed(2)} → {step.to.toFixed(2)}
                    </span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
      {dropped && (
        <div className="iterate-drop-flash" aria-hidden="true">
          {data.converged ? "◆ TARGET LOCKED" : "◇ BOUNDED — manual polish recommended"}
        </div>
      )}
    </div>
  );
}
