import { useMemo, useState } from "react";
import { ALL_PARAMS, tryGetParamDef } from "../effects/ultina-core/contracts/parameterSchema";
import { DEFAULT_MODULE_ORDER } from "../effects/ultina-core/contracts/state";
import { FACTORY_PRESETS } from "../effects/ultina-core/presets/factoryPresets";
import { Slider } from "./controls";

const MODULE_LABELS: Record<string, string> = {
  gate: "GATE",
  eq: "EQ",
  comp: "COMP",
  exciter: "EXC",
  transient: "TRNS",
  density: "DENS",
  sculptor: "SCULP",
  clipper: "CLIP",
  phase: "PHASE",
  unmask: "UNMSK",
};

/** Params hidden from the panel — host/engine concerns, not mix decisions. */
const HIDDEN = new Set(["eq.learnActive", "eq.maskingMeterEnabled"]);

function formatUnit(value: number, unit: string): string {
  switch (unit) {
    case "db":
      return `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
    case "hz":
      return value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`;
    case "ms":
      return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
    case "percent":
      return `${Math.round(value)}%`;
    case "ratio":
      return `${value.toFixed(2)}:1`;
    case "degrees":
      return `${Math.round(value)}°`;
    default:
      return value.toFixed(2);
  }
}

/**
 * UltinaPanel — per-module editor for the Ultina Suite.
 *
 * Module chips follow the signal-graph order; the selected module's
 * parameters are generated from the VENDORED schema (ranges, defaults and
 * enum lists included), so the panel never drifts from the DSP. The EQ
 * module gets a dedicated 12-band editor with a response-curve sketch.
 */
