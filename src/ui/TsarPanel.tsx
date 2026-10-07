import { useMemo } from "react";
import { useServices, useTracks } from "./context";
import { Slider } from "./controls";
import { tsarParams, TSAR_FACTORY_PRESETS } from "../tsar/params-placeholder";
import type { InstrumentTrack } from "../project-model/types";

/**
 * TSAR PANEL (docs/TSAR-ROADMAP.md T4) — placeholder scaffold.
 * The full editor (waveform view, mod grid, Forge drop) lands in T4.
 */
export function TsarPanel() {
  const services = useServices();
  const tracks = useTracks();
  const tsarTracks = useMemo(() => tracks.filter((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "tsar"), [tracks]);
  const track = tsarTracks[0];

  if (!track) {
    return (
      <div className="tsar-panel" role="region" aria-label="TSAR engine">
        <div className="fx-empty">No TSAR track in this project. Add one from the track list to open the engine.</div>
      </div>
    );
  }

  return (
    <div className="tsar-panel" role="region" aria-label="TSAR engine">
      <div className="tsar-header">
        <strong>TSAR</strong>
        <span>{track.name}</span>
        <span className="tsar-presets">{TSAR_FACTORY_PRESETS.length} factory presets</span>
      </div>
      <div className="tsar-grid">
        {tsarParams.slice(0, 12).map((param) => (
          <Slider
            key={param.id}
            compact
            label={param.label}
            value={track.params[param.id] ?? param.default}
            min={param.min}
            max={param.max}
            defaultValue={param.default}
            format={param.format}
            taper={param.taper}
            onCommit={(value) => {
              /* T4 wires the command */
              void services;
              void value;
            }}
          />
        ))}
      </div>
    </div>
  );
}
