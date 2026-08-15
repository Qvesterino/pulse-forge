import { useState } from "react";
import { useDoc, useServices } from "./context";
import { deleteTrack, setTrackParams } from "../commands/commands";
import type { Track } from "../project-model/types";
import { Slider } from "./controls";
import { Meter } from "./Meter";
import { trackBadge } from "./TrackTabs";

export function Mixer() {
  const services = useServices();
  const doc = useDoc();

  return (
    <section className="mixer" aria-label="Mixer">
      <div className="mixer-strips">
        {doc.tracks.map((track) => (
          <ChannelStrip key={track.id} track={track} canDelete={doc.tracks.length > 1} />
        ))}
        <div className="channel-strip master-strip" aria-label="Master channel">
          <div className="channel-name">
            <span className="channel-name-label">MASTER</span>
          </div>
          <div className="channel-body">
            <div className="channel-controls">
              <Meter read={() => services.engine.getMasterLevel()} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ChannelStrip({ track, canDelete }: { track: Track; canDelete: boolean }) {
  const services = useServices();
  const doc = useDoc();
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  return (
    <div className="channel-strip">
      <div className="channel-name">
        <span className="track-tab-badge">{trackBadge(track)}</span>
        <input
          className="channel-name-input"
          value={nameDraft ?? track.name}
          aria-label={`Track ${track.id} name`}
          onChange={(event) => setNameDraft(event.target.value)}
          onBlur={() => {
            if (nameDraft !== null && nameDraft.trim() !== "" && nameDraft !== track.name) {
              services.store.execute(setTrackParams(doc, track.id, { name: nameDraft.trim() }));
            }
            setNameDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </div>
      <div className="channel-body">
        <div className="channel-controls">
          <Slider
            label="VOL"
            value={track.gain}
            min={0}
            max={1.5}
            defaultValue={0.9}
            format={(v) => (20 * Math.log10(Math.max(v, 0.001))).toFixed(1)}
            onCommit={(gain) => services.store.execute(setTrackParams(doc, track.id, { gain }))}
          />
          <Slider
            label="PAN"
            value={track.pan}
            min={-1}
            max={1}
            defaultValue={0}
            format={(v) => (Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`)}
            onCommit={(pan) => services.store.execute(setTrackParams(doc, track.id, { pan }))}
          />
        </div>
        <Meter read={() => services.engine.getTrackLevel(track.id)} />
      </div>
      <div className="channel-buttons">
        <button
          type="button"
          className={`btn btn-small${track.mute ? " active-mute" : ""}`}
          title="Mute track"
          onClick={() => services.store.execute(setTrackParams(doc, track.id, { mute: !track.mute }))}
        >
          M
        </button>
        <button
          type="button"
          className={`btn btn-small${track.solo ? " active-solo" : ""}`}
          title="Solo track"
          onClick={() => services.store.execute(setTrackParams(doc, track.id, { solo: !track.solo }))}
        >
          S
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          title="Delete track"
          disabled={!canDelete}
          onClick={() => services.store.execute(deleteTrack(doc, track.id))}
        >
          ×
        </button>
      </div>
    </div>
  );
}
