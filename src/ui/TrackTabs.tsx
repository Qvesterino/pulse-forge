import { useState } from "react";
import { useSelection, useServices, useTracks } from "./context";
import {
  createDrumTrack,
  createGenerativeTrack,
  createGroupTrack,
  createInstrumentTrack,
  setTrackParams,
} from "../commands/commands";
import type { InstrumentKind, Track } from "../project-model/types";

const KIND_BADGE: Record<"drum" | "group" | InstrumentKind, string> = {
  drum: "DR",
  group: "GRP",
  sampler: "SMP",
  analog: "AN",
  bass: "BSS",
  "808": "808",
  texture: "TEX",
  wavetable: "WT",
  granular: "GRN",
  keys: "KEY",
  fm: "FM",
  pluck: "PLK",
  logdrum: "LOG",
  spectral: "SPC",
  vocalchop: "VCX",
  drumsynth: "DSY",
};

export function trackBadge(track: Track): string {
  if (track.kind === "drum") return KIND_BADGE.drum;
  if (track.kind === "group") return KIND_BADGE.group;
  if (track.kind === "generative") return "AI";
  return KIND_BADGE[track.instrument];
}

export function TrackTabs({
  selectedTrackId,
  onSelectTrack,
}: {
  selectedTrackId: string;
  onSelectTrack: (trackId: string, e?: React.MouseEvent) => void;
}) {
  const selection = useSelection();
  const services = useServices();
  // Fine-grained selector (GOAL 04): TrackTabs only ever reads `tracks`.
  // Subscribing to the whole document via `useDoc()` would re-render every
  // tab on every unrelated edit (a return gain, a macro mapping change).
  const tracks = useTracks();
  const doc = services.store.getDoc();
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const beginRename = (trackId: string, name: string) => {
    setEditingTrackId(trackId);
    setDraft(name);
  };

  const commitRename = () => {
    if (editingTrackId !== null && draft.trim() !== "") {
      const current = tracks.find((t) => t.id === editingTrackId);
      if (current && current.name !== draft.trim()) {
        services.store.execute(setTrackParams(doc, editingTrackId, { name: draft.trim() }));
      }
    }
    setEditingTrackId(null);
  };

  return (
    <div className="track-tabs" role="tablist" aria-label="Tracks">
      {tracks.map((track, idx) => {
        const isSelected = selection.trackIds.includes(track.id) || track.id === selectedTrackId;
        if (editingTrackId === track.id) {
          return (
            <input
              key={track.id}
              className="track-tab-rename"
              value={draft}
              autoFocus
              aria-label="Track name"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setEditingTrackId(null);
              }}
            />
          );
        }
        return (
          <button
            key={track.id}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-label={`${track.name} (${track.kind === "drum" ? "Drum track" : track.kind === "group" ? "Group track" : track.kind === "generative" ? "Generative track" : `${track.instrument} track`})${track.mute ? ", muted" : ""}${track.solo ? ", soloed" : ""}`}
            className={`track-tab${isSelected ? " active" : ""}`}
            title={`${track.name} — select track (${idx < 9 ? `${idx + 1}, ` : ""}Tab cycles), F2 to rename — Ctrl+click add, Shift+click range`}
            onClick={(e) => onSelectTrack(track.id, e)}
            onDoubleClick={() => beginRename(track.id, track.name)}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                beginRename(track.id, track.name);
              }
            }}
          >
            <span className="track-tab-badge">{trackBadge(track)}</span>
            {track.color && <span className="track-color-dot" style={{ background: track.color }} aria-hidden="true" />}
            {track.name}
          </button>
        );
      })}
      <select
        className="fx-add-select track-add"
        value=""
        aria-label="Add track"
        onChange={(event) => {
          const value = event.target.value;
          if (!value) return;
          if (value === "drum") {
            services.store.execute(createDrumTrack(doc));
          } else if (value === "generative") {
            services.store.execute(createGenerativeTrack(doc));
          } else if (value === "group") {
            services.store.execute(createGroupTrack(doc));
          } else {
            services.store.execute(createInstrumentTrack(doc, value as InstrumentKind));
          }
        }}
      >
        <option value="">+ TRACK</option>
        <option value="drum">Drum Rack</option>
        <option value="generative">MRT2 Generative</option>
        <option value="sampler">Sampler</option>
        <option value="analog">Analog Synth</option>
        <option value="bass">Bass Synth</option>
        <option value="808">808 Synth</option>
        <option value="texture">Texture Synth</option>
        <option value="wavetable">Wavetable Synth</option>
        <option value="granular">Granular Synth</option>
        <option value="keys">Keys Synth</option>
        <option value="pluck">Pluck Synth</option>
        <option value="logdrum">Log Drum</option>
        <option value="spectral">Spectral Pad</option>
        <option value="vocalchop">Vocal Chop</option>
        <option value="drumsynth">Drum Synth</option>
        <option value="group">Group</option>
      </select>
    </div>
  );
}
