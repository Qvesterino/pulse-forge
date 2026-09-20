import { useEffect, useMemo, useRef, useState } from "react";
import {
  ANALYSIS_ADAPTIVE_LEVEL_ID,
  ANALYSIS_BODY_SENSITIVITY_ID,
  ANALYSIS_TEXTURE_SENSITIVITY_ID,
  ANALYSIS_TRANSIENT_SENSITIVITY_ID,
  CHAR_ASYM_ID,
  CHAR_CLIP_ID,
  CHAR_DRIVE_ID,
  CHAR_ENABLED_ID,
  CHAR_TONE_ID,
  DYN_ATTACK_MS_ID,
  DYN_DETECTOR_BLEND_ID,
  DYN_KNEE_DB_ID,
  DYN_MAKEUP_AUTO_ID,
  DYN_MAKEUP_DB_ID,
  DYN_RATIO_ID,
  DYN_RELEASE_MS_ID,
  DYN_SIDECHAIN_HPF_HZ_ID,
  DYN_THRESHOLD_DB_ID,
  GLOBAL_DELTA_ID,
  GLOBAL_INPUT_GAIN_DB_ID,
  GLOBAL_MIX_ID,
  GLOBAL_OUTPUT_GAIN_DB_ID,
  MACRO_BODY_ID,
  MACRO_MOTION_ID,
  MACRO_PUNCH_ID,
  MACRO_PRESSURE_ID,
  MACRO_SPACE_ID,
  MACRO_TEXTURE_ID,
  MOTION_CENTER_HZ_ID,
  MOTION_DEPTH_ID,
  MOTION_ENABLED_ID,
  MOTION_FEEDBACK_ID,
  MOTION_RATE_HZ_ID,
  ROUTE_COUNT,
  SPACE_DAMPING_ID,
  SPACE_DECAY_S_ID,
  SPACE_DIFFUSION_ID,
  SPACE_DUCK_ID,
  SPACE_ENABLED_ID,
  SPACE_PREDELAY_MS_ID,
  SPACE_SEND_ID,
  SPACE_WIDTH_ID,
  routeParamId,
} from "../effects/morph-dynamics-core/contracts/parameterIds";
import { MOD_DESTINATIONS, MOD_SOURCES } from "../effects/morph-dynamics-core/contracts/modulation";
import type { MorphMeters } from "../effects/morph-dynamics-core/contracts/meters";
import { clampParam } from "../effects/morph-dynamics-core/contracts/parameterSchema";
import { FACTORY_PRESETS, applyMorphPreset } from "../effects/morph-dynamics-core/presets/factoryPresets";
import {
  MorphPresetRepository,
  MORPH_PRESET_SCHEMA_VERSION,
  type MorphPresetEntry,
} from "../persistence/MorphPresetRepository";
import { useServices } from "./context";
import { Slider } from "./controls";

/**
 * MorphDynamicsPanel — the product surface for MORPH DYNAMICS.
 *
 * Progressive disclosure (INTERACTION_MODEL.md): the six macros + live
 * reactive meters are always visible; dynamics/stage detail and the
 * modulation matrix live behind collapsible sections. Every reactive
 * relationship is observable — T/B/T meters, GR, per-route activity.
 */

const PRESET_CATEGORIES: { key: string; label: string }[] = [
  { key: "vocal", label: "VOCAL" },
  { key: "drums", label: "DRUMS" },
  { key: "bass", label: "BASS" },
  { key: "synth", label: "SYNTH" },
  { key: "instrument", label: "INSTRUMENT" },
  { key: "bus", label: "BUS" },
  { key: "creative", label: "CREATIVE" },
];

const SOURCE_OPTIONS = MOD_SOURCES.map((label, value) => ({ value, label }));
const DEST_OPTIONS = MOD_DESTINATIONS.map((d, value) => ({ value, label: d.label }));

