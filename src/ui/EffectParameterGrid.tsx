import type { ParamDef } from "../effects/types";
import { Slider } from "./controls";
import type { EffectEditorFamily } from "./effectEditorRegistry";

export function EffectParameterGrid({
  family,
  params,
  values,
  onChange,
  paged,
}: {
  family: EffectEditorFamily;
  params: ParamDef[];
  values: Record<string, number>;
  onChange: (paramId: string, value: number) => void;
  paged: boolean;
}) {
  return (
    <div className={`fx-device-params${paged ? " is-paged" : ""}`} data-family={family}>
      {params.map((param) =>
        param.options ? (
          <label key={param.id} className="fx-param-select">
            <span className="slider-label">{param.label}</span>
            <select
              value={
                param.options.some((option) => option.value === (values[param.id] ?? param.default))
                  ? (values[param.id] ?? param.default)
                  : param.default
              }
              onChange={(event) => onChange(param.id, Number(event.target.value))}
            >
              {param.options.map((option) => (
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
            label={param.label}
            value={values[param.id] ?? param.default}
            min={param.min}
            max={param.max}
            defaultValue={param.default}
            format={param.format}
            onCommit={(value) => onChange(param.id, value)}
          />
        ),
      )}
    </div>
  );
}
