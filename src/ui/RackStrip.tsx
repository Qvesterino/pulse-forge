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
    if (pad) services.engine.preview(pad, track.id);
  };

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
            title={`${pad.name} — click to preview and select`}
            onClick={() => {
              onSelectPad(pad.id);
              triggerPad(pad.id);
            }}
          >
            <span className="pad-index">{index + 1}</span>
            <span className="pad-name">{pad.name}</span>
          </button>
        );
      })}
    </section>
  );
}
