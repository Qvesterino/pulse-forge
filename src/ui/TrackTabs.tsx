import { useState } from "react";
import { useDoc, useServices } from "./context";
import { createDrumTrack, createGroupTrack, createInstrumentTrack, setTrackParams } from "../commands/commands";
import type { InstrumentKind, Track } from "../project-model/types";

const KIND_BADGE: Record<"drum" | "group" | InstrumentKind, string> = {
  drum: "DR",
  group: "GRP",
  sampler: "SMP",
  analog: "AN",
  bass: "BSS",
  "808": "808",
  texture: "TEX",
};

export function trackBadge(track: Track): string {
  if (track.kind === "drum") return KIND_BADGE.drum;
  if (track.kind === "group") return KIND_BADGE.group;
  return KIND_BADGE[track.instrument];
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
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const beginRename = (trackId: string, name: string) => {
    setEditingTrackId(trackId);
    setDraft(name);
  };

  const commitRename = () => {
    if (editingTrackId !== null && draft.trim() !== "") {
      const current = doc.tracks.find((t) => t.id === editingTrackId);
      if (current && current.name !== draft.trim()) {
        services.store.execute(setTrackParams(doc, editingTrackId, { name: draft.trim() }));
      }
    }
    setEditingTrackId(null);
  };

  return (
    <div className="track-tabs" role="tablist" aria-label="Tracks">
      {doc.tracks.map((track, idx) => {
        const isSelected = track.id === selectedTrackId;
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
            aria-label={`${track.name} (${track.kind === "drum" ? "Drum track" : track.kind === "group" ? "Group track" : `${track.instrument} track`})${track.mute ? ", muted" : ""}${track.solo ? ", soloed" : ""}`}
            className={`track-tab${isSelected ? " active" : ""}`}
            title={`${track.name} — select track (Alt+${idx + 1}), F2 to rename`}
            onClick={() => onSelectTrack(track.id)}
            onDoubleClick={() => beginRename(track.id, track.name)}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                beginRename(track.id, track.name);
              }
            }}
          >
            <span className="track-tab-badge">{trackBadge(track)}</span>
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
          } else if (value === "group") {
            services.store.execute(createGroupTrack(doc));
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
        <option value="texture">Texture Synth</option>
        <option value="group">Group</option>
      </select>
    </div>
  );
}
