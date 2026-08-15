import { useDoc, useServices } from "./context";
import type { EffectType, Track } from "../project-model/types";
import { addEffect, moveEffect, removeEffect, setEffectParam, toggleEffectBypass } from "../commands/commands";
import { EFFECT_DEFS, EFFECT_ORDER } from "../effects/registry";
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
          {EFFECT_ORDER.map((type) => (
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
      <div className="fx-device-params">
        {def.params.map((p) =>
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

type TrackEffect = Track["effects"][number];
