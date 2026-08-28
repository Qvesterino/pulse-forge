import { useEffect, useRef, useState } from "react";
import type { AudioEngine } from "../audio-engine/AudioEngine";
import { registerRaf, unregisterRaf } from "../services/rafLoop";

/**
 * Mono peak meter for a track or return. Uses a ref-based `read` so the rAF
 * loop is only started once per tracked id — the meter survives parent
 * re-renders without tearing down its frame loop.
 */
export function Meter({ engine, kind, id }: { engine: AudioEngine; kind: "track" | "return"; id: string }) {
  const [level, setLevel] = useState(0);
  const smoothed = useRef(0);
  const meterId = `meter-${kind}-${id}`;

  useEffect(() => {
    let last = 0;
    const read = () => (kind === "track" ? engine.getTrackLevel(id) : engine.getReturnLevel(id));
    registerRaf(meterId, (t) => {
      if (t - last >= 33) {
        last = t;
        const value = read();
        smoothed.current = Math.max(value, smoothed.current * 0.92);
        setLevel(Math.min(1, smoothed.current));
      }
    });
    return () => unregisterRaf(meterId);
  }, [engine, kind, id, meterId]);

  const color = level > 0.92 ? "#f87171" : level > 0.75 ? "#f59e0b" : "#4ade80";
  return (
    <div
      className="meter"
      role="meter"
      aria-label="Level meter"
      aria-valuenow={Math.round(level * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="meter-fill" style={{ height: `${level * 100}%`, background: color }} />
    </div>
  );
}
