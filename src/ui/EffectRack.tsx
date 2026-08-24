import { useDoc, useServices } from "./context";
import type { EffectType, Track } from "../project-model/types";
import { addEffect, applyEffectPreset, moveEffect, removeEffect, setEffectParam, setEffectSidechainSource, toggleEffectBypass } from "../commands/commands";
import { CORE_EFFECT_ORDER, EFFECT_DEFS } from "../effects/registry";
import { presetsForEffect } from "../effects/presets";
import { Slider } from "./controls";

export function EffectRack({ track }: { track: Track }) {
  const services = useServices();
  const doc = useDoc();

  return (
    <section className="fx-rack" aria-label={`Effect rack — ${track.name}`}>
      <div className="fx-rack-header">
        <h2 className="panel-title">FX — {track.name}</h2>
        <select
          className="fx-add-select"
          value=""
          aria-label="Add effect"
          onChange={(event) => {
            const type = event.target.value as EffectType;
            if (type) services.store.execute(addEffect(doc, track.id, type));
          }}
        >
          <option value="">+ ADD EFFECT</option>
          {CORE_EFFECT_ORDER.map((type) => (
            <option key={type} value={type}>
              {EFFECT_DEFS[type].name}
            </option>
          ))}
        </select>
      </div>
      {track.effects.length === 0 ? (
        <div className="fx-empty">No effects on this track. Add one above.</div>
      ) : (
        <div className="fx-devices">
          {track.effects.map((fx, index) => (
            <Device key={fx.id} track={track} fx={fx} index={index} count={track.effects.length} />
          ))}
        </div>
      )}
    </section>
  );
}

function Device({
  track,
  fx,
  index,
  count,
}: {
  track: Track;
  fx: TrackEffect;
  index: number;
  count: number;
}) {
  const services = useServices();
  const doc = useDoc();
  const def = EFFECT_DEFS[fx.type];

  return (
    <div className={`fx-device${fx.bypassed ? " bypassed" : ""}`}>
      <div className="fx-device-header">
        <span className="fx-device-name">{def.name}</span>
        {presetsForEffect(fx.type).length > 0 && (
          <select
            className="fx-preset-select"
            value=""
            aria-label={`Preset for ${def.name}`}
            onChange={(event) => {
              const selected = presetsForEffect(fx.type).find((item) => item.id === event.target.value);
              if (selected) services.store.execute(applyEffectPreset(doc, track.id, fx.id, selected));
            }}
          >
            <option value="">PRESETS</option>
            {presetsForEffect(fx.type).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        )}
        <div className="fx-device-buttons">
          <button
            type="button"
            className="btn btn-small"
            title="Move earlier in chain"
            disabled={index === 0}
            onClick={() => services.store.execute(moveEffect(doc, track.id, fx.id, -1))}
          >
            ◀
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Move later in chain"
            disabled={index === count - 1}
            onClick={() => services.store.execute(moveEffect(doc, track.id, fx.id, 1))}
          >
            ▶
          </button>
          <button
            type="button"
            className={`btn btn-small${fx.bypassed ? " active-mute" : ""}`}
            title={fx.bypassed ? "Enable effect" : "Bypass effect"}
            onClick={() => services.store.execute(toggleEffectBypass(doc, track.id, fx.id))}
          >
            B
          </button>
          <button
            type="button"
            className="btn btn-small btn-danger"
            title="Remove effect"
            onClick={() => services.store.execute(removeEffect(doc, track.id, fx.id))}
          >
            ×
          </button>
        </div>
      </div>
      {fx.type === "eq" && <EqResponseCurve params={fx.params} />}
      {fx.type === "sidechain" && (
        <div className="fx-sidechain-picker">
          <label className="fx-param-select">
            <span className="slider-label">SOURCE</span>
            <select
              value={fx.sidechainTrackId ?? ""}
              onChange={(event) => services.store.execute(setEffectSidechainSource(doc, track.id, fx.id, event.target.value || null))}
            >
              <option value="">OFF</option>
              {doc.tracks.filter((candidate) => candidate.id !== track.id).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.kind === "group" ? " · BUS" : ""}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-small"
            title="Choose the first kick drum track, or the first drum track"
            onClick={() => {
              const drums = doc.tracks.filter((candidate) => candidate.kind === "drum");
              const kick = drums.find((candidate) => candidate.name.toLowerCase().includes("kick") || candidate.pads.some((pad) => pad.name.toLowerCase().includes("kick"))) ?? drums[0];
              if (kick) services.store.execute(setEffectSidechainSource(doc, track.id, fx.id, kick.id));
            }}
          >
            KICK
          </button>
          <span className="fx-sidechain-status">{fx.sidechainTrackId ? doc.tracks.find((candidate) => candidate.id === fx.sidechainTrackId)?.name ?? "MISSING" : "No source"}</span>
        </div>
      )}
      <div className="fx-device-params">
        {def.params.filter((p) => !((fx.type === "eq") && ["lowGain", "lowFreq", "midGain", "midFreq", "midQ", "highGain", "highFreq"].includes(p.id))).map((p) =>
          p.options ? (
            <label key={p.id} className="fx-param-select">
              <span className="slider-label">{p.label}</span>
              <select
                value={p.options.some((o) => o.value === (fx.params[p.id] ?? p.default)) ? fx.params[p.id] ?? p.default : p.default}
                onChange={(event) =>
                  services.store.execute(setEffectParam(doc, track.id, fx.id, p.id, Number(event.target.value)))
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
              label={p.label}
              value={fx.params[p.id] ?? p.default}
              min={p.min}
              max={p.max}
              defaultValue={p.default}
              format={p.format}
              onCommit={(v) => services.store.execute(setEffectParam(doc, track.id, fx.id, p.id, v))}
            />
          ),
        )}
      </div>
    </div>
  );
}

function EqResponseCurve({ params }: { params: Record<string, number> }) {
  const points = [
    [0, 42], [12, 42 - (params.lowShelfGain ?? 0) * 1.2], [31, 42 - (params.lowMidGain ?? 0) * 1.2],
    [58, 42 - (params.highMidGain ?? 0) * 1.2], [84, 42 - (params.highShelfGain ?? 0) * 1.2], [100, 42],
  ].map(([x, y]) => `${x},${Math.max(4, Math.min(60, y))}`).join(" ");
  return (
    <div className="eq-response-curve" aria-label="EQ response curve">
      <svg viewBox="0 0 100 60" preserveAspectRatio="none" role="img">
        <polyline points="0,42 100,42" className="eq-response-zero" />
        <polyline points={points} className="eq-response-line" />
      </svg>
      <span>RESPONSE</span>
    </div>
  );
}

type TrackEffect = Track["effects"][number];
