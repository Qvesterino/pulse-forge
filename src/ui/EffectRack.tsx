import { useEffect, useState } from "react";
import { useServices, useTracks } from "./context";
import type { EffectType, Track } from "../project-model/types";
import {
  addEffect,
  applyEffectPreset,
  applyEffectChainPreset,
  applyFxEqPreset,
  moveEffect,
  moveEffectToIndex,
  removeEffect,
  resetEffect,
  setEffectParam,
  setEffectOutputTrimDb,
  setEffectSidechainSource,
  setEffectSteps,
  setFxEqParam,
  setUltinaParam,
  applyUltinaPreset,
  applyUltinaProposal,
  applyOzvenaStatePatch,
  setDeviceState,
  loadUltinaAbSlot,
  loadEffectAbSlot,
  toggleEffectBypass,
} from "../commands/commands";
import {
  ADDITIONAL_EFFECT_GROUPS,
  CORE_EFFECT_GROUPS,
  EFFECT_DEFS,
  FLAGSHIP_EFFECT_ORDER,
  defaultParamsOf,
  normalizePluginParams,
} from "../effects/registry";
// Plugin editor panels are heavy (EQ-paint canvas, 51-preset Ultina suite,
// Ozvena blend pad) — they load only when one of these effects is selected.
import { lazy, Suspense } from "react";
const FxEqPanel = lazy(() => import("./FxEqPanel").then((m) => ({ default: m.FxEqPanel })));
const UltinaPanel = lazy(() => import("./UltinaPanel").then((m) => ({ default: m.UltinaPanel })));
const OzvenaPanel = lazy(() => import("./OzvenaPanel").then((m) => ({ default: m.OzvenaPanel })));
const KaskadaPanel = lazy(() => import("./KaskadaPanel").then((m) => ({ default: m.KaskadaPanel })));
import { BeatManglerEditor } from "./BeatManglerEditor";
import { presetsForEffect } from "../effects/presets";
import { BEATMAKING_EFFECT_CHAINS } from "../effects/chains";
import { registerRaf, unregisterRaf } from "../services/rafLoop";
import { StepGridEditor } from "./StepGridEditor";
import type { UltinaAbState } from "./UltinaPanel";
import { EffectAbControls, type EffectAbState } from "./EffectAbControls";
import { DockedPlugin } from "./FloatingPlugin";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import { effectEditorSpec } from "./effectEditorRegistry";
import { EffectParameterGrid } from "./EffectParameterGrid";
import { EffectIntentAssistant } from "./EffectIntentAssistant";
import { Slider } from "./controls";

type EffectRackProps = {
  track: Track;
  mode?: "rack" | "devices";
  selectedPadId?: string;
};

