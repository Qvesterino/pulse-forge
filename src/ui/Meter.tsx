import { useEffect, useRef, useState } from "react";
import type { AudioEngine } from "../audio-engine/AudioEngine";
import { registerRaf, unregisterRaf } from "../services/rafLoop";

/**
 * Mono peak meter for a track or return. Uses a ref-based `read` so the rAF
 * loop is only started once per tracked id — the meter survives parent
 * re-renders without tearing down its frame loop.
 */
export function Meter({ engine, kind, id }: { engine: AudioEngine; kind: "track" | "return"; id: string }) {
  const [state, setState] = useState({ level: 0, clipping: false });
  const smoothed = useRef(0);
  const clipUntil = useRef(0);
  const meterId = `meter-${kind}-${id}`;

  useEffect(() => {
    let last = 0;
    registerRaf(meterId, (t) => {
      if (t - last >= 33) {
        last = t;
        // Direct typed call — the engine owns the snapshot contract
        // (getTrackMeterSnapshot/getReturnMeterSnapshot). Duck-typed
        // optional access here would let a renamed engine method silently
        // degrade every mixer meter to the legacy level-only path.
        const snapshot = kind === "track" ? engine.getTrackMeterSnapshot(id) : engine.getReturnMeterSnapshot(id);
        const rawValue = snapshot.level;
        const value = Number.isFinite(rawValue) ? Math.max(0, rawValue) : 0;
        smoothed.current = Math.max(value, smoothed.current * 0.92);
        if (snapshot.clipping || snapshot.peakDb >= -0.1) clipUntil.current = t + 600;
        const clipping = clipUntil.current > t;
        const level = Math.min(1, smoothed.current);
        setState((previous) =>
          Math.abs(previous.level - level) > 0.005 || previous.clipping !== clipping ? { level, clipping } : previous,
        );
      }
    });
    return () => unregisterRaf(meterId);
  }, [engine, kind, id, meterId]);

  const color = state.clipping || state.level > 0.92 ? "#f87171" : state.level > 0.75 ? "#f59e0b" : "#4ade80";
  return (
    <div
      className={`meter${state.clipping ? " clipping" : ""}`}
      role="meter"
      aria-label="Level meter"
      aria-valuenow={Math.round(state.level * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={state.clipping ? "CLIP" : `${Math.round(state.level * 100)}%`}
      data-clipping={state.clipping ? "true" : "false"}
    >
      <div className="meter-fill" style={{ height: `${state.level * 100}%`, background: color }} />
    </div>
  );
}
