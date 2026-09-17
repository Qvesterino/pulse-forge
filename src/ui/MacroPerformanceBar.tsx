import { useState } from "react";
import { useDoc, useServices } from "./context";
import { setMacroValue } from "../commands/commands";
import { Slider } from "./controls";

export function formatMacroValue(value: number): string {
  const bipolar = Math.round((value * 2 - 1) * 100);
  return `${bipolar > 0 ? "+" : ""}${bipolar}%`;
}

const COLLAPSE_KEY = "pf-macros-collapsed";
const HINT = "double-click a rail to reset · centered = 0%";

/**
 * The four performance macros as an inline group on the mixer toolbar (right
 * of the batch FX actions). Mapping setup stays in MOD; this strip is
 * deliberately about playing the mix: one glance for the current value and
 * one gesture to move it. Collapsible so the toolbar row stays clean when
 * the macros are not being played.
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
      title={HINT}
    >
      <button
        type="button"
        className="mixer-performance-toggle"
        aria-expanded={!collapsed}
        title={collapsed ? `Show macro faders — ${HINT}` : `Hide macro faders — ${HINT}`}
        onClick={toggleCollapsed}
      >
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span> MACROS
      </button>
      {!collapsed && (
        <div className="mixer-performance-grid">
          {macros.map((macro) => {
            const targets =
              macro.mappings.length === 0
                ? "UNMAPPED · configure in MOD"
                : `${macro.mappings.length} target${macro.mappings.length === 1 ? "" : "s"}`;
            return (
              <div className="mixer-macro-control" key={macro.id} title={`Macro ${macro.name} — ${targets} · ${HINT}`}>
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
