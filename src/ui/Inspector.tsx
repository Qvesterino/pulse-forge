import { useDoc, useServices } from "./context";
import { setPadParams, setTrackParams, setInstrumentParam, setInstrumentSample } from "../commands/commands";
import type { Track } from "../project-model/types";
import { FACTORY_ASSETS } from "../sample-library/manifest";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import { pitchName } from "../project-model/types";
import { Slider } from "./controls";
import { PresetBrowser } from "./PresetBrowser";

const TONAL_ASSETS = FACTORY_ASSETS.filter((a) => a.category === "Tonal");

export function Inspector({ track, selectedPadId }: { track: Track; selectedPadId: string }) {
  const services = useServices();
  const doc = useDoc();

  const trackSection = (
    <>
      <h2 className="panel-title">TRACK — {track.name}</h2>
      <Slider
        label="Volume"
        value={track.gain}
        min={0}
        max={1.5}
        defaultValue={0.9}
        format={(v) => `${(20 * Math.log10(Math.max(v, 0.001))).toFixed(1)} dB`}
        onCommit={(gain) => services.store.execute(setTrackParams(doc, track.id, { gain }))}
      />
      <Slider
        label="Pan"
        value={track.pan}
        min={-1}
        max={1}
        defaultValue={0}
        format={(v) => (Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`)}
        onCommit={(pan) => services.store.execute(setTrackParams(doc, track.id, { pan }))}
      />
    </>
  );

  if (track.kind === "instrument") {
    const def = INSTRUMENT_DEFS[track.instrument];
    return (
      <aside className="inspector" aria-label="Inspector">
        <h2 className="panel-title">{def.name.toUpperCase()} — {track.name}</h2>

        <PresetBrowser track={track} />

        {track.instrument === "sampler" && (
          <label className="field">
            <span className="field-label">Sample</span>
            <select
              value={track.sampleId ?? ""}
              onChange={(event) =>
                services.store.execute(setInstrumentSample(doc, track.id, event.target.value || null))
              }
            >
              <option value="">— none —</option>
              {TONAL_ASSETS.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name} ({asset.character})
                </option>
              ))}
            </select>
          </label>
        )}

        {def.params.map((p) =>
          p.options ? (
            <label key={p.id} className="fx-param-select">
              <span className="slider-label">{p.label}</span>
              <select
                value={p.options.some((o) => o.value === (track.params[p.id] ?? p.default)) ? track.params[p.id] ?? p.default : p.default}
                onChange={(event) =>
                  services.store.execute(setInstrumentParam(doc, track.id, p.id, Number(event.target.value)))
                }
              >
                {p.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <Slider
              key={p.id}
              compact
              label={p.id === "root" ? `ROOT (${pitchName(Math.round(track.params[p.id] ?? p.default))})` : p.label}
              value={track.params[p.id] ?? p.default}
              min={p.min}
              max={p.max}
              defaultValue={p.default}
              format={p.format}
              onCommit={(v) => services.store.execute(setInstrumentParam(doc, track.id, p.id, v))}
            />
          ),
        )}

        {trackSection}
      </aside>
    );
  }

  const pad = track.pads.find((p) => p.id === selectedPadId) ?? track.pads[0];
  if (!pad) return null;

  return (
    <aside className="inspector" aria-label="Inspector">
      <h2 className="panel-title">PAD — {pad.name}</h2>

      <label className="field">
        <span className="field-label">Sample</span>
        <select
          value={pad.assetId ?? ""}
          onChange={(event) =>
            services.store.execute(setPadParams(doc, pad.id, { assetId: event.target.value || null }))
          }
        >
          <option value="">— none —</option>
          {FACTORY_ASSETS.filter((a) => a.category !== "Tonal").map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.category} · {asset.name}
            </option>
          ))}
        </select>
      </label>

      <Slider
        label="Gain"
        value={pad.gain}
        min={0}
        max={2}
        defaultValue={1}
        format={(v) => `${(20 * Math.log10(Math.max(v, 0.001))).toFixed(1)} dB`}
        onCommit={(gain) => services.store.execute(setPadParams(doc, pad.id, { gain }))}
      />
      <Slider
        label="Pan"
        value={pad.pan}
        min={-1}
        max={1}
        defaultValue={0}
        format={(v) => (Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`)}
        onCommit={(pan) => services.store.execute(setPadParams(doc, pad.id, { pan }))}
      />
      <Slider
        label="Pitch"
        value={pad.pitch}
        min={-24}
        max={24}
        defaultValue={0}
        format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} st`}
        onCommit={(pitch) => services.store.execute(setPadParams(doc, pad.id, { pitch }))}
      />

      <div className="pad-toggles">
        <button
          type="button"
          className={`btn btn-small${pad.mute ? " active-mute" : ""}`}
          onClick={() => services.store.execute(setPadParams(doc, pad.id, { mute: !pad.mute }))}
        >
          MUTE
        </button>
        <button
          type="button"
          className={`btn btn-small${pad.solo ? " active-solo" : ""}`}
          onClick={() => services.store.execute(setPadParams(doc, pad.id, { solo: !pad.solo }))}
        >
          SOLO
        </button>
      </div>

      {trackSection}
    </aside>
  );
}
