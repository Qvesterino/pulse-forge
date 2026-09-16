import { useState } from "react";
import { useDoc, useServices } from "./context";
import { setMacroValue } from "../commands/commands";
import { Slider } from "./controls";

export function formatMacroValue(value: number): string {
  const bipolar = Math.round((value * 2 - 1) * 100);
  return `${bipolar > 0 ? "+" : ""}${bipolar}%`;
}

const COLLAPSE_KEY = "pf-macros-collapsed";

/**
 * A compact, mixer-friendly surface for the four performance macros.
 * Mapping setup stays in MOD; this strip is deliberately about playing the
 * mix: one glance for the current value and one gesture to move it.
 * Collapsible so the fader bank can take the whole dock when playing.
 */
export function MacroPerformanceBar() {
  const services = useServices();
  const doc = useDoc();
  const macros = doc.macros.slice(0, 4);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });

  if (macros.length === 0) return null;

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, v ? "0" : "1");
      } catch {
        /* private mode — session-only collapse */
      }
      return !v;
    });
  };

  return (
    <div
      className={"mixer-performance-bar" + (collapsed ? " collapsed" : "")}
      role="group"
      aria-label="Performance macros"
    >
      <div className="mixer-performance-head">
        <button
          type="button"
          className="mixer-performance-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? "Show macro faders" : "Hide macro faders"}
          onClick={toggleCollapsed}
        >
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span> MACROS
        </button>
        <span className="mixer-performance-hint">double-click a rail to reset · centered = 0%</span>
      </div>
      {!collapsed && (
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
      )}
    </div>
  );
}
