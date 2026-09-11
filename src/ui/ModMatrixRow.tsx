import { setInstrumentParam } from "../commands/commands";
import type { Command } from "../commands/types";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import type { InstrumentTrack, ProjectDocument } from "../project-model/types";
import { Slider } from "./controls";

const MOD_IDS = new Set([
  "modASrc",
  "modADst",
  "modAAmt",
  "modBSrc",
  "modBDst",
  "modBAmt",
  "modLfoRate",
]);

/** True when this param belongs to the mod matrix (filter it from generic rows). */
export const isModMatrixParam = (id: string): boolean => MOD_IDS.has(id);

const byId = <T extends { id: string }>(defs: T[], id: string): T => {
  const def = defs.find((p) => p.id === id)!;
  return def;
};

const fmtAmt = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;

/**
 * Shared mod matrix UI (MOD A/B + MOD LFO) — one look everywhere instead of
 * seven raw Inspector dropdowns. Used by the Inspector (advanced mode) and
 * the floating plugin; WavetablePanel keeps its own selectRow layout, which
 * this mirrors visually via the same wt-mod-* classes.
 *
 * Commit path is the generic setInstrumentParam command, so automation
 * lanes, clamping and undo/redo behave exactly like every other param.
 */
export function ModMatrixRow({
  track,
  doc,
  services,
}: {
  track: Extract<InstrumentTrack, { kind: "instrument" }>;
  doc: ProjectDocument;
  services: { store: { execute: (c: Command) => void } };
}) {
  const defs = INSTRUMENT_DEFS[track.instrument].params.filter((p) => isModMatrixParam(p.id));
  if (defs.length === 0) return null;
  const commit = (id: string, v: number) => services.store.execute(setInstrumentParam(doc, track.id, id, v));
  const value = (id: string) => {
    const def = byId(defs, id);
    return track.params[id] ?? def.default;
  };

  const row = (label: string, srcId: string, dstId: string, amtId: string) => {
    const src = byId(defs, srcId);
    const dst = byId(defs, dstId);
    const amt = byId(defs, amtId);
    const srcVal = src.options?.some((o) => o.value === value(srcId)) ? value(srcId) : src.default;
    const dstVal = dst.options?.some((o) => o.value === value(dstId)) ? value(dstId) : dst.default;
    return (
      <div className="wt-mod-row" role="group" aria-label={`${label} route`}>
        <span className="wt-mod-label">{label}</span>
        <select
          className="wt-mod-select"
          aria-label={`${label} source`}
          value={srcVal}
          onChange={(e) => commit(srcId, Number(e.target.value))}
        >
          {src.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="wt-mod-arrow">→</span>
        <select
          className="wt-mod-select"
          aria-label={`${label} destination`}
          value={dstVal}
          onChange={(e) => commit(dstId, Number(e.target.value))}
        >
          {dst.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Slider
          compact
          label=""
          min={amt.min}
          max={amt.max}
          value={value(amtId)}
          defaultValue={amt.default}
          format={amt.format ?? fmtAmt}
          onCommit={(v) => commit(amtId, v)}
        />
      </div>
    );
  };

  const lfo = byId(defs, "modLfoRate");

  return (
    <div className="mod-matrix" role="group" aria-label="Mod matrix">
      {row("MOD A", "modASrc", "modADst", "modAAmt")}
      {row("MOD B", "modBSrc", "modBDst", "modBAmt")}
      <Slider
        compact
        label={lfo.label}
        min={lfo.min}
        max={lfo.max}
        value={value("modLfoRate")}
        defaultValue={lfo.default}
        format={lfo.format}
        onCommit={(v) => commit("modLfoRate", v)}
      />
    </div>
  );
}
