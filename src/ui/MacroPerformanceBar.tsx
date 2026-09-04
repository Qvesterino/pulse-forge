import { useDoc, useServices } from "./context";
import { setMacroValue } from "../commands/commands";
import { Slider } from "./controls";

export function formatMacroValue(value: number): string {
  const bipolar = Math.round((value * 2 - 1) * 100);
  return `${bipolar > 0 ? "+" : ""}${bipolar}%`;
}

/**
 * A compact, mixer-friendly surface for the four performance macros.
 * Mapping setup stays in MOD; this strip is deliberately about playing the
 * mix: one glance for the current value and one gesture to move it.
 */
export function MacroPerformanceBar() {
  const services = useServices();
  const doc = useDoc();
  const macros = doc.macros.slice(0, 4);

  if (macros.length === 0) return null;

  return (
    <div className="mixer-performance-bar" role="group" aria-label="Performance macros">
      <div className="mixer-performance-head">
        <span className="mixer-performance-title">MACROS</span>
        <span className="mixer-performance-hint">double-click a rail to reset · centered = 0%</span>
      </div>
      <div className="mixer-performance-grid">
        {macros.map((macro) => (
          <div className="mixer-macro-control" key={macro.id}>
            <div className="mixer-macro-head">
              <span className="mixer-macro-name">{macro.name}</span>
              <span className="mixer-macro-value">{formatMacroValue(macro.value)}</span>
            </div>
            <Slider
              compact
              label={`Macro ${macro.name}`}
              value={macro.value}
              min={0}
              max={1}
              defaultValue={0.5}
              format={formatMacroValue}
              onCommit={(value) => services.store.execute(setMacroValue(services.store.doc, macro.id, value))}
            />
            <span className={`mixer-macro-targets${macro.mappings.length === 0 ? " empty" : ""}`}>
              {macro.mappings.length === 0
                ? "UNMAPPED · configure in MOD"
                : `${macro.mappings.length} target${macro.mappings.length === 1 ? "" : "s"}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
