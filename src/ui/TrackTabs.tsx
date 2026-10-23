import { useEffect, useRef, useState } from "react";
import { useSelection, useServices, useTracks } from "./context";
import {
  createDrumTrack,
  createGenerativeTrack,
  createGroupTrack,
  createInstrumentTrack,
  setInstrumentSample,
  setTrackParams,
} from "../commands/commands";
import type { InstrumentKind, Track } from "../project-model/types";
import { INSTRUMENT_META, INSTRUMENT_ORDER } from "../instruments/definitions";
import { KYX_SAMPLE_MIME, sampleIdFromDrag } from "./SampleBrowser";

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
  organ: "ORG",
  strings: "STR",
  bell: "BEL",
  reese: "RES",
  clav: "CLV",
  acid: "ACD",
  brass: "BRS",
  fm: "FM",
  pluck: "PLK",
  flute: "FLT",
  logdrum: "LOG",
  spectral: "SPC",
  vocalchop: "VCX",
  drumsynth: "DSY",
  tsar: "TSR",
  kopa: "KPA",
  choral: "CH",
  ladic: "LD",
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
  const activeTrackButtonRef = useRef<HTMLButtonElement | null>(null);
  // Sample drop hover (V4) — which tab is currently under a KYX sample drag.
  const [sampleOver, setSampleOver] = useState<string | null>(null);
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

  useEffect(() => {
    activeTrackButtonRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedTrackId]);

  return (
    <div className="track-tabs" role="group" aria-label="Tracks">
      {tracks.map((track, idx) => {
        const isSelected = selection.trackIds.includes(track.id) || track.id === selectedTrackId;
        const isCurrentTrack = track.id === selectedTrackId;
        const isSecondaryMultiSelection =
          !isCurrentTrack && selection.trackIds.length > 1 && selection.trackIds.includes(track.id);
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
            ref={track.id === selectedTrackId ? activeTrackButtonRef : undefined}
            aria-pressed={isSelected}
            aria-current={isCurrentTrack ? "true" : undefined}
            aria-label={`${track.name} (${track.kind === "drum" ? "Drum track" : track.kind === "group" ? "Group track" : track.kind === "generative" ? "Generative track" : `${track.instrument} track`})${track.mute ? ", muted" : ""}${track.solo ? ", soloed" : ""}${isCurrentTrack ? ", active track" : isSecondaryMultiSelection ? ", included in the multi-track selection" : ""}`}
            data-current-track={isCurrentTrack || undefined}
            data-multi-selected={isSecondaryMultiSelection || undefined}
            className={`track-tab${isSelected ? " active" : ""}${sampleOver === track.id ? " drop-target" : ""}`}
            title={`${track.name} — select track (${idx < 9 ? `${idx + 1}, ` : ""}F2 to rename) — Ctrl+click add, Shift+click range${track.kind === "instrument" ? " · drop a sample to load it" : ""}`}
            onClick={(e) => onSelectTrack(track.id, e)}
            onDoubleClick={() => beginRename(track.id, track.name)}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                beginRename(track.id, track.name);
              }
            }}
            onDragOver={(event) => {
              // Sample drop (V4): instrument tracks load a dragged sound as
              // their sample; drum tracks route through their pads instead,
              // so the tab stays inert for them.
              if (track.kind !== "instrument") return;
              if (!event.dataTransfer.types.includes(KYX_SAMPLE_MIME)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setSampleOver(track.id);
            }}
            onDragLeave={() => setSampleOver((current) => (current === track.id ? null : current))}
            onDrop={(event) => {
              if (track.kind !== "instrument") return;
              const assetId = sampleIdFromDrag(event.dataTransfer);
              setSampleOver(null);
              if (!assetId) return;
              event.preventDefault();
              services.store.execute(setInstrumentSample(doc, track.id, assetId));
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
        {/* Registry-driven, not hand-listed. The hardcoded list this replaced
            offered 15 kinds while `INSTRUMENT_ORDER` has 24, and TrackTabs is
            the only UI caller of `createInstrumentTrack` — so organ, strings,
            bell, reese, clav, acid, brass, fm and tsar were fully implemented
            yet unreachable from the UI. Labels now come from INSTRUMENT_META,
            which also removes the drift where this menu said "KOPA Kick
            Designer" / "Keys Synth" while the registry says "KOPA" / "Keys". */}
        {INSTRUMENT_ORDER.map((kind) => (
          <option key={kind} value={kind}>
            {INSTRUMENT_META[kind].name}
          </option>
        ))}
        <option value="group">Group</option>
      </select>
    </div>
  );
}
