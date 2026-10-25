import type { ParamDef } from "../effects/types";
import { Slider } from "./controls";

type QuickControl = {
  param: ParamDef;
  label: "MIX" | "FEEDBACK" | "SYNC";
};

const QUICK_PARAM_IDS: ReadonlyArray<{ label: QuickControl["label"]; ids: readonly string[] }> = [
  { label: "MIX", ids: ["mix", "global.mix", "global.dryWet"] },
  { label: "FEEDBACK", ids: ["feedback"] },
  { label: "SYNC", ids: ["sync"] },
];

/** Keep the dock filter and the rendered control list on the same contract. */
export function isEffectQuickControlParam(param: ParamDef): boolean {
  return (
    ["mix", "global.mix", "global.dryWet", "feedback"].includes(param.id) || (param.id === "sync" && !!param.options)
  );
}

function quickControlsOf(params: readonly ParamDef[]): QuickControl[] {
  return QUICK_PARAM_IDS.flatMap(({ label, ids }) => {
    const param = ids.map((id) => params.find((candidate) => candidate.id === id)).find((candidate) => !!candidate);
    if (!param) return [];
    // SYNC is intentionally only promoted when the definition carries the
    // tempo division menu. Effects without musical sync keep their RATE page.
    if (label === "SYNC" && !param.options) return [];
    return [{ param, label }];
  });
}

export function EffectQuickControls({
  params,
  values,
  onChange,
  contextHint,
  effectiveValues,
}: {
  params: readonly ParamDef[];
  values: Record<string, number>;
  onChange: (paramId: string, value: number) => void;
  contextHint?: (paramId: string) => string | undefined;
  /**
   * The value IN EFFECT for the parameters an automation lane drives (audit
   * F-09). A parameter absent from the map has no lane — the document value
   * IS the value in effect, and nothing is disclosed.
   */
  effectiveValues?: Record<string, number>;
}) {
  const controls = quickControlsOf(params);
  if (controls.length === 0) return null;

  return (
    <section
      className="fx-preset-controls"
      aria-label={`Preset quick controls: ${controls.map(({ label }) => label).join(", ")}`}
    >
      <div className="fx-preset-controls-head">
        <span className="fx-preset-controls-title">PRESET CONTROLS</span>
        <span className="fx-preset-controls-hint">{controls.map(({ label }) => label).join(" · ")}</span>
      </div>
      <div className="fx-preset-controls-grid">
        {controls.map(({ param, label }) => {
          const modeHint = contextHint?.(param.id);
          const effectiveValue = effectiveValues?.[param.id];
          const options =
            param.options ??
            (param.kind === "toggle"
              ? [
                  { value: 0, label: "OFF" },
                  { value: 1, label: "ON" },
                ]
              : undefined);
          const value = values[param.id] ?? param.default;
          return options ? (
            <label key={param.id} className="fx-param-select" title={modeHint}>
              <span className="slider-label">{label}</span>
              {effectiveValue !== undefined ? (
                <span className="fx-param-auto" data-testid={`fx-param-auto-${param.id}`}>
                  <span className="fx-auto-badge">AUTO</span>
                  <span className="fx-param-auto-value">{formatParamValue(param, effectiveValue)}</span>
                </span>
              ) : null}
              <select
                aria-description={modeHint || undefined}
                aria-label={label}
                value={options.some((option) => option.value === value) ? value : param.default}
                onChange={(event) => onChange(param.id, Number(event.target.value))}
              >
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div key={param.id} className="fx-quick-control">
              <Slider
                compact
                label={label}
                hint={modeHint}
                value={value}
                min={param.min}
                max={param.max}
                defaultValue={param.default}
                format={param.format}
                taper={param.taper}
                onCommit={(next) => onChange(param.id, next)}
              />
              {effectiveValue !== undefined ? (
                <span className="fx-param-auto" data-testid={`fx-param-auto-${param.id}`}>
                  <span className="fx-auto-badge">AUTO</span>
                  <span className="fx-param-auto-value">{formatParamValue(param, effectiveValue)}</span>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A parameter's value in the effect's own units. */
function formatParamValue(param: ParamDef, value: number): string {
  return param.format ? param.format(value) : value.toFixed(2);
}
