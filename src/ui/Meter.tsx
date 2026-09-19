import { useEffect, useRef } from "react";
import type { AudioEngine } from "../audio-engine/AudioEngine";
import { registerRaf, unregisterRaf } from "../services/rafLoop";

/**
 * Mono peak meter for a track or return.
 *
 * PERFORMANCE: uses direct DOM mutation via refs instead of React state —
 * the RAF loop updates style.height and style.background every frame
 * without triggering React reconciliation. React renders the static shell
 * ONCE; all dynamic updates bypass the virtual DOM entirely.
 */
export function Meter({ engine, kind, id }: { engine: AudioEngine; kind: "track" | "return"; id: string }) {
  const smoothed = useRef(0);
  const clipUntil = useRef(0);
  const holdLevel = useRef(0);
  const holdUntil = useRef(0);
  const meterId = `meter-${kind}-${id}`;
  const fillRef = useRef<HTMLDivElement>(null);
  const holdRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let last = 0;
    registerRaf(meterId, (t) => {
      if (t - last < 33) return; // ~30 Hz
      last = t;
      const snapshot = kind === "track" ? engine.getTrackMeterSnapshot(id) : engine.getReturnMeterSnapshot(id);
      const rawValue = snapshot.level;
      const value = Number.isFinite(rawValue) ? Math.max(0, rawValue) : 0;
      smoothed.current = Math.max(value, smoothed.current * 0.92);
      if (snapshot.clipping || snapshot.peakDb >= -0.1) clipUntil.current = t + 600;
      const clipping = clipUntil.current > t;
      const level = Math.min(1, smoothed.current);

      // Peak hold: latch the highest level, rest for ~700 ms, then decay.
      if (level >= holdLevel.current) {
        holdLevel.current = level;
        holdUntil.current = t + 700;
      } else if (t > holdUntil.current) {
        holdLevel.current = Math.max(0, holdLevel.current - 0.02);
      }

      // Direct DOM mutation — zero React reconciliation on the hot path.
      if (fillRef.current) {
        fillRef.current.style.height = `${level * 100}%`;
        fillRef.current.style.background = clipping || level > 0.92 ? "#f87171" : level > 0.75 ? "#f59e0b" : "#4ade80";
      }
      if (holdRef.current) {
        holdRef.current.style.bottom = `${holdLevel.current * 100}%`;
        holdRef.current.style.opacity = holdLevel.current > 0.01 ? "1" : "0";
        holdRef.current.style.background = clipping ? "#f87171" : "#fff";
      }
      if (rootRef.current) {
        rootRef.current.dataset.clipping = clipping ? "true" : "false";
        rootRef.current.setAttribute("aria-valuenow", String(Math.round(level * 100)));
        rootRef.current.setAttribute("aria-valuetext", clipping ? "CLIP" : `${Math.round(level * 100)}%`);
      }
    });
    return () => unregisterRaf(meterId);
  }, [engine, kind, id, meterId]);

  return (
    <div ref={rootRef} className={`meter`} role="meter" aria-label="Level meter" aria-valuemin={0} aria-valuemax={100}>
      <div ref={fillRef} className="meter-fill" style={{ height: "0%" }} />
      <div ref={holdRef} className="meter-hold" style={{ bottom: "0%", opacity: 0 }} />
    </div>
  );
}