export function UltinaPanel({
  params,
  degraded,
  onParam,
  onApplyPreset,
}: {
  params: Record<string, number>;
  degraded?: boolean;
  onParam: (paramId: string, value: number) => void;
  onApplyPreset: (presetName: string, presetParams: Record<string, number>) => void;
}) {
  const [selectedModule, setSelectedModule] = useState<string>("comp");
  const [selectedEqBand, setSelectedEqBand] = useState(0);

  const enabled = (mod: string) => (params[`${mod}.enabled`] ?? 0) >= 0.5;

  // Params of the selected module (schema defs, excluding hidden + enable).
  const moduleParams = useMemo(
    () =>
      ALL_PARAMS.filter(
        (d) => d.id.startsWith(`${selectedModule}.`) && d.unit !== "boolean" && !HIDDEN.has(d.id) && !/\.enabled$/.test(d.id),
      ),
    [selectedModule],
  );
  const booleanParams = useMemo(
    () =>
      ALL_PARAMS.filter(
        (d) =>
          d.id.startsWith(`${selectedModule}.`) &&
          d.unit === "boolean" &&
          !HIDDEN.has(d.id) &&
          !/\.enabled$/.test(d.id) &&
          !/\.solo$/.test(d.id),
      ),
    [selectedModule],
  );
  const enumParams = useMemo(
    () => ALL_PARAMS.filter((d) => d.id.startsWith(`${selectedModule}.`) && d.unit === "enum" && !HIDDEN.has(d.id)),
    [selectedModule],
  );

  const valueOf = (id: string): number => params[id] ?? tryGetParamDef(id)?.defaultValue ?? 0;

  // EQ curve sketch: bells/shelves from enabled band params. A visual
  // approximation (log-freq x, gain-mapped y) — the DSP itself is exact.
  const eqBands = useMemo(() => {
    const bands: { index: number; freq: number; gain: number; q: number; shape: number; enabled: boolean }[] = [];
    for (let i = 0; i < 12; i++) {
      bands.push({
        index: i,
        freq: valueOf(`eq.band${i}.freqHz`),
        gain: valueOf(`eq.band${i}.gainDb`),
        q: valueOf(`eq.band${i}.q`),
        shape: valueOf(`eq.band${i}.shape`),
        enabled: valueOf(`eq.band${i}.enabled`) >= 0.5,
      });
    }
    return bands;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const eqSelected = selectedModule === "eq";

  return (
    <div className="fxeq-panel ultina-panel" aria-label="Ultina module editor">
      {degraded && <div className="fxeq-degraded">AudioWorklet unavailable — Ultina is bypassed (1:1 signal)</div>}

      <div className="fxeq-preset-row">
        <select
          className="fxeq-preset-select"
          aria-label="Ultina preset"
          defaultValue=""
          onChange={(event) => {
            const preset = FACTORY_PRESETS.find((p) => p.name === event.target.value);
            if (preset) onApplyPreset(preset.name, preset.params);
            event.target.value = "";
          }}
        >
          <option value="">PRESET…</option>
          {FACTORY_PRESETS.map((p) => (
            <option key={p.id} value={p.name}>
              {p.module.toUpperCase()} · {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* Module chips in graph order */}
      <div className="fxeq-band-chips" role="group" aria-label="Select module">
        {DEFAULT_MODULE_ORDER.map((mod) => (
          <button
            key={mod}
            type="button"
            className={`btn btn-small${selectedModule === mod ? " active" : ""}${enabled(mod) ? " ultina-mod-on" : ""}`}
            aria-pressed={selectedModule === mod}
            title={enabled(mod) ? `${MODULE_LABELS[mod]} — enabled` : `${MODULE_LABELS[mod]} — off`}
            onClick={() => setSelectedModule(mod)}
          >
            {MODULE_LABELS[mod]}
          </button>
        ))}
      </div>

      {/* Enable toggle for the selected module */}
      <div className="ultina-module-head">
        <span className="fxeq-module-tag ultina-tag">{MODULE_LABELS[selectedModule]}</span>
        <button
          type="button"
          className={`btn btn-small${enabled(selectedModule) ? " active" : ""}`}
          aria-pressed={enabled(selectedModule)}
          onClick={() => onParam(`${selectedModule}.enabled`, enabled(selectedModule) ? 0 : 1)}
        >
          {enabled(selectedModule) ? "ON" : "OFF"}
        </button>
      </div>

      {enabled(selectedModule) && (
        <>
          {/* Enum params (shapes, modes, channel modes) as selects */}
          {enumParams.length > 0 && (
            <div className="ultina-enum-row">
              {enumParams.map((d) => {
                const value = valueOf(d.id);
                const enums = d.enumValues ?? [];
                // EQ band shapes/modes are per-band — only show global enums here.
                if (/^eq\.band\d+\./.test(d.id)) return null;
                return (
                  <label key={d.id} className="collab-field">
                    <span>{d.name.toUpperCase()}</span>
                    <select value={value} onChange={(e) => onParam(d.id, Number(e.target.value))}>
                      {enums.map((label, idx) => (
                        <option key={label} value={idx}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          )}

          {/* Boolean extras as toggles */}
          {booleanParams.length > 0 && (
            <div className="ultina-bool-row">
              {booleanParams.map((d) => {
                const on = valueOf(d.id) >= 0.5;
                return (
                  <button
                    key={d.id}
                    type="button"
                    className={`btn btn-small${on ? " active" : ""}`}
                    aria-pressed={on}
                    onClick={() => onParam(d.id, on ? 0 : 1)}
                  >
                    {d.name}
                  </button>
                );
              })}
            </div>
          )}

          {/* EQ: dedicated 12-band editor + response sketch */}
          {eqSelected ? (
            <div className="ultina-eq">
              <svg viewBox="0 0 100 44" preserveAspectRatio="none" className="ultina-eq-curve" role="img" aria-label="EQ response sketch">
                <line x1="0" y1="26" x2="100" y2="26" className="eq-response-zero" />
                {eqBands
                  .filter((b) => b.enabled && b.gain !== 0)
                  .map((b) => {
                    const cx = (Math.log(Math.max(20, b.freq) / 20) / Math.log(20000 / 20)) * 100;
                    const cy = 26 - b.gain * 1.15;
                    const rw = Math.max(3, Math.min(22, 9 / Math.max(0.35, b.q)));
                    return (
                      <ellipse
                        key={b.index}
                        cx={cx}
                        cy={cy + (cy - 26) * 0.12}
                        rx={rw}
                        ry={Math.max(1.5, Math.abs(b.gain) * 1.05)}
                        className="ultina-eq-blob"
                        opacity={b.index === selectedEqBand ? 0.95 : 0.55}
                      />
                    );
                  })}
              </svg>
              <div className="fxeq-band-chips" role="group" aria-label="Select EQ band">
                {eqBands.map((b) => (
                  <button
                    key={b.index}
                    type="button"
                    className={`btn btn-small${selectedEqBand === b.index ? " active" : ""}${b.enabled ? " ultina-mod-on" : ""}`}
                    aria-pressed={selectedEqBand === b.index}
                    onClick={() => setSelectedEqBand(b.index)}
                  >
                    {b.index + 1}
                  </button>
                ))}
              </div>
              {(() => {
                const band = eqBands[selectedEqBand];
                if (!band) return null;
                const prefix = `eq.band${band.index}`;
                const bandDefs = ALL_PARAMS.filter((d) => d.id.startsWith(`${prefix}.`) && d.unit !== "boolean" && !d.id.endsWith(".solo"));
                return (
                  <>
                    <button
                      type="button"
                      className={`btn btn-small${band.enabled ? " active" : ""}`}
                      aria-pressed={band.enabled}
                      onClick={() => onParam(`${prefix}.enabled`, band.enabled ? 0 : 1)}
                    >
                      BAND {band.index + 1} — {band.enabled ? "ON" : "OFF"}
                    </button>
                    {band.enabled &&
                      bandDefs.map((d) =>
                        d.unit === "enum" ? (
                          <label key={d.id} className="collab-field">
                            <span>{d.name.toUpperCase()}</span>
                            <select value={valueOf(d.id)} onChange={(e) => onParam(d.id, Number(e.target.value))}>
                              {(d.enumValues ?? []).map((label, idx) => (
                                <option key={label} value={idx}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <Slider
                            key={d.id}
                            compact
                            label={d.name}
                            value={valueOf(d.id)}
                            min={d.minValue}
                            max={d.maxValue}
                            defaultValue={d.defaultValue}
                            format={(v) => formatUnit(v, d.unit)}
                            onCommit={(v) => onParam(d.id, v)}
                          />
                        ),
                      )}
                  </>
                );
              })()}
            </div>
          ) : (
            /* Non-EQ modules: flat slider list from the schema */
            moduleParams.map((d) => (
              <Slider
                key={d.id}
                compact
                label={d.name}
                value={valueOf(d.id)}
                min={d.minValue}
                max={d.maxValue}
                defaultValue={d.defaultValue}
                format={(v) => formatUnit(v, d.unit)}
                onCommit={(v) => onParam(d.id, v)}
              />
            ))
          )}
        </>
      )}
    </div>
  );
}
