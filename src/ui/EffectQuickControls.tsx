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
}: {
  params: readonly ParamDef[];
  values: Record<string, number>;
  onChange: (paramId: string, value: number) => void;
}) {
  const controls = quickControlsOf(params);
  if (controls.length === 0) return null;

  return (
    <section className="fx-preset-controls" aria-label="Preset quick controls">
      <div className="fx-preset-controls-head">
        <span className="fx-preset-controls-title">PRESET CONTROLS</span>
        <span className="fx-preset-controls-hint">MIX · FEEDBACK · SYNC</span>
      </div>
      <div className="fx-preset-controls-grid">
        {controls.map(({ param, label }) => {
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
            <label key={param.id} className="fx-param-select">
              <span className="slider-label">{label}</span>
              <select
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
            <Slider
              key={param.id}
              compact
              label={label}
              value={value}
              min={param.min}
              max={param.max}
              defaultValue={param.default}
              format={param.format}
              taper={param.taper}
              onCommit={(next) => onChange(param.id, next)}
            />
          );
        })}
      </div>
    </section>
  );
}
