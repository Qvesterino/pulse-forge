import { useEffect, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import type { DrumTrack } from "../project-model/types";
import { usePlayheadStep } from "./playhead";
import { assetCategoryOf, categoryColor } from "./kitColors";

export function RackStrip({
  track,
  selectedPadId,
  onSelectPad,
}: {
  track: DrumTrack;
  selectedPadId: string;
  onSelectPad: (padId: string) => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId)!;
  const playheadStep = usePlayheadStep(services.transport, doc);

  const triggerPad = (padId: string) => {
    const pad = track.pads.find((p) => p.id === padId);
    if (pad) {
      services.engine.preview(pad, track.id);
      const peak = pad.gain;
      setPeaks((prev) => ({ ...prev, [padId]: peak }));
    }
  };

  const [peaks, setPeaks] = useState<Record<string, number>>({});
  const peaksRef = useRef(peaks);
  peaksRef.current = peaks;

  // Decay peaks 60fps
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [id, v] of Object.entries(peaksRef.current)) {
        const nv = v * 0.88;
        if (nv > 0.02) {
          next[id] = nv;
          changed = true;
        } else changed = true;
      }
      if (changed) setPeaks(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Playhead hit → peak from pattern velocity * pad gain
  const prevStepRef = useRef<number>(-1);
  useEffect(() => {
    if (playheadStep < 0 || prevStepRef.current === playheadStep) return;
    prevStepRef.current = playheadStep;
    for (const pad of track.pads) {
      const vel = pattern.rows[pad.id]?.[playheadStep] ?? 0;
      if (vel > 0 && !pad.mute && !track.mute) {
        const peak = Math.min(1.2, vel * pad.gain);
        setPeaks((prev) => ({ ...prev, [pad.id]: peak }));
      }
    }
  }, [playheadStep, pattern.rows, track.pads, track.mute]);

  return (
    <section className="rack" aria-label="Drum Rack">
      {track.pads.map((pad, index) => {
        const hit = playheadStep >= 0 && (pattern.rows[pad.id]?.[playheadStep] ?? 0) > 0;
        const selected = pad.id === selectedPadId;
        return (
          <button
            key={pad.id}
            type="button"
            className={`pad${hit ? " hit" : ""}${selected ? " selected" : ""}`}
            style={{ "--pad-color": categoryColor(assetCategoryOf(pad)) } as React.CSSProperties}
            title={`${pad.name}${pad.synth ? ` — ${pad.synth.type} synth` : ""} — click to preview and select`}
            onClick={() => {
              onSelectPad(pad.id);
              triggerPad(pad.id);
            }}
          >
            <span className="pad-index">{index + 1}</span>
            <span className="pad-name">{pad.name}</span>
            {pad.synth && <span className="pad-synth-badge">{pad.synth.type.slice(0, 3).toUpperCase()}</span>}
            <span className="pad-meter" aria-hidden="true">
              <span className="pad-meter-fill" style={{ height: `${Math.min(100, (peaks[pad.id] ?? 0) * 100)}%` }} />
            </span>
          </button>
        );
      })}
    </section>
  );
}
