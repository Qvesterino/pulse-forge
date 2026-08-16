import { useDoc, useServices } from "./context";
import { createDrumTrack, createInstrumentTrack } from "../commands/commands";
import type { InstrumentKind, Track } from "../project-model/types";

const KIND_BADGE: Record<"drum" | InstrumentKind, string> = {
  drum: "DR",
  sampler: "SMP",
  analog: "AN",
  bass: "BSS",
  "808": "808",
};

export function trackBadge(track: Track): string {
  return track.kind === "drum" ? KIND_BADGE.drum : KIND_BADGE[track.instrument];
}

export function TrackTabs({
  selectedTrackId,
  onSelectTrack,
}: {
  selectedTrackId: string;
  onSelectTrack: (trackId: string) => void;
}) {
  const services = useServices();
  const doc = useDoc();

  return (
    <div className="track-tabs" role="tablist" aria-label="Tracks">
      {doc.tracks.map((track, idx) => (
        <button
          key={track.id}
          type="button"
          role="tab"
          aria-selected={track.id === selectedTrackId}
          aria-label={`${track.name} (${track.kind === "drum" ? "Drum track" : `${track.instrument} track`})${track.mute ? ", muted" : ""}${track.solo ? ", soloed" : ""}`}
          className={`track-tab${track.id === selectedTrackId ? " active" : ""}`}
          title={`${track.name} — select track (Alt+${idx + 1})`}
          onClick={() => onSelectTrack(track.id)}
        >
          <span className="track-tab-badge">{trackBadge(track)}</span>
          {track.name}
        </button>
      ))}
      <select
        className="fx-add-select track-add"
        value=""
        aria-label="Add track"
        onChange={(event) => {
          const value = event.target.value;
          if (!value) return;
          if (value === "drum") {
            services.store.execute(createDrumTrack(doc));
          } else {
            services.store.execute(createInstrumentTrack(doc, value as InstrumentKind));
          }
        }}
      >
        <option value="">+ TRACK</option>
        <option value="drum">Drum Rack</option>
        <option value="sampler">Sampler</option>
        <option value="analog">Analog Synth</option>
        <option value="bass">Bass Synth</option>
        <option value="808">808 Synth</option>
      </select>
    </div>
  );
}
