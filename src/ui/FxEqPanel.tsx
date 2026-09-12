import { useEffect, useMemo, useRef, useState } from "react";
import { FXEQ_PRESETS } from "../effects/fxeq-core/core/presets";
import { buildSchema, type FxEqSchema } from "../effects/fxeq-core/core/parameterSchema";
import { blendParams } from "../effects/fxeqNode";
import type { EffectRuntime } from "../effects/types";
import { useServices } from "./context";
import { Slider } from "./controls";

const MODULE_ORDER = ["eq", "sat", "lofi", "mod", "delay", "rev", "dyn"] as const;
const MODULE_LABELS: Record<string, string> = {
  eq: "EQ",
  sat: "SAT",
  lofi: "LO-FI",
  mod: "MOD",
  delay: "DLY",
  rev: "REV",
  dyn: "DYN",
};
const MODULE_COLORS: Record<string, string> = {
  eq: "#a3e635",
  sat: "#f59e0b",
  lofi: "#22d3ee",
  mod: "#a78bfa",
  delay: "#34d399",
  rev: "#f472b6",
  dyn: "#60a5fa",
};

const AXIS_MIN_HZ = 20;
const AXIS_MAX_HZ = 20000;

function freqToX(freqHz: number, width: number): number {
  const logMin = Math.log(AXIS_MIN_HZ);
  const logMax = Math.log(AXIS_MAX_HZ);
  return ((Math.log(Math.max(AXIS_MIN_HZ, Math.min(AXIS_MAX_HZ, freqHz))) - logMin) / (logMax - logMin)) * width;
}

/**
 * FxEqPanel — the EQ-paint editor for an FXEQ Multiband instance.
 *
 * Top: preset browser (vendored VocalForge presets, one-gesture apply).
 * Middle: spectrum canvas — log-frequency axis, the crossover band regions,
 * and a "paint" strip showing WHICH effect modules are active WHERE in the
 * spectrum (the fxeq idea: effects live at frequencies, not just in a chain).
 * Click a band to edit it. Bottom: the selected band's module params,
 * generated from the vendored parameter schema (ranges + defaults included).
 */
