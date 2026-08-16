import { useState } from "react";
import { useDoc, useServices } from "./context";
import { deleteTrack, setMasterConfig, setReturnGain, setTrackParams, setTrackSend } from "../commands/commands";
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
        {doc.returns.map((ret) => (
          <div key={ret.id} className="channel-strip return-strip" aria-label={`Return ${ret.name}`}>
            <div className="channel-name">
              <span className="track-tab-badge">RTN</span>
              <span className="channel-name-label">{ret.name}</span>
            </div>
            <div className="channel-body">
              <div className="channel-controls">
                <Slider
                  compact
                  label="GAIN"
                  value={ret.gain}
                  min={0}
                  max={1.5}
                  defaultValue={0.9}
                  format={(v) => `${(20 * Math.log10(Math.max(v, 0.001))).toFixed(1)}`}
                  onCommit={(gain) => services.store.execute(setReturnGain(doc, ret.id, gain))}
                />
                <div className="return-fx-names">
                  {ret.effects.map((fx) => (
                    <span key={fx.id} className="return-fx-name">
                      {fx.type}
                    </span>
                  ))}
                </div>
              </div>
              <Meter read={() => services.engine.getReturnLevel(ret.id)} />
            </div>
          </div>
        ))}
        <MasterStrip />
      </div>
    </section>
  );
}

function MasterStrip() {
  const services = useServices();
  const doc = useDoc();
  return (
    <div className="channel-strip master-strip" aria-label="Master channel">
      <div className="channel-name">
        <span className="channel-name-label">MASTER</span>
      </div>
      <div className="channel-body">
        <div className="channel-controls">
          <button
            type="button"
            className={`btn btn-small${doc.master.limiterEnabled ? " active-solo" : ""}`}
            title="Master limiter (transparent safety ceiling)"
            onClick={() => services.store.execute(setMasterConfig(doc, { limiterEnabled: !doc.master.limiterEnabled }))}
          >
            LIMIT
          </button>
          <button
            type="button"
            className={`btn btn-small${doc.master.clipperEnabled ? " active-solo" : ""}`}
            title="Master soft clipper (character + loudness)"
            onClick={() => services.store.execute(setMasterConfig(doc, { clipperEnabled: !doc.master.clipperEnabled }))}
          >
            CLIP
          </button>
          <Meter read={() => services.engine.getMasterLevel()} />
        </div>
      </div>
    </div>
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
          {doc.returns.map((ret) => (
            <Slider
              key={ret.id}
              compact
              label={`→ ${ret.name.toUpperCase()}`}
              value={track.sends[ret.id] ?? 0}
              min={0}
              max={1.5}
              defaultValue={0}
              format={(v) => (v < 0.005 ? "OFF" : `${Math.round((v / 1.5) * 100)}%`)}
              onCommit={(level) => services.store.execute(setTrackSend(doc, track.id, ret.id, level))}
            />
          ))}
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