function dbFmt(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
}
function pctFmt(v: number): string {
  return `${Math.round(v)}%`;
}
function msFmt(v: number): string {
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;
}
function hzFmt(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`;
}
function ratioFmt(v: number): string {
  return `${v.toFixed(2)}:1`;
}
function secFmt(v: number): string {
  return `${v.toFixed(2)} s`;
}

export function MorphDynamicsPanel({
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
  onParam: (paramId: string, value: number) => void;
  onApplyPreset: (presetName: string, presetParams: Record<string, number>) => void;
}) {
  const services = useServices();
  const [showEngine, setShowEngine] = useState(false);
  const [showMatrix, setShowMatrix] = useState(false);
  // ── USER PRESETS: named snapshots of the full parameter map ──────────
  const [userPresets, setUserPresets] = useState<MorphPresetEntry[]>([]);
  const [selectedUserPresetId, setSelectedUserPresetId] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void new MorphPresetRepository()
      .list()
      .then((presets) => {
        if (!cancelled) setUserPresets(presets);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const valueOf = (id: string): number => params[id] ?? 0;

  // Live drag preview: fire-and-forget write to the device runtime; the
  // document write still happens once on commit (undoable command).
  const previewParam = (paramId: string, value: number) => {
    // The worklet port trusts the host — clamp here, not just in the command.
    services.engine.previewFxParam?.(trackId, fxId, paramId, clampParam(paramId, value));
  };

  const saveUserPreset = async () => {
    const name = (window.prompt("User preset name:", "") ?? "").trim();
    if (!name) return;
    const existing = userPresets.find((p) => p.name === name);
    if (existing && !window.confirm(`Preset "${name}" already exists — overwrite it?`)) return;
    try {
      const repo = new MorphPresetRepository();
      await repo.save({
        id: existing?.id ?? `morph-preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        params: { ...params },
        createdAt: new Date().toISOString(),
        schemaVersion: MORPH_PRESET_SCHEMA_VERSION,
      });
      setUserPresets(await repo.list());
      setPresetError(null);
    } catch (err) {
      console.error("[MorphDynamicsPanel] preset save failed:", err);
      setPresetError(err instanceof Error ? err.message : "Preset storage failed");
    }
  };

  const renameUserPreset = async () => {
    const current = userPresets.find((p) => p.id === selectedUserPresetId);
    if (!current) return;
    const name = (window.prompt("Rename preset:", current.name) ?? "").trim();
    if (!name || name === current.name) return;
    try {
      const repo = new MorphPresetRepository();
      await repo.save({ ...current, name });
      setUserPresets(await repo.list());
      setPresetError(null);
    } catch (err) {
      console.error("[MorphDynamicsPanel] preset rename failed:", err);
      setPresetError(err instanceof Error ? err.message : "Preset storage failed");
    }
  };

  const deleteUserPreset = async () => {
    const current = userPresets.find((p) => p.id === selectedUserPresetId);
    if (!current) return;
    if (!window.confirm(`Delete preset "${current.name}"?`)) return;
    try {
      const repo = new MorphPresetRepository();
      await repo.remove(current.id);
      setSelectedUserPresetId(null);
      setUserPresets(await repo.list());
      setPresetError(null);
    } catch (err) {
      console.error("[MorphDynamicsPanel] preset delete failed:", err);
      setPresetError(err instanceof Error ? err.message : "Preset storage failed");
    }
  };

  // ── Live meters: polled while mounted; engine gates the worklet cost ──
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const metersRef = useRef<MorphMeters | null>(null);

  useEffect(() => {
    const engineWithMeters = services.engine as typeof services.engine & {
      getFxMeters?: (trackId: string, fxId: string) => unknown;
      setFxMetersEnabled?: (trackId: string, fxId: string, enabled: boolean) => void;
    };
    engineWithMeters.setFxMetersEnabled?.(trackId, fxId, true);
    const id = window.setInterval(() => {
      metersRef.current = (engineWithMeters.getFxMeters?.(trackId, fxId) ?? null) as MorphMeters | null;
      drawMeters();
    }, 66);
    return () => {
      engineWithMeters.setFxMetersEnabled?.(trackId, fxId, false);
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, fxId, services]);

  const drawMeters = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const m = metersRef.current;
    ctx.clearRect(0, 0, w, h);

    // Left column: TRANSIENT / BODY / TEXTURE activity bars (the engine's
    // mental model, made visible — see INTERACTION_MODEL §13).
    const bars: { label: string; v: number }[] = [
      { label: "TRN", v: m?.transient ?? 0 },
      { label: "BDY", v: m?.body ?? 0 },
      { label: "TXT", v: m?.texture ?? 0 },
    ];
    const barH = 12;
    const gap = 6;
    const labelW = 34;
    ctx.font = "9px ui-monospace, monospace";
    for (let i = 0; i < bars.length; i++) {
      const y = 8 + i * (barH + gap);
      ctx.fillStyle = "#3a3f4b";
      ctx.fillRect(labelW, y, w - labelW - 46, barH);
      ctx.fillStyle = ["#e8b04b", "#d97757", "#7aa2f7"][i];
      ctx.fillRect(labelW, y, (w - labelW - 46) * Math.min(1, bars[i].v), barH);
      ctx.fillStyle = "#9aa0aa";
      ctx.fillText(bars[i].label, 4, y + barH - 3);
    }

    // Right column: gain reduction (downward fill) + pressure activity.
    const grX = w - 40;
    ctx.fillStyle = "#3a3f4b";
    ctx.fillRect(grX, 8, 14, 3 * (barH + gap) - gap);
    const grNorm = Math.min(1, (m?.gainReductionDb ?? 0) / 24);
    ctx.fillStyle = "#c65b5b";
    ctx.fillRect(grX, 8, 14, (3 * (barH + gap) - gap) * grNorm);
    ctx.fillStyle = "#9aa0aa";
    ctx.fillText("GR", grX + 1, 8 + 3 * (barH + gap) - gap + 9);
    const p = m?.pressureActive ?? 0;
    ctx.fillStyle = "#5f6470";
    ctx.fillRect(grX + 20, 8, 6, (3 * (barH + gap) - gap) * (1 - p));
    ctx.fillStyle = "#e8b04b";
    ctx.fillRect(grX + 20, 8 + (3 * (barH + gap) - gap) * (1 - p), 6, (3 * (barH + gap) - gap) * p);

    // AGC readout (top strip, right-aligned): how much the adaptive level
    // reference is currently compensating. Docs principle 7 — the analysis
    // engine must be observable, not a black box.
    const boost = m?.agcBoostDb ?? 0;
    if (Math.abs(boost) > 0.5) {
      ctx.fillStyle = boost > 0 ? "#7dc98f" : "#c6a35b";
      ctx.fillText(`AGC ${boost > 0 ? "+" : ""}${boost.toFixed(0)} dB`, w - 96, 12);
    }
  };

  const groupedPresets = useMemo(() => {
    return PRESET_CATEGORIES.map((cat) => ({
      ...cat,
      presets: FACTORY_PRESETS.filter((p) => p.category === cat.key),
    })).filter((g) => g.presets.length > 0);
  }, []);

  const macro = (id: string, label: string, min: number, bipolar = false) => (
    <div className="morph-macro" key={id}>
      <Slider
        compact
        label={label}
        value={valueOf(id)}
        min={min}
        max={100}
        defaultValue={bipolar ? 0 : id === MACRO_PRESSURE_ID ? 35 : 50}
        format={pctFmt}
        onCommit={(v) => onParam(id, v)}
        onPreview={(v) => previewParam(id, v)}
      />
    </div>
  );

  const engineSlider = (
    id: string,
    label: string,
    min: number,
    max: number,
    format: (v: number) => string,
    taper?: "linear" | "log",
    defaultValue?: number,
  ) => (
    <Slider
      compact
      label={label}
      value={valueOf(id)}
      min={min}
      max={max}
      defaultValue={defaultValue ?? (min + max) / 2}
      format={format}
      taper={taper}
      onCommit={(v) => onParam(id, v)}
      onPreview={(v) => previewParam(id, v)}
    />
  );

  const stageToggle = (id: string, label: string) => (
    <button
      type="button"
      className={`morph-stage-toggle ${valueOf(id) >= 0.5 ? "on" : ""}`}
      onClick={() => onParam(id, valueOf(id) >= 0.5 ? 0 : 1)}
    >
      {label} {valueOf(id) >= 0.5 ? "ON" : "OFF"}
    </button>
  );

  return (
    <div className="morph-panel" data-degraded={degraded ? "true" : undefined}>
      <div className="morph-header">
        <select
          className="morph-preset-select"
          aria-label="MORPH DYNAMICS preset"
          defaultValue=""
          onChange={(e) => {
            // User presets first (their ids live in a different namespace
            // than factory ids, but the check is explicit for clarity).
            const user = userPresets.find((p) => p.id === e.target.value);
            if (user) {
              onApplyPreset(user.name, applyMorphPreset(user.params));
              setSelectedUserPresetId(user.id);
              e.target.value = "";
              return;
            }
            const preset = FACTORY_PRESETS.find((p) => p.id === e.target.value);
            if (preset) {
              onApplyPreset(preset.name, applyMorphPreset(preset.params));
              setSelectedUserPresetId(null);
            }
            e.target.value = "";
          }}
        >
          <option value="">PRESET…</option>
          {userPresets.length > 0 && (
            <optgroup label="USER">
              {userPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
          {groupedPresets.map((g) => (
            <optgroup key={g.key} label={g.label}>
              {g.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-small"
          aria-label="Save user preset"
          title="Save the current settings as a user preset"
          onClick={() => void saveUserPreset()}
        >
          SAVE
        </button>
        {selectedUserPresetId && (
          <>
            <button
              type="button"
              className="btn btn-small"
              aria-label="Rename user preset"
              onClick={() => void renameUserPreset()}
            >
              RENAME
            </button>
            <button
              type="button"
              className="btn btn-small btn-danger"
              aria-label="Delete user preset"
              onClick={() => void deleteUserPreset()}
            >
              DEL
            </button>
          </>
        )}
        {presetError && (
          <span className="ultina-preset-error" role="alert">
            {presetError}
          </span>
        )}
        <div className="morph-io">
          {engineSlider(GLOBAL_INPUT_GAIN_DB_ID, "IN", -24, 24, dbFmt, "linear", 0)}
          {engineSlider(GLOBAL_OUTPUT_GAIN_DB_ID, "OUT", -24, 24, dbFmt, "linear", 0)}
          {engineSlider(GLOBAL_MIX_ID, "MIX", 0, 100, pctFmt, "linear", 100)}
          <button
            type="button"
            className={`morph-stage-toggle ${valueOf(GLOBAL_DELTA_ID) >= 0.5 ? "on" : ""}`}
            aria-label="Delta listen — hear only what the processor changes"
            title="Delta listen: output = wet − dry"
            onClick={() => onParam(GLOBAL_DELTA_ID, valueOf(GLOBAL_DELTA_ID) >= 0.5 ? 0 : 1)}
          >
            DELTA
          </button>
        </div>
      </div>

      <div className="morph-macros">
        <div className="morph-macro morph-macro-pressure">
          <Slider
            label="PRESSURE"
            value={valueOf(MACRO_PRESSURE_ID)}
            min={0}
            max={100}
            defaultValue={35}
            format={pctFmt}
            onCommit={(v) => onParam(MACRO_PRESSURE_ID, v)}
            onPreview={(v) => previewParam(MACRO_PRESSURE_ID, v)}
          />
        </div>
        {macro(MACRO_PUNCH_ID, "PUNCH", -100, true)}
        {macro(MACRO_BODY_ID, "BODY", 0)}
        {macro(MACRO_TEXTURE_ID, "TEXTURE", 0)}
        {macro(MACRO_MOTION_ID, "MOTION", 0)}
        {macro(MACRO_SPACE_ID, "SPACE", 0)}
      </div>

      <canvas ref={canvasRef} width={340} height={66} className="morph-live" aria-label="MORPH DYNAMICS live meters" />

      <div className="morph-sections">
        <button type="button" className="morph-section-toggle" onClick={() => setShowEngine((s) => !s)}>
          ENGINE {showEngine ? "▾" : "▸"}
        </button>
        {showEngine && (
          <div className="morph-engine">
            <div className="morph-module">
              <div className="morph-module-title">DYNAMICS</div>
              {engineSlider(DYN_THRESHOLD_DB_ID, "THRESH", -60, 0, dbFmt, "linear", -24)}
              {engineSlider(DYN_RATIO_ID, "RATIO", 1, 20, ratioFmt, "linear", 2.5)}
              {engineSlider(DYN_ATTACK_MS_ID, "ATTACK", 0.1, 100, msFmt, "linear", 12)}
              {engineSlider(DYN_RELEASE_MS_ID, "RELEASE", 5, 1000, msFmt, "linear", 180)}
              {engineSlider(DYN_KNEE_DB_ID, "KNEE", 0, 24, dbFmt, "linear", 6)}
              {engineSlider(DYN_DETECTOR_BLEND_ID, "PEAK↔RMS", 0, 100, pctFmt, "linear", 50)}
              {engineSlider(DYN_SIDECHAIN_HPF_HZ_ID, "SC HPF", 20, 500, hzFmt, "log", 60)}
              {engineSlider(DYN_MAKEUP_DB_ID, "MAKEUP", -12, 24, dbFmt, "linear", 0)}
              <button
                type="button"
                className={`morph-stage-toggle ${valueOf(DYN_MAKEUP_AUTO_ID) >= 0.5 ? "on" : ""}`}
                onClick={() => onParam(DYN_MAKEUP_AUTO_ID, valueOf(DYN_MAKEUP_AUTO_ID) >= 0.5 ? 0 : 1)}
              >
                AUTO MAKEUP {valueOf(DYN_MAKEUP_AUTO_ID) >= 0.5 ? "ON" : "OFF"}
              </button>
            </div>
            <div className="morph-module">
              <div className="morph-module-title">{stageToggle(CHAR_ENABLED_ID, "CHARACTER")}</div>
              {engineSlider(CHAR_DRIVE_ID, "DRIVE", 0, 100, pctFmt, "linear", 0)}
              {engineSlider(CHAR_TONE_ID, "TONE", -100, 100, pctFmt, "linear", 0)}
              {engineSlider(CHAR_ASYM_ID, "HARMONICS", 0, 100, pctFmt, "linear", 0)}
              {engineSlider(CHAR_CLIP_ID, "CLIP", 0, 100, pctFmt, "linear", 0)}
            </div>
            <div className="morph-module">
              <div className="morph-module-title">{stageToggle(MOTION_ENABLED_ID, "MOTION")}</div>
              {engineSlider(MOTION_DEPTH_ID, "DEPTH", 0, 100, pctFmt, "linear", 40)}
              {engineSlider(MOTION_RATE_HZ_ID, "DRIFT", 0, 5, (v) => `${v.toFixed(2)} Hz`, "linear", 0.2)}
              {engineSlider(MOTION_FEEDBACK_ID, "FEEDBACK", -80, 80, pctFmt, "linear", 30)}
              {engineSlider(MOTION_CENTER_HZ_ID, "CENTER", 200, 4000, hzFmt, "log", 900)}
            </div>
            <div className="morph-module">
              <div className="morph-module-title">{stageToggle(SPACE_ENABLED_ID, "SPACE")}</div>
              {engineSlider(SPACE_SEND_ID, "SEND", 0, 100, pctFmt, "linear", 25)}
              {engineSlider(SPACE_PREDELAY_MS_ID, "PREDELAY", 0, 80, msFmt, "linear", 12)}
              {engineSlider(SPACE_DIFFUSION_ID, "DIFFUSION", 0, 100, pctFmt, "linear", 60)}
              {engineSlider(SPACE_DECAY_S_ID, "DECAY", 0.1, 5, secFmt, "linear", 1.2)}
              {engineSlider(SPACE_DAMPING_ID, "DAMPING", 0, 100, pctFmt, "linear", 45)}
              {engineSlider(SPACE_WIDTH_ID, "WIDTH", 0, 200, pctFmt, "linear", 115)}
              {engineSlider(SPACE_DUCK_ID, "TRN DUCK", 0, 100, pctFmt, "linear", 50)}
            </div>
            <div className="morph-module">
              <div className="morph-module-title">
                ANALYSIS SENSITIVITY
                <button
                  type="button"
                  className={`morph-stage-toggle ${valueOf(ANALYSIS_ADAPTIVE_LEVEL_ID) >= 0.5 ? "on" : ""}`}
                  aria-label="Adaptive level — analyze the performance, not the recording level"
                  title="Adaptive level: T/B/T follow the performance, not the recording level"
                  onClick={() =>
                    onParam(ANALYSIS_ADAPTIVE_LEVEL_ID, valueOf(ANALYSIS_ADAPTIVE_LEVEL_ID) >= 0.5 ? 0 : 1)
                  }
                >
                  AGC
                </button>
              </div>
              {engineSlider(ANALYSIS_TRANSIENT_SENSITIVITY_ID, "TRANSIENT", 0, 200, pctFmt, "linear", 100)}
              {engineSlider(ANALYSIS_BODY_SENSITIVITY_ID, "BODY", 0, 200, pctFmt, "linear", 100)}
              {engineSlider(ANALYSIS_TEXTURE_SENSITIVITY_ID, "TEXTURE", 0, 200, pctFmt, "linear", 100)}
            </div>
          </div>
        )}

        <button type="button" className="morph-section-toggle" onClick={() => setShowMatrix((s) => !s)}>
          MOD MATRIX {showMatrix ? "▾" : "▸"}
        </button>
        {showMatrix && (
          <div className="morph-matrix">
            {Array.from({ length: ROUTE_COUNT }, (_, slot) => {
              const on = valueOf(routeParamId(slot, "enabled")) >= 0.5;
              const sourceIdx = Math.round(valueOf(routeParamId(slot, "source")));
              const destIdx = Math.round(valueOf(routeParamId(slot, "destination")));
              const activity = metersRef.current?.routes?.[slot] ?? 0;
              return (
                <div className={`morph-route ${on ? "on" : ""}`} key={slot}>
                  <button
                    type="button"
                    className={`morph-route-toggle ${on ? "on" : ""}`}
                    aria-label={`Route ${slot + 1} on/off`}
                    onClick={() => onParam(routeParamId(slot, "enabled"), on ? 0 : 1)}
                  >
                    {slot + 1}
                  </button>
                  <select
                    aria-label={`Route ${slot + 1} source`}
                    value={sourceIdx}
                    onChange={(e) => onParam(routeParamId(slot, "source"), Number(e.target.value))}
                  >
                    {SOURCE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <span className="morph-route-arrow">→</span>
                  <select
                    aria-label={`Route ${slot + 1} destination`}
                    value={destIdx}
                    onChange={(e) => onParam(routeParamId(slot, "destination"), Number(e.target.value))}
                  >
                    {DEST_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <div className="morph-route-amount">
                    <Slider
                      compact
                      label=""
                      value={valueOf(routeParamId(slot, "amount"))}
                      min={-100}
                      max={100}
                      defaultValue={50}
                      format={pctFmt}
                      onCommit={(v) => onParam(routeParamId(slot, "amount"), v)}
                      onPreview={(v) => previewParam(routeParamId(slot, "amount"), v)}
                    />
                  </div>
                  <span
                    className="morph-route-activity"
                    style={{
                      // Activity is opacity + a color flip — never color alone.
                      opacity: on ? 0.25 + 0.75 * Math.min(1, activity) : 0.15,
                      background: activity > 0.02 ? "#e8b04b" : "#3a3f4b",
                    }}
                    aria-hidden="true"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default MorphDynamicsPanel;