export function FxEqPanel({
  trackId,
  fxId,
  params,
  degraded,
  onParam,
  onApplyPreset,
}: {
  trackId: string;
  fxId: string;
  params: Record<string, number>;
  degraded?: boolean;
  onParam: (fullId: string, value: number) => void;
  onApplyPreset: (presetName: string, presetParams: Record<string, number>) => void;
}) {
  const services = useServices();
  const bandCount = Math.max(2, Math.min(6, Math.round(params.bandCount ?? 6)));
  const schema: FxEqSchema = useMemo(() => buildSchema(bandCount), [bandCount]);
  const [selectedBand, setSelectedBand] = useState(1);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── plugin-level runtime surface: A/B morph slots + in-plugin undo/redo ──
  // Optional everywhere: the degraded bypass runtime exposes none of this
  // and test mocks may not implement getFxRuntime at all.
  const engineWithFx = services.engine as typeof services.engine & {
    getFxRuntime?: (trackId: string, fxId: string) => EffectRuntime | null;
    getFxMeters?: (trackId: string, fxId: string) => unknown;
    setFxMetersEnabled?: (trackId: string, fxId: string, enabled: boolean) => void;
  };
  const fxRuntime = (): EffectRuntime | null => engineWithFx.getFxRuntime?.(trackId, fxId) ?? null;
  const [morphSlots, setMorphSlots] = useState<[boolean, boolean]>([false, false]);
  const [morphT, setMorphT] = useState(0.5);
  const grRef = useRef<HTMLSpanElement | null>(null);

  const MORPH_GLIDE_SEC = 0.4;

  const captureSnapshot = (slot: 0 | 1) => {
    fxRuntime()?.setMorphSnapshot?.(slot, params);
    setMorphSlots((prev) => {
      const next: [boolean, boolean] = [prev[0], prev[1]];
      next[slot] = true;
      return next;
    });
  };

  const recallSnapshot = (slot: 0 | 1) => {
    const runtime = fxRuntime();
    const snap = runtime?.getMorphSnapshot?.(slot);
    if (!runtime || !snap) return;
    // Glide the audio via the core morph, then land the SAME state in the
    // document once the glide has finished. The commit must not race the
    // glide: a bulk param sync cancels a running morph in the core, so an
    // immediate commit would snap instead of glide.
    runtime.morphToSnapshot?.(slot, MORPH_GLIDE_SEC);
    window.setTimeout(() => onApplyPreset(slot === 0 ? "A" : "B", snap), MORPH_GLIDE_SEC * 1000 + 150);
  };

  /** Live scrub: transient audio morph, document untouched until release. */
  const scrubMorph = (t: number) => {
    setMorphT(t);
    fxRuntime()?.morphBlendSnapshots?.(0, 1, t, 0.08);
  };

  /** On release: commit the scrubbed blend so knob edits continue from
   *  what the user actually hears (no silent snap-back to the old state). */
  const commitMorph = () => {
    const runtime = fxRuntime();
    const a = runtime?.getMorphSnapshot?.(0);
    const b = runtime?.getMorphSnapshot?.(1);
    if (!a || !b) return;
    onApplyPreset("Morph", blendParams(a, b, morphT));
  };

  const undoParam = () => {
    fxRuntime()?.undoParam?.((entry) => {
      if (entry) onParam(entry.id, entry.value);
    });
  };
  const redoParam = () => {
    fxRuntime()?.redoParam?.((entry) => {
      if (entry) onParam(entry.id, entry.value);
    });
  };

  // Crossover split frequencies: crossoverFreq2..bandCount.
  const splits = useMemo(() => {
    const out: number[] = [];
    for (let i = 2; i <= bandCount; i++) {
      out.push(params[`crossoverFreq${i}`] ?? schema.defaultParams[`crossoverFreq${i}`] ?? 0);
    }
    return out;
  }, [params, bandCount, schema]);

  // Which modules are enabled per band (for the paint strip).
  const activeModules = useMemo(() => {
    const perBand: string[][] = [];
    for (let b = 1; b <= bandCount; b++) {
      const on: string[] = [];
      for (const key of MODULE_ORDER) {
        if ((params[`band${b}.${key}Enabled`] ?? 0) >= 0.5) on.push(key);
      }
      perBand.push(on);
    }
    return perBand;
  }, [params, bandCount]);

  // ── canvas ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (canvas.width = canvas.offsetWidth * dpr);
    const h = (canvas.height = canvas.offsetHeight * dpr);
    ctx2d.clearRect(0, 0, w, h);

    // Band regions: alternating fills from splits.
    const edges = [AXIS_MIN_HZ, ...splits, AXIS_MAX_HZ];
    for (let b = 0; b < edges.length - 1; b++) {
      const x0 = freqToX(edges[b], w);
      const x1 = freqToX(edges[b + 1], w);
      ctx2d.fillStyle = b === selectedBand - 1 ? "rgba(245, 158, 11, 0.10)" : b % 2 === 0 ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.16)";
      ctx2d.fillRect(x0, 0, x1 - x0, h);
      // Band number label.
      ctx2d.fillStyle = b === selectedBand - 1 ? "#f59e0b" : "#71717a";
      ctx2d.font = `600 ${10 * dpr}px system-ui, sans-serif`;
      ctx2d.fillText(`B${b + 1}`, x0 + 4 * dpr, 12 * dpr);
    }

    // Split lines + Hz labels.
    ctx2d.font = `${9 * dpr}px ui-monospace, monospace`;
    for (const freq of splits) {
      const x = freqToX(freq, w);
      ctx2d.fillStyle = "#52525b";
      ctx2d.fillRect(x - dpr, 0, 2 * dpr, h);
      ctx2d.fillStyle = "#71717a";
      const label = freq >= 1000 ? `${(freq / 1000).toFixed(1)}k` : `${Math.round(freq)}`;
      ctx2d.fillText(label, x + 3 * dpr, h - 4 * dpr);
    }

    // Module paint strip: colored module tags inside their band region.
    const stripY = h - 22 * dpr;
    for (let b = 0; b < bandCount; b++) {
      const x0 = freqToX(edges[b], w);
      const x1 = freqToX(edges[b + 1], w);
      let x = x0 + 4 * dpr;
      for (const key of activeModules[b]) {
        const label = MODULE_LABELS[key];
        ctx2d.font = `700 ${8 * dpr}px system-ui, sans-serif`;
        const tw = ctx2d.measureText(label).width;
        if (x + tw + 6 * dpr > x1) break; // band too narrow for more tags
        ctx2d.fillStyle = MODULE_COLORS[key];
        ctx2d.globalAlpha = 0.85;
        ctx2d.fillRect(x, stripY, tw + 5 * dpr, 11 * dpr);
        ctx2d.globalAlpha = 1;
        ctx2d.fillStyle = "#0e0f12";
        ctx2d.fillText(label, x + 2.5 * dpr, stripY + 8.5 * dpr);
        x += tw + 8 * dpr;
      }
    }

    // Frequency gridlines at decades.
    for (const freq of [50, 100, 500, 1000, 5000, 10000]) {
      const x = freqToX(freq, w);
      ctx2d.fillStyle = "rgba(255,255,255,0.05)";
      ctx2d.fillRect(x, 0, dpr, h);
    }
  }, [splits, bandCount, activeModules, selectedBand]);

  // Click canvas → select band by frequency.
  const selectBandAt = (clientX: number, currentTarget: HTMLElement) => {
    const rect = currentTarget.getBoundingClientRect();
    const freq = (function back() {
      const x = (clientX - rect.left) / rect.width;
      const logMin = Math.log(AXIS_MIN_HZ);
      const logMax = Math.log(AXIS_MAX_HZ);
      return Math.exp(logMin + x * (logMax - logMin));
    })();
    const edges = [AXIS_MIN_HZ, ...splits, AXIS_MAX_HZ];
    for (let b = 0; b < edges.length - 1; b++) {
      if (freq >= edges[b] && freq < edges[b + 1]) {
        setSelectedBand(b + 1);
        return;
      }
    }
  };

  // ── LIVE BAND PEAKS: poll the worklet snapshot, draw on canvas, no re-renders ──
  // Mirrors the UltinaPanel meter loop: the engine gates the worklet's
  // metering path on mount/unmount, so a closed FXEQ panel costs zero
  // band-peak traffic on the audio thread's message port.
  const peaksCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const edgesRef = useRef<number[]>([AXIS_MIN_HZ, AXIS_MAX_HZ]);
  edgesRef.current = [AXIS_MIN_HZ, ...splits, AXIS_MAX_HZ];

  useEffect(() => {
    engineWithFx.setFxMetersEnabled?.(trackId, fxId, true);

    const drawPeaks = () => {
      const canvas = peaksCanvasRef.current;
      if (!canvas) return;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
      const dpr = window.devicePixelRatio || 1;
      const w = (canvas.width = canvas.offsetWidth * dpr);
      const h = (canvas.height = canvas.offsetHeight * dpr);
      ctx2d.clearRect(0, 0, w, h);
      const edges = edgesRef.current;
      const peaks = peaksRef.current;
      for (let b = 0; b < edges.length - 1; b++) {
        const x0 = freqToX(edges[b], w);
        const x1 = freqToX(edges[b + 1], w);
        ctx2d.fillStyle = "rgba(255,255,255,0.04)";
        ctx2d.fillRect(x0, 0, x1 - x0, h);
        const peak = peaks && b < peaks.length ? peaks[b] : 0;
        if (peak > 1e-6) {
          const db = 20 * Math.log10(peak);
          const norm = Math.max(0, Math.min(1, (db + 60) / 60)); // −60 dB … 0 dB
          const barH = Math.max(2 * dpr, norm * h);
          ctx2d.fillStyle = db > -3 ? "#ef4444" : db > -12 ? "#f59e0b" : "#4ade80";
          ctx2d.fillRect(x0 + dpr, h - barH, x1 - x0 - 2 * dpr, barH);
        }
      }
    };

    drawPeaks();
    const id = setInterval(() => {
      const meters = engineWithFx.getFxMeters?.(trackId, fxId) as
        | { bandPeaks?: Float32Array; gainReductionDb?: number }
        | null
        | undefined;
      peaksRef.current = meters?.bandPeaks ?? null;
      // GR readout rides the same snapshot (no React state — direct DOM
      // text update, mirroring the canvas draw loop).
      if (grRef.current) {
        const gr = meters?.gainReductionDb ?? 0;
        grRef.current.textContent = gr > 0.05 ? `GR −${gr.toFixed(1)} dB` : "";
      }
      drawPeaks();
    }, 66);
    return () => {
      engineWithFx.setFxMetersEnabled?.(trackId, fxId, false);
      clearInterval(id);
    };
  }, [trackId, fxId, services]);

  // Selected band's module params, grouped per module (from the vendored schema).
  const bandModuleDefs = useMemo(() => {
    const groups: Record<string, { id: string; name: string; min: number; max: number; default: number; unit?: string }[]> = {};
    for (const def of schema.defs) {
      const route = schema.routes.get(def.id);
      if (!route || route.band !== selectedBand || route.kind !== "module") continue;
      (groups[route.moduleKey!] ??= []).push({
        id: def.id,
        name: def.name.replace(/^B\d+ /, ""),
        min: def.minValue,
        max: def.maxValue,
        default: def.defaultValue,
        unit: def.unit,
      });
    }
    return groups;
  }, [schema, selectedBand]);

  const valueOf = (id: string): number => params[id] ?? schema.defaultParams[id] ?? 0;

  return (
    <div className="fxeq-panel" aria-label="PRISM multiband editor">
      {degraded && (
        <div className="fxeq-degraded">AudioWorklet unavailable — PRISM is bypassed (1:1 signal)</div>
      )}
      <div className="fxeq-preset-row">
        <select
          className="fxeq-preset-select"
          aria-label="PRISM preset"
          defaultValue=""
          onChange={(event) => {
            const preset = FXEQ_PRESETS.find((p) => p.name === event.target.value);
            if (preset) onApplyPreset(preset.name, preset.params);
            event.target.value = "";
          }}
        >
          <option value="">PRESET…</option>
          {FXEQ_PRESETS.map((p) => (
            <option key={p.id} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="fxeq-band-chips" role="group" aria-label="Select band">
          {Array.from({ length: bandCount }, (_, i) => (
            <button
              key={i}
              type="button"
              className={`btn btn-small${selectedBand === i + 1 ? " active" : ""}`}
              aria-pressed={selectedBand === i + 1}
              onClick={() => setSelectedBand(i + 1)}
            >
              B{i + 1}
            </button>
          ))}
        </div>
      </div>

      <div className="fxeq-morph-row" role="group" aria-label="PRISM A/B morph">
        <button
          type="button"
          className="btn btn-small"
          title="Capture the current state into morph slot A"
          onClick={() => captureSnapshot(0)}
        >
          SET A
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Capture the current state into morph slot B"
          onClick={() => captureSnapshot(1)}
        >
          SET B
        </button>
        <button
          type="button"
          className={`btn btn-small${morphSlots[0] ? "" : " fxeq-module-off"}`}
          title={morphSlots[0] ? "Glide to A" : "Capture A first (SET A)"}
          disabled={!morphSlots[0]}
          onClick={() => recallSnapshot(0)}
        >
          A
        </button>
        <button
          type="button"
          className={`btn btn-small${morphSlots[1] ? "" : " fxeq-module-off"}`}
          title={morphSlots[1] ? "Glide to B" : "Capture B first (SET B)"}
          disabled={!morphSlots[1]}
          onClick={() => recallSnapshot(1)}
        >
          B
        </button>
        <input
          type="range"
          className="fxeq-morph-slider"
          aria-label="PRISM morph A to B"
          title="Scrub between A and B — the blend lands in the document on release"
          min={0}
          max={1}
          step={0.01}
          value={morphT}
          disabled={!morphSlots[0] || !morphSlots[1]}
          onChange={(e) => scrubMorph(Number(e.target.value))}
          onPointerUp={commitMorph}
          onKeyUp={commitMorph}
        />
        <button
          type="button"
          className="btn btn-small"
          aria-label="Undo PRISM parameter edit"
          title="Undo the last live parameter tweak (plugin history)"
          onClick={undoParam}
        >
          ↶
        </button>
        <button
          type="button"
          className="btn btn-small"
          aria-label="Redo PRISM parameter edit"
          title="Redo an undone parameter tweak (plugin history)"
          onClick={redoParam}
        >
          ↷
        </button>
      </div>

      <div
        className="fxeq-canvas-wrap"
        role="img"
        aria-label="PRISM band map"
        onClick={(e) => selectBandAt(e.clientX, e.currentTarget)}
      >
        <canvas ref={canvasRef} className="fxeq-canvas" />
      </div>

      <div
        className="fxeq-peaks-wrap"
        role="img"
        aria-label="PRISM band peaks"
        title="Live per-band peak level — which band is playing hot right now"
      >
        <canvas ref={peaksCanvasRef} className="fxeq-peaks-canvas" />
        <span ref={grRef} className="fxeq-gr" aria-label="PRISM gain reduction" />
      </div>

      {/* Band scalars: solo / mute / gain — hear and level just this band. */}
      <div className="fxeq-band-scalars">
        <button
          type="button"
          className={`btn btn-small${valueOf(`band${selectedBand}.solo`) >= 0.5 ? " active" : ""}`}
          aria-pressed={valueOf(`band${selectedBand}.solo`) >= 0.5}
          title="Solo — hear ONLY this frequency band through the whole PRISM engine"
          onClick={() => onParam(`band${selectedBand}.solo`, valueOf(`band${selectedBand}.solo`) >= 0.5 ? 0 : 1)}
        >
          SOLO
        </button>
        <button
          type="button"
          className={`btn btn-small${valueOf(`band${selectedBand}.mute`) >= 0.5 ? " active" : ""}`}
          aria-pressed={valueOf(`band${selectedBand}.mute`) >= 0.5}
          title="Mute — silence this band"
          onClick={() => onParam(`band${selectedBand}.mute`, valueOf(`band${selectedBand}.mute`) >= 0.5 ? 0 : 1)}
        >
          MUTE
        </button>
        <div className="fxeq-band-gain">
          <Slider
            compact
            label={`B${selectedBand} GAIN`}
            value={valueOf(`band${selectedBand}.gainDb`)}
            min={-48}
            max={12}
            defaultValue={0}
            format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`}
            onCommit={(v) => onParam(`band${selectedBand}.gainDb`, v)}
          />
        </div>
      </div>

      {/* Band-level dynamic EQ (spectral ducking). EXT SC drives the band's
          envelope from the sidechain feed attached by the engine via track
          routing; with it off the band tracks itself. */}
      <div className="fxeq-band-dyn" role="group" aria-label="PRISM dynamic EQ">
        <span className="fxeq-module-tag" style={{ background: MODULE_COLORS.dyn }}>
          DYN EQ
        </span>
        <button
          type="button"
          className={`btn btn-small${valueOf(`band${selectedBand}.dynEnable`) >= 0.5 ? " active" : ""}`}
          aria-pressed={valueOf(`band${selectedBand}.dynEnable`) >= 0.5}
          title="Dynamic EQ — this band ducks itself when it exceeds the threshold"
          onClick={() =>
            onParam(`band${selectedBand}.dynEnable`, valueOf(`band${selectedBand}.dynEnable`) >= 0.5 ? 0 : 1)
          }
        >
          DYN
        </button>
        <button
          type="button"
          className={`btn btn-small${valueOf(`band${selectedBand}.sidechainMode`) >= 0.5 ? " active" : ""}`}
          aria-pressed={valueOf(`band${selectedBand}.sidechainMode`) >= 0.5}
          title="Sidechain — drive this band's dynamic EQ from the external sidechain feed instead of the band itself"
          onClick={() =>
            onParam(
              `band${selectedBand}.sidechainMode`,
              valueOf(`band${selectedBand}.sidechainMode`) >= 0.5 ? 0 : 1,
            )
          }
        >
          EXT SC
        </button>
        <Slider
          compact
          label="DYN THRESH"
          value={valueOf(`band${selectedBand}.dynThresholdDb`)}
          min={-60}
          max={0}
          defaultValue={-20}
          format={(v) => `${v.toFixed(1)} dB`}
          onCommit={(v) => onParam(`band${selectedBand}.dynThresholdDb`, v)}
        />
        <Slider
          compact
          label="DYN RANGE"
          value={valueOf(`band${selectedBand}.dynRangeDb`)}
          min={-24}
          max={0}
          defaultValue={-6}
          format={(v) => `${v.toFixed(1)} dB`}
          onCommit={(v) => onParam(`band${selectedBand}.dynRangeDb`, v)}
        />
        <Slider
          compact
          label="DYN ATK"
          value={valueOf(`band${selectedBand}.dynAttackMs`)}
          min={0.1}
          max={100}
          defaultValue={10}
          format={(v) => `${v.toFixed(1)} ms`}
          onCommit={(v) => onParam(`band${selectedBand}.dynAttackMs`, v)}
        />
        <Slider
          compact
          label="DYN REL"
          value={valueOf(`band${selectedBand}.dynReleaseMs`)}
          min={10}
          max={1000}
          defaultValue={150}
          format={(v) => `${v.toFixed(0)} ms`}
          onCommit={(v) => onParam(`band${selectedBand}.dynReleaseMs`, v)}
        />
      </div>

      {MODULE_ORDER.map((key) => {
        const defs = bandModuleDefs[key];
        if (!defs || defs.length === 0) return null;
        const enabledId = `band${selectedBand}.${key}Enabled`;
        const enabled = valueOf(enabledId) >= 0.5;
        return (
          <div key={key} className={`fxeq-module${enabled ? "" : " fxeq-module-off"}`}>
            <div className="fxeq-module-head">
              <span className="fxeq-module-tag" style={{ background: MODULE_COLORS[key] }}>
                {MODULE_LABELS[key]}
              </span>
              <button
                type="button"
                className={`btn btn-small${enabled ? " active" : ""}`}
                aria-pressed={enabled}
                onClick={() => onParam(enabledId, enabled ? 0 : 1)}
              >
                {enabled ? "ON" : "OFF"}
              </button>
            </div>
            {enabled &&
              defs
                .filter((d) => !d.id.endsWith("Enabled"))
                .map((d) => (
                  <Slider
                    key={d.id}
                    compact
                    label={d.name}
                    value={valueOf(d.id)}
                    min={d.min}
                    max={d.max}
                    defaultValue={d.default}
                    format={d.unit === "dB" ? (v) => `${v.toFixed(1)} dB` : d.unit === "%" ? (v) => `${v.toFixed(0)}%` : d.unit === "ms" ? (v) => `${v.toFixed(0)} ms` : d.unit === "Hz" ? (v) => `${v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0)} Hz` : (v) => v.toFixed(2)}
                    onCommit={(v) => onParam(d.id, v)}
                  />
                ))}
          </div>
        );
      })}
    </div>
  );
}