export function EffectRack({ track, mode = "rack", selectedPadId = "" }: EffectRackProps) {
  const services = useServices();
  const doc = services.store.getDoc();
  const devicesMode = mode === "devices";
  const [fallbacks, setFallbacks] = useState<Record<string, string>>({});
  const [gainReduction, setGainReduction] = useState<Record<string, number>>({});
  // Accordion focus: one device editor renders full-width at a time. null =
  // auto (the newest effect), "" = all collapsed, otherwise the focused id.
  // Four flagship editors side by side squeezed each into a ~260px column —
  // unusable; a single focused editor is the DAW-standard device view.
  const [expandedFxId, setExpandedFxId] = useState<string | null>(null);
  const effectiveExpandedFxId =
    expandedFxId ?? (track.effects.length > 0 ? track.effects[track.effects.length - 1].id : "");
  const hasInstrument = track.kind === "instrument" || track.kind === "drum";
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(
    () => track.effects.at(-1)?.id ?? (hasInstrument ? "instrument" : null),
  );
  const [draggedFxId, setDraggedFxId] = useState<string | null>(null);
  const [dropTargetFxId, setDropTargetFxId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedDeviceId(null);
  }, [track.id]);
  const activeDeviceId =
    selectedDeviceId === "instrument" && hasInstrument
      ? "instrument"
      : selectedDeviceId && track.effects.some((fx) => fx.id === selectedDeviceId)
        ? selectedDeviceId
        : (track.effects.at(-1)?.id ?? (hasInstrument ? "instrument" : null));

  // Observer-only poll: degraded fallbacks (worklet DSP unavailable) surface
  // as warning badges; limiters report gain reduction for a live GR meter.
  useEffect(() => {
    let last = 0;
    let fallbackSig = "";
    let grSig = "";
    registerRaf(`fx-status-${track.id}`, (t) => {
      if (t - last < 60) return;
      last = t;
      const nextFallbacks: Record<string, string> = {};
      const engineWithReport = services.engine as typeof services.engine & {
        getDegradedFx?: () => { fxId: string; reason: string }[];
        getFxGainReductionDb?: (trackId: string, fxId: string) => number | null;
      };
      for (const item of engineWithReport.getDegradedFx?.() ?? []) nextFallbacks[item.fxId] = item.reason;
      const nextGr: Record<string, number> = {};
      for (const fx of track.effects) {
        if (fx.type !== "limiter" && fx.type !== "compressor" && fx.type !== "drumBuss" && fx.type !== "bassBuss")
          continue;
        if (fx.bypassed) continue;
        const value = engineWithReport.getFxGainReductionDb?.(track.id, fx.id);
        if (value != null && value > 0.05) nextGr[fx.id] = Math.round(value * 2) / 2;
      }
      const nextFallbackSig = Object.keys(nextFallbacks)
        .sort()
        .map((k) => `${k}:${nextFallbacks[k]}`)
        .join("|");
      const nextGrSig = Object.entries(nextGr)
        .sort()
        .map(([k, v]) => `${k}:${v}`)
        .join("|");
      if (nextFallbackSig !== fallbackSig) {
        fallbackSig = nextFallbackSig;
        setFallbacks(nextFallbacks);
      }
      if (nextGrSig !== grSig) {
        grSig = nextGrSig;
        setGainReduction(nextGr);
      }
    });
    return () => unregisterRaf(`fx-status-${track.id}`);
  }, [services, track]);

  if (devicesMode) {
    const selectedFx = track.effects.find((fx) => fx.id === activeDeviceId);
    const instrumentLabel =
      track.kind === "instrument"
        ? INSTRUMENT_DEFS[track.instrument].name.toUpperCase()
        : track.kind === "drum"
          ? "DRUMS"
          : "BUS";

    return (
      <section className="devices-panel" aria-label={`Devices — ${track.name}`}>
        <div className="devices-toolbar">
          <span className="devices-track-name" title={track.name}>
            {track.name}
          </span>
          <div className="devices-chain" role="group" aria-label="Track device chain. Drag modules to reorder them.">
            {hasInstrument && (
              <button
                type="button"
                className={`device-chain-item${activeDeviceId === "instrument" ? " active" : ""}`}
                aria-pressed={activeDeviceId === "instrument"}
                title={`${instrumentLabel} instrument`}
                onClick={() => setSelectedDeviceId("instrument")}
              >
                <span className="device-chain-dot" aria-hidden="true" />
                {instrumentLabel}
              </button>
            )}
            {track.effects.map((fx) => (
              <button
                key={fx.id}
                type="button"
                draggable
                className={`device-chain-item${activeDeviceId === fx.id ? " active" : ""}${fx.bypassed ? " is-bypassed" : ""}${draggedFxId === fx.id ? " is-dragging" : ""}${dropTargetFxId === fx.id ? " is-drop-target" : ""}`}
                aria-pressed={activeDeviceId === fx.id}
                title={`${EFFECT_DEFS[fx.type].name}${fx.bypassed ? " — bypassed" : ""}`}
                onClick={() => setSelectedDeviceId(fx.id)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", fx.id);
                  setDraggedFxId(fx.id);
                }}
                onDragEnd={() => {
                  setDraggedFxId(null);
                  setDropTargetFxId(null);
                }}
                onDragOver={(event) => {
                  if (!draggedFxId || draggedFxId === fx.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropTargetFxId(fx.id);
                }}
                onDragLeave={() => setDropTargetFxId((current) => (current === fx.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  const draggedId = event.dataTransfer.getData("text/plain") || draggedFxId;
                  const from = track.effects.findIndex((candidate) => candidate.id === draggedId);
                  const targetIndex = track.effects.findIndex((candidate) => candidate.id === fx.id);
                  if (draggedId && from >= 0 && targetIndex >= 0 && from !== targetIndex) {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const insertAfter = event.clientX >= rect.left + rect.width / 2;
                    const insertionSlot = targetIndex + (insertAfter ? 1 : 0);
                    const finalIndex = from < insertionSlot ? insertionSlot - 1 : insertionSlot;
                    services.store.execute(moveEffectToIndex(doc, track.id, draggedId, finalIndex));
                  }
                  setDraggedFxId(null);
                  setDropTargetFxId(null);
                }}
              >
                <span className="device-chain-dot" aria-hidden="true" />
                {EFFECT_DEFS[fx.type].name}
              </button>
            ))}
          </div>
          <select
            className="devices-add-effect"
            value=""
            title={
              selectedFx
                ? `Insert effect after ${EFFECT_DEFS[selectedFx.type].name}`
                : activeDeviceId === "instrument"
                  ? `Insert effect after ${instrumentLabel}`
                  : "Add effect to this track"
            }
            aria-label={
              selectedFx
                ? "Insert effect after the selected device"
                : activeDeviceId === "instrument"
                  ? "Insert effect after the instrument"
                  : "Add effect to the track"
            }
            onChange={(event) => {
              const type = event.target.value as EffectType;
              if (!type) return;
              const selectedIndex = track.effects.findIndex((fx) => fx.id === activeDeviceId);
              const insertionIndex =
                selectedIndex >= 0 ? selectedIndex + 1 : activeDeviceId === "instrument" ? 0 : track.effects.length;
              const command = addEffect(doc, track.id, type, insertionIndex);
              services.store.execute(command);
              setSelectedDeviceId(command.effectId);
            }}
          >
            <option value="">+ FX</option>
            {CORE_EFFECT_GROUPS.map((group) => (
              <optgroup key={group.key} label={group.label}>
                {group.types.map((type) => (
                  <option key={type} value={type}>
                    {EFFECT_DEFS[type].name}
                  </option>
                ))}
              </optgroup>
            ))}
            <optgroup label="FLAGSHIP PLUGINS">
              {FLAGSHIP_EFFECT_ORDER.map((type) => (
                <option key={type} value={type}>
                  {EFFECT_DEFS[type].name}
                </option>
              ))}
            </optgroup>
            {ADDITIONAL_EFFECT_GROUPS.map((group) => (
              <optgroup key={`${group.key}-more`} label={group.label}>
                {group.types.map((type) => (
                  <option key={type} value={type}>
                    {EFFECT_DEFS[type].name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <select
            className="devices-add-chain"
            value=""
            title="Add a short beatmaking effect chain after the selected device"
            aria-label="Add a beatmaking effect chain"
            onChange={(event) => {
              const chain = BEATMAKING_EFFECT_CHAINS.find((candidate) => candidate.id === event.target.value);
              if (!chain) return;
              const selectedIndex = track.effects.findIndex((fx) => fx.id === activeDeviceId);
              const insertionIndex =
                selectedIndex >= 0 ? selectedIndex + 1 : activeDeviceId === "instrument" ? 0 : track.effects.length;
              const command = applyEffectChainPreset(doc, track.id, chain, insertionIndex);
              services.store.execute(command);
              setSelectedDeviceId(command.firstEffectId);
            }}
          >
            <option value="">+ CHAIN</option>
            {BEATMAKING_EFFECT_CHAINS.map((chain) => (
              <option key={chain.id} value={chain.id} title={chain.description}>
                {chain.name}
              </option>
            ))}
          </select>
        </div>
        <div className="device-surface">
          {activeDeviceId === "instrument" && hasInstrument ? (
            <DockedPlugin trackId={track.id} selectedPadId={selectedPadId} />
          ) : selectedFx ? (
            <Device
              track={track}
              fx={selectedFx}
              index={track.effects.findIndex((fx) => fx.id === selectedFx.id)}
              count={track.effects.length}
              fallbackReason={fallbacks[selectedFx.id]}
              gainReductionDb={gainReduction[selectedFx.id]}
              expanded
              onToggleFocus={() => {}}
              devicesMode
            />
          ) : (
            <div className="devices-empty">Add a device to this track to build its sound.</div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="fx-rack" aria-label={`Effect rack — ${track.name}`}>
      <div className="fx-rack-header">
        <h2 className="panel-title">FX — {track.name}</h2>
        <select
          className="fx-add-select"
          value=""
          aria-label="Add effect"
          onChange={(event) => {
            const type = event.target.value as EffectType;
            if (type) services.store.execute(addEffect(doc, track.id, type));
          }}
        >
          <option value="">+ ADD EFFECT</option>
          {CORE_EFFECT_GROUPS.map((group) => (
            <optgroup key={group.key} label={group.label}>
              {group.types.map((type) => (
                <option key={type} value={type}>
                  {EFFECT_DEFS[type].name}
                </option>
              ))}
            </optgroup>
          ))}
          <optgroup label="FLAGSHIP PLUGINS">
            {FLAGSHIP_EFFECT_ORDER.map((type) => (
              <option key={type} value={type}>
                {EFFECT_DEFS[type].name}
              </option>
            ))}
          </optgroup>
          {ADDITIONAL_EFFECT_GROUPS.map((group) => (
            <optgroup key={`${group.key}-more`} label={group.label}>
              {group.types.map((type) => (
                <option key={type} value={type}>
                  {EFFECT_DEFS[type].name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {track.effects.length === 0 ? (
        <div className="fx-empty">No effects on this track. Add one above.</div>
      ) : (
        <div className="fx-devices">
          {track.effects.map((fx, index) => (
            <Device
              key={fx.id}
              track={track}
              fx={fx}
              index={index}
              count={track.effects.length}
              fallbackReason={fallbacks[fx.id]}
              gainReductionDb={gainReduction[fx.id]}
              expanded={fx.id === effectiveExpandedFxId}
              onToggleFocus={() => setExpandedFxId(fx.id === effectiveExpandedFxId ? "" : fx.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Device({
  track,
  fx,
  index,
  count,
  fallbackReason,
  gainReductionDb,
  expanded,
  onToggleFocus,
  devicesMode = false,
}: {
  track: Track;
  fx: TrackEffect;
  index: number;
  count: number;
  fallbackReason?: string;
  gainReductionDb?: number;
  expanded: boolean;
  onToggleFocus: () => void;
  devicesMode?: boolean;
}) {
  const services = useServices();
  // GOAL 04: `doc` is only consumed as a command argument (applyEffectPreset,
  // moveEffect, etc.). A plain getter avoids the doc-wide subscription this
  // component would otherwise carry.
  const doc = services.store.getDoc();
  // Sidechain picker resolves names across tracks — same fine-grained
  // selector the rack header uses (see GOAL 04 note there).
  const tracks = useTracks();
  const def = EFFECT_DEFS[fx.type];
  // Roadmap O7: transient note for user-IR loading (Ozvena convolution).
  const [irNote, setIrNote] = useState<string | null>(null);
  const [paramPage, setParamPage] = useState(0);
  // A/B state lives in the DOCUMENT (fx.deviceState) — collapse, unmount,
  // track switches, reloads and collab sync all preserve it. React state is
  // only the transient draft inside the panel between pointer and command.
  const contentId = `fx-device-content-${fx.id}`;
  const defaultParams = normalizePluginParams(fx.type, {}) ?? defaultParamsOf(fx.type);
  const isModified = Object.keys({ ...defaultParams, ...fx.params }).some(
    (paramId) => (fx.params[paramId] ?? defaultParams[paramId]) !== defaultParams[paramId],
  );
  const editorSpec = effectEditorSpec(fx.type);
  const genericParams = devicesMode
    ? fx.type === "fxeq"
      ? def.params.filter((param) => !/^band\d+\./.test(param.id))
      : fx.type === "ultina" || fx.type === "ozvena"
        ? def.params.filter((param) => param.id.startsWith("global."))
        : fx.type === "beatMangler"
          ? def.params.filter((param) => !["trigger", "interval", "offset", "chance", "gate"].includes(param.id))
        : def.params
    : def.params;
  const usableParams = genericParams.filter(
    (param) =>
      !(
        fx.type === "eq" &&
        ["lowGain", "lowFreq", "midGain", "midFreq", "midQ", "highGain", "highFreq"].includes(param.id)
      ),
  );
  const primaryParams = (editorSpec.primaryParamIds ?? [])
    .map((id) => usableParams.find((param) => param.id === id))
    .filter((param): param is (typeof usableParams)[number] => !!param);
  const remainingParams = usableParams.filter((param) => !primaryParams.some((primary) => primary.id === param.id));
  const pageSize = 4;
  const chunkParams = (params: typeof usableParams) =>
    Array.from({ length: Math.ceil(params.length / pageSize) }, (_, page) =>
      params.slice(page * pageSize, (page + 1) * pageSize),
    );
  const controlPages = devicesMode
    ? [...(primaryParams.length > 0 ? [primaryParams] : []), ...chunkParams(remainingParams)]
    : [usableParams];
  const pageCount = Math.max(1, controlPages.length);
  const visibleParams = controlPages[paramPage] ?? [];

  useEffect(() => setParamPage(0), [fx.id]);

  return (
    <div
      className={`fx-device${devicesMode ? " device-editor" : ""}${fx.bypassed ? " bypassed" : ""}${expanded ? "" : " collapsed"}`}
    >
      <div className="fx-device-header">
        <button
          type="button"
          className="fx-device-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${def.name}`}
          title={`${expanded ? "Collapse" : "Expand"} ${def.name}`}
          onClick={onToggleFocus}
        >
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        </button>
        <span className="fx-device-title">
          <span className="fx-device-name">{def.name}</span>
          <span className={`fx-device-family family-${editorSpec.family}`}>{editorSpec.family.toUpperCase()}</span>
          <span className="fx-device-state">{fx.bypassed ? "BYPASSED" : "ACTIVE"}</span>
          {isModified && (
            <span className="fx-device-dirty" title="Parameters differ from the factory defaults">
              MODIFIED
            </span>
          )}
          {irNote && (
            <span className="fx-device-warn" role="status">
              {irNote}
            </span>
          )}
          {fallbackReason && (
            <span className="fx-device-warn" role="status" title={fallbackReason}>
              ⚠ FALLBACK
            </span>
          )}
        </span>
        {presetsForEffect(fx.type).length > 0 && (
          <select
            className="fx-preset-select"
            value=""
            aria-label={`Preset for ${def.name}`}
            onChange={(event) => {
              const selected = presetsForEffect(fx.type).find((item) => item.id === event.target.value);
              if (selected) services.store.execute(applyEffectPreset(doc, track.id, fx.id, selected));
            }}
          >
            <option value="">PRESETS</option>
            {presetsForEffect(fx.type).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        {fx.type === "ozvena" && (
          <label className="btn btn-small fx-ir-load" title="Load a user impulse response (VØID convolution)">
            IR…
            <input
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                const engine = services.engine as typeof services.engine & {
                  loadUserIrForFx?: (trackId: string, fxId: string, file: File) => Promise<void>;
                };
                if (!engine.loadUserIrForFx) {
                  setIrNote("Engine cannot load IRs");
                  return;
                }
                setIrNote("Decoding…");
                engine
                  .loadUserIrForFx(track.id, fx.id, file)
                  .then(() => setIrNote("IR loaded"))
                  .catch((err: unknown) => setIrNote(err instanceof Error ? err.message : String(err)));
              }}
            />
          </label>
        )}
        <div className="fx-device-buttons">
          <button
            type="button"
            className="btn btn-small"
            title="Move earlier in chain"
            disabled={index === 0}
            onClick={() => services.store.execute(moveEffect(doc, track.id, fx.id, -1))}
          >
            ◀
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Move later in chain"
            disabled={index === count - 1}
            onClick={() => services.store.execute(moveEffect(doc, track.id, fx.id, 1))}
          >
            ▶
          </button>
          <button
            type="button"
            className={`btn btn-small${fx.bypassed ? " active-mute" : ""}`}
            title={fx.bypassed ? "Enable effect" : "Bypass effect"}
            onClick={() => services.store.execute(toggleEffectBypass(doc, track.id, fx.id))}
          >
            B
          </button>
          <button
            type="button"
            className="btn btn-small"
            aria-label={`Reset ${def.name}`}
            title={`Reset ${def.name} to factory defaults`}
            disabled={!isModified}
            onClick={() => services.store.execute(resetEffect(doc, track.id, fx.id))}
          >
            ↺
          </button>
          <button
            type="button"
            className="btn btn-small btn-danger"
            title="Remove effect"
            onClick={() => services.store.execute(removeEffect(doc, track.id, fx.id))}
          >
            ×
          </button>
        </div>
      </div>
      {expanded && (
        <div id={contentId} className="fx-device-content">
          <EffectIntentAssistant trackId={track.id} effect={fx} fallbackReason={fallbackReason} />
          {fx.type === "eq" && <EqResponseCurve params={fx.params} />}
          {(fx.type === "limiter" || fx.type === "compressor" || fx.type === "drumBuss" || fx.type === "bassBuss") && (
            <div className="fx-gr" aria-label="Gain reduction">
              <div className="fx-gr-track">
                <div
                  className="fx-gr-fill"
                  style={{ width: `${Math.min(100, ((gainReductionDb ?? 0) / 12) * 100)}%` }}
                />
              </div>
              <span className="fx-gr-label">GR {(gainReductionDb ?? 0).toFixed(1)} dB</span>
            </div>
          )}
          {(fx.type === "sidechain" || fx.type === "compressor" || fx.type === "fxeq" || fx.type === "pump") && (
            <div className="fx-sidechain-picker">
              <label className="fx-param-select">
                <span className="slider-label">SOURCE</span>
                <select
                  value={fx.sidechainTrackId ?? ""}
                  onChange={(event) =>
                    services.store.execute(setEffectSidechainSource(doc, track.id, fx.id, event.target.value || null))
                  }
                >
                  <option value="">OFF</option>
                  {doc.tracks
                    .filter((candidate) => candidate.id !== track.id)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                        {candidate.kind === "group" ? " · BUS" : ""}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-small"
                title="Choose the first kick drum track, or the first drum track"
                onClick={() => {
                  const drums = tracks.filter((candidate) => candidate.kind === "drum");
                  const kick =
                    drums.find(
                      (candidate) =>
                        candidate.name.toLowerCase().includes("kick") ||
                        candidate.pads.some((pad) => pad.name.toLowerCase().includes("kick")),
                    ) ?? drums[0];
                  if (kick) services.store.execute(setEffectSidechainSource(doc, track.id, fx.id, kick.id));
                }}
              >
                KICK
              </button>
              <span className="fx-sidechain-status">
                {fx.sidechainTrackId
                  ? (tracks.find((candidate) => candidate.id === fx.sidechainTrackId)?.name ?? "MISSING")
                  : "No source"}
              </span>
            </div>
          )}
          {fx.type === "stepGate" && (
            <StepGridEditor
              steps={fx.steps && fx.steps.length > 0 ? fx.steps : [1, 0]}
              min={0}
              max={1}
              ariaLabel={`Step gate pattern for ${track?.name ?? "track"}`}
              onCommit={(steps) => services.store.execute(setEffectSteps(doc, track.id, fx.id, steps))}
            />
          )}
          {fx.type === "stutter" && (
            <StepGridEditor
              steps={fx.steps && fx.steps.length > 0 ? fx.steps : Array(16).fill(1)}
              min={0}
              max={1}
              ariaLabel={`Stutter gate pattern for ${track?.name ?? "track"}`}
              onCommit={(steps) => services.store.execute(setEffectSteps(doc, track.id, fx.id, steps))}
            />
          )}
          {fx.type === "beatMangler" && <BeatManglerEditor trackId={track.id} fxId={fx.id} />}
          <Suspense fallback={<div className="fx-panel-loading">Loading editor…</div>}>
            {fx.type === "fxeq" && (
              <FxEqPanel
                trackId={track.id}
                fxId={fx.id}
                params={fx.params}
                degraded={!!fallbackReason}
                sidechainTrackId={fx.sidechainTrackId}
                docked={devicesMode}
                abState={
                  fx.deviceState?.kind === "effect-ab-v1"
                    ? (fx.deviceState.data as unknown as EffectAbState)
                    : undefined
                }
                onAbStateChange={(next) =>
                  services.store.execute(
                    setDeviceState(doc, track.id, fx.id, { kind: "effect-ab-v1", data: { ...next } }),
                  )
                }
                onAbLoad={(slot) => services.store.execute(loadEffectAbSlot(doc, track.id, fx.id, slot))}
                onParam={(fullId, value) => services.store.execute(setFxEqParam(doc, track.id, fx.id, fullId, value))}
                onApplyPreset={(name, presetParams) =>
                  services.store.execute(applyFxEqPreset(doc, track.id, fx.id, name, presetParams))
                }
              />
            )}
            {fx.type === "ultina" && (
              <UltinaPanel
                trackId={track.id}
                fxId={fx.id}
                params={fx.params}
                degraded={!!fallbackReason}
                bypassed={fx.bypassed}
                docked={devicesMode}
                onParam={(paramId, value) =>
                  services.store.execute(setUltinaParam(doc, track.id, fx.id, paramId, value))
                }
                onApplyPreset={(name, presetParams) =>
                  services.store.execute(applyUltinaPreset(doc, track.id, fx.id, name, presetParams))
                }
                onApplyProposal={(label, toggles, changes) =>
                  services.store.execute(applyUltinaProposal(doc, track.id, fx.id, label, toggles, changes))
                }
                abState={
                  fx.deviceState?.kind === "ultina-ab-v1"
                    ? (fx.deviceState.data as unknown as UltinaAbState)
                    : undefined
                }
                onAbStateChange={(next) =>
                  services.store.execute(
                    setDeviceState(doc, track.id, fx.id, { kind: "ultina-ab-v1", data: { ...next } }),
                  )
                }
                onAbLoad={(slot) => services.store.execute(loadUltinaAbSlot(doc, track.id, fx.id, slot))}
              />
            )}
            {fx.type === "ozvena" && (
              <OzvenaPanel
                params={fx.params}
                degraded={!!fallbackReason}
                docked={devicesMode}
                onParam={(paramId, value) =>
                  services.store.execute(setEffectParam(doc, track.id, fx.id, paramId, value))
                }
                onApplyPatch={(label, flatParams) =>
                  services.store.execute(applyOzvenaStatePatch(doc, track.id, fx.id, label, flatParams))
                }
              />
            )}
            {fx.type === "kaskada" && (
              <KaskadaPanel
                trackId={track.id}
                fxId={fx.id}
                params={fx.params}
                degraded={!!fallbackReason}
                docked={devicesMode}
                onParam={(paramId, value) =>
                  services.store.execute(setEffectParam(doc, track.id, fx.id, paramId, value))
                }
              />
            )}
          </Suspense>
          {fx.type === "ozvena" && (
            <EffectAbControls
              effectName={def.name}
              params={fx.params}
              deviceState={fx.deviceState?.kind === "effect-ab-v1" ? fx.deviceState : undefined}
              onStateChange={(next: EffectAbState) =>
                services.store.execute(
                  setDeviceState(doc, track.id, fx.id, { kind: "effect-ab-v1", data: { ...next } }),
                )
              }
              onLoad={(slot) => services.store.execute(loadEffectAbSlot(doc, track.id, fx.id, slot))}
            />
          )}
          {devicesMode && pageCount > 1 && (
            <div className="device-param-pager" role="group" aria-label={`${def.name} parameter pages`}>
              <span>
                {editorSpec.primaryParamIds && paramPage === 0
                  ? "MAIN"
                  : editorSpec.primaryParamIds
                    ? `DETAILS ${paramPage}/${pageCount - 1}`
                    : `CONTROLS ${paramPage + 1}/${pageCount}`}
              </span>
              <button
                type="button"
                className="btn btn-small"
                aria-label="Previous control page"
                disabled={paramPage === 0}
                onClick={() => setParamPage((page) => Math.max(0, page - 1))}
              >
                ‹
              </button>
              <button
                type="button"
                className="btn btn-small"
                aria-label="Next control page"
                disabled={paramPage >= pageCount - 1}
                onClick={() => setParamPage((page) => Math.min(pageCount - 1, page + 1))}
              >
                ›
              </button>
            </div>
          )}
          <EffectParameterGrid
            family={editorSpec.family}
            params={visibleParams}
            values={fx.params}
            paged={devicesMode}
            onChange={(paramId, value) => services.store.execute(setEffectParam(doc, track.id, fx.id, paramId, value))}
          />
          <div className="fx-output-trim-row" aria-label="Effect output level">
            <Slider
              compact
              label="OUT"
              min={-18}
              max={12}
              defaultValue={0}
              value={fx.outputTrimDb ?? 0}
              format={(value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)} dB`}
              onCommit={(value) =>
                services.store.execute(setEffectOutputTrimDb(services.store.getDoc(), track.id, fx.id, value))
              }
            />
            <span className="fx-output-trim-note">Preset match</span>
          </div>
        </div>
      )}
    </div>
  );
}

function EqResponseCurve({ params }: { params: Record<string, number> }) {
  const points = [
    [0, 42],
    [12, 42 - (params.lowShelfGain ?? 0) * 1.2],
    [31, 42 - (params.lowMidGain ?? 0) * 1.2],
    [58, 42 - (params.highMidGain ?? 0) * 1.2],
    [84, 42 - (params.highShelfGain ?? 0) * 1.2],
    [100, 42],
  ]
    .map(([x, y]) => `${x},${Math.max(4, Math.min(60, y))}`)
    .join(" ");
  return (
    <div className="eq-response-curve" aria-label="EQ response curve">
      <svg viewBox="0 0 100 60" preserveAspectRatio="none" role="img">
        <polyline points="0,42 100,42" className="eq-response-zero" />
        <polyline points={points} className="eq-response-line" />
      </svg>
      <span>RESPONSE</span>
    </div>
  );
}

type TrackEffect = Track["effects"][number];
