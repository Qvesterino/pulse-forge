import type { ParamDef } from "../effects/types";
import { Slider } from "./controls";
import type { EffectEditorFamily } from "./effectEditorRegistry";

export function EffectParameterGrid({
  family,
  params,
  values,
  onChange,
  paged,
  contextHint,
}: {
  family: EffectEditorFamily;
  params: ParamDef[];
  values: Record<string, number>;
  onChange: (paramId: string, value: number) => void;
  paged: boolean;
  contextHint?: (paramId: string) => string | undefined;
}) {
  return (
    <div className={`fx-device-params${paged ? " is-paged" : ""}`} data-family={family}>
      {params.map((param) => {
        const modeHint = contextHint?.(param.id);
        const note = param.secondary?.(values);
        const options =
          param.options ??
          (param.kind === "toggle"
            ? [
                { value: 0, label: "Off" },
                { value: 1, label: "On" },
              ]
            : undefined);
        return options ? (
          <label key={param.id} className="fx-param-select" title={modeHint}>
            <span className="slider-label">{param.label}</span>
            <select
              aria-description={modeHint || undefined}
              value={
                options.some((option) => option.value === (values[param.id] ?? param.default))
                  ? (values[param.id] ?? param.default)
                  : param.default
              }
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
          // A real element, not a Fragment: .fx-device-params is a 2-column grid,
          // so a fragment would push the note into the NEXT cell instead of
          // keeping it under the knob it belongs to.
          <div key={param.id} className="fx-param-cell">
            <Slider
              compact
              label={param.label}
              hint={`${modeHint ? `${modeHint} — ` : ""}${note ? `${note} — ` : ""}Sweeps ${param.min} … ${param.max} — double-click resets to the factory default (${param.format ? param.format(param.default) : param.default})`}
              value={values[param.id] ?? param.default}
              min={param.min}
              max={param.max}
              defaultValue={param.default}
              format={param.format}
              taper={param.taper}
              onCommit={(value) => onChange(param.id, value)}
            />
            {note ? (
              // The knob value is the REQUEST; this line is what the engine can
              // actually deliver at the current rate. It renders only when the
              // two disagree, so a correct setting shows nothing at all.
              <span className="fx-param-note">{note}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
