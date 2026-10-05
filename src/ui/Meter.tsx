import { useEffect, useRef } from "react";
import type { AudioEngine } from "../audio-engine/AudioEngine";
import { registerRaf, unregisterRaf } from "../services/rafLoop";

/**
 * Mono peak meter for a track or return.
 *
 * `point` (track kind only) selects the meter tap: "post" (default) reads
 * after the fader/mute/solo gate — what you hear; "pre" reads the engine's
 * PRE-fader tap (post-insert, pre-pan/fader) — the gain-staging point that
 * stays alive on a soloed-out channel. Returns always meter post.
 *
 * PERFORMANCE: uses direct DOM mutation via refs instead of React state —
 * the RAF loop updates style.height and style.background every frame
 * without triggering React reconciliation. React renders the static shell
 * ONCE; all dynamic updates bypass the virtual DOM entirely.
 */
export function Meter({
  engine,
  kind,
  id,
  point = "post",
}: {
  engine: AudioEngine;
  kind: "track" | "return";
  id: string;
  point?: "post" | "pre";
}) {
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
    // Last applied DOM strings — in silence every poll computes the same
    // values, and re-writing identical styles/attributes 30×/s per strip
    // (one per track/return) is pure CSSOM churn.
    const applied = { height: "", bg: "", holdBottom: "", holdOpacity: "", holdBg: "", clip: "", aria: "" };
    registerRaf(meterId, (t) => {
      if (t - last < 33) return; // ~30 Hz
      last = t;
      const snapshot =
        kind === "return"
          ? engine.getReturnMeterSnapshot(id)
          : point === "pre"
            ? engine.getTrackPreMeterSnapshot(id)
            : engine.getTrackMeterSnapshot(id);
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

      // Direct DOM mutation — zero React reconciliation on the hot path,
      // and no write at all while the values are unchanged.
      const height = `${level * 100}%`;
      const bg = clipping || level > 0.92 ? "#f87171" : level > 0.75 ? "#f59e0b" : "#4ade80";
      if (height !== applied.height || bg !== applied.bg) {
        applied.height = height;
        applied.bg = bg;
        if (fillRef.current) {
          fillRef.current.style.height = height;
          fillRef.current.style.background = bg;
        }
      }
      const holdBottom = `${holdLevel.current * 100}%`;
      const holdOpacity = holdLevel.current > 0.01 ? "1" : "0";
      const holdBg = clipping ? "#f87171" : "#fff";
      if (holdBottom !== applied.holdBottom || holdOpacity !== applied.holdOpacity || holdBg !== applied.holdBg) {
        applied.holdBottom = holdBottom;
        applied.holdOpacity = holdOpacity;
        applied.holdBg = holdBg;
        if (holdRef.current) {
          holdRef.current.style.bottom = holdBottom;
          holdRef.current.style.opacity = holdOpacity;
          holdRef.current.style.background = holdBg;
        }
      }
      const clip = clipping ? "true" : "false";
      const aria = clipping ? "CLIP" : `${Math.round(level * 100)}%`;
      if (clip !== applied.clip || aria !== applied.aria) {
        applied.clip = clip;
        applied.aria = aria;
        if (rootRef.current) {
          rootRef.current.dataset.clipping = clip;
          rootRef.current.setAttribute("aria-valuenow", String(Math.round(level * 100)));
          rootRef.current.setAttribute("aria-valuetext", aria);
        }
      }
    });
    return () => unregisterRaf(meterId);
  }, [engine, kind, id, meterId, point]);

  return (
    <div
      ref={rootRef}
      className={`meter${point === "pre" ? " meter--pre" : ""}`}
      role="meter"
      aria-label={point === "pre" ? "Pre-fader level meter" : "Level meter"}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div ref={fillRef} className="meter-fill" style={{ height: "0%" }} />
      <div ref={holdRef} className="meter-hold" style={{ bottom: "0%", opacity: 0 }} />
    </div>
  );
}
