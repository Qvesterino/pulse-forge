import type { ParamDef } from "../effects/types";
import { Slider } from "./controls";
import type { EffectEditorFamily } from "./effectEditorRegistry";

export function EffectParameterGrid({
  family,
  params,
  values,
  onChange,
  onPreview,
  onCancelPreview,
  paged,
  contextHint,
  effectiveValues,
  fallbackReason,
}: {
  family: EffectEditorFamily;
  params: ParamDef[];
  values: Record<string, number>;
  onChange: (paramId: string, value: number) => void;
  /**
   * Live drag preview (CF-03): fired for every coalesced move on a continuous
   * knob, BEFORE the single document commit on pointer-up — the knob is
   * audible during the drag the way the mixer faders and the PRISM editor
   * already are. Optional: hosts without an engine preview path stay
   * commit-only and nothing else changes.
   */
  onPreview?: (paramId: string, value: number) => void;
  /** Restore the committed value after an interrupted drag or long-press. */
  onCancelPreview?: (paramId: string) => void;
  paged: boolean;
  contextHint?: (paramId: string) => string | undefined;
  /**
   * The value IN EFFECT for the parameters an automation lane drives (audit
   * F-09). A parameter that is absent from the map has no lane: the document
   * value IS the value in effect, and the cell says nothing.
   *
   * The slider keeps showing the COMMITTED value — that is the number the
   * user set and the number a drag writes back — and the automation line
   * below it discloses what the DSP is actually playing.
   */
  effectiveValues?: Record<string, number>;
  /**
   * The reason the RUNTIME fell back to a 1:1 passthrough (audit F-18).
   *
   * A fallback runtime ignores every `setParameter` — the knob still reads
   * the document, so without this the user sees a parameter set that has no
   * effect on the audio. The banner says so AT the controls, in the same
   * words the flagship panels use.
   */
  fallbackReason?: string;
}) {
  return (
    <div className={`fx-device-params${paged ? " is-paged" : ""}`} data-family={family}>
      {fallbackReason ? (
        <div className="fxeq-degraded" role="status" data-testid="fx-params-degraded">
          {fallbackReason}
        </div>
      ) : null}
      {params.map((param) => {
        const modeHint = contextHint?.(param.id);
        const note = param.secondary?.(values);
        const effectiveValue = effectiveValues?.[param.id];
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
            {effectiveValue !== undefined ? (
              <span className="fx-param-auto" data-testid={`fx-param-auto-${param.id}`}>
                <span className="fx-auto-badge">AUTO</span>
                <span className="fx-param-auto-value">{formatParamValue(param, effectiveValue)}</span>
              </span>
            ) : null}
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
              onPreview={onPreview ? (value) => onPreview(param.id, value) : undefined}
              onCancel={onCancelPreview ? () => onCancelPreview(param.id) : undefined}
            />
            {effectiveValue !== undefined ? (
              // The knob value is the REQUEST; this line is what the DSP is
              // actually playing, because an automation lane drives the
              // parameter and the committed value no longer describes the
              // sound (audit F-09).
              <span className="fx-param-auto" data-testid={`fx-param-auto-${param.id}`}>
                <span className="fx-auto-badge">AUTO</span>
                <span className="fx-param-auto-value">{formatParamValue(param, effectiveValue)}</span>
              </span>
            ) : null}
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

/** A parameter's value in the effect's own units. */
function formatParamValue(param: ParamDef, value: number): string {
  return param.format ? param.format(value) : value.toFixed(2);
}
