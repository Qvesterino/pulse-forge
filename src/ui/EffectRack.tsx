import { useEffect, useState } from "react";
import { useServices, useTracks } from "./context";
import type { EffectType, Track } from "../project-model/types";
import type { EffectGainReductionReading } from "../effects/types";
import { FxAddPopover } from "./FxAddPopover";
import { FxIntentBar } from "./FxIntentBar";
import { EmptyState, PanelHeader } from "./PanelChrome";
import { parseProductionIntent } from "../intent/production";
import { addEffectWithLandingCommand } from "../commands/commands";
import { applyProductionIntentToTrackCommand } from "../commands/intentRouting";
import { applyEffectIntentOnTrack } from "./fxAddAssistant";
import { roleOfTrack, rolePresetFor } from "../effects/role-presets";
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
  setEffectMacroParams,
  setEffectOutputTrimDb,
  setEffectSidechainSource,
  setEffectSteps,
  setFxEqParam,
  setUltinaParam,
  applyUltinaPreset,
  applyUltinaProposal,
  applyOzvenaStatePatch,
  setMorphDynamicsParam,
  applyMorphDynamicsPreset,
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
const MorphDynamicsPanel = lazy(() => import("./MorphDynamicsPanel").then((m) => ({ default: m.MorphDynamicsPanel })));
import { BeatManglerEditor } from "./BeatManglerEditor";
import { presetsForEffect } from "../effects/presets";
import { BEATMAKING_EFFECT_CHAINS } from "../effects/chains";
import {
  SOURCE_PROFILE_IDS,
  sourceChainOf,
  sourceProfileForTrack,
  sourceProfileOf,
  type SourceMacro,
  type SourceProfileId,
} from "../effects/sourceProfiles";
import { registerRaf, unregisterRaf } from "../services/rafLoop";
import { StepGridEditor } from "./StepGridEditor";
import type { UltinaAbState } from "./UltinaPanel";
import type { MorphScenesState } from "../effects/morph-dynamics-core/contracts/state";
import { EffectAbControls, type EffectAbState } from "./EffectAbControls";
import { DockedPlugin } from "./FloatingPlugin";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import { effectEditorSpec } from "./effectEditorRegistry";
import { EffectParameterGrid } from "./EffectParameterGrid";
import { EffectIntentAssistant } from "./EffectIntentAssistant";
import { EffectQuickControls, isEffectQuickControlParam } from "./EffectQuickControls";
import { Slider } from "./controls";
import { SourceMacroDock } from "./SourceMacroDock";

type EffectRackProps = {
  track: Track;
  mode?: "rack" | "devices";
  selectedPadId?: string;
  isMaster?: boolean;
  /** Distinguishes simultaneous isolated master racks from the project master rack. */
  statusScopeId?: string;
  /** External mastering sessions cannot attach a transient user IR to the live engine graph. */
  allowUserImpulseResponses?: boolean;
};

export function EffectRack({
  track,
  mode = "rack",
  selectedPadId = "",
  isMaster = false,
  statusScopeId,
  allowUserImpulseResponses = true,
}: EffectRackProps) {
  const services = useServices();
  const doc = services.store.getDoc();
  const devicesMode = mode === "devices";
  // Goal-first add popover (FX-ADD-REWORK-ROADMAP Wave A): same device set
  // the old header select offered, now described and searchable.
  const [addOpen, setAddOpen] = useState(false);
  const [goalNote, setGoalNote] = useState<string | null>(null);
  // Wave B — role-aware landings: what this track IS decides how a device
  // lands (vinyl on the 808 = tape-ish dust, on the kit = sizzle).
  const role = roleOfTrack(track);
  const addLanded = (type: EffectType, insertAt?: number) => {
    const landing = rolePresetFor(type, role);
    return landing
      ? addEffectWithLandingCommand(doc, track.id, type, landing, insertAt)
      : addEffect(doc, track.id, type, insertAt);
  };
  const addableDevices: EffectType[] = [
    ...CORE_EFFECT_GROUPS.flatMap((group) => group.types),
    ...FLAGSHIP_EFFECT_ORDER,
    ...ADDITIONAL_EFFECT_GROUPS.flatMap((group) => group.types),
  ];
  const [fallbacks, setFallbacks] = useState<Record<string, string>>({});
  const [gainReduction, setGainReduction] = useState<Record<string, number>>({});
  const [gainReductionBreakdown, setGainReductionBreakdown] = useState<
    Record<string, readonly EffectGainReductionReading[]>
  >({});
  // Accordion focus: one device editor renders full-width at a time. null =
  // auto (the newest effect), "" = all collapsed, otherwise the focused id.
  // Four flagship editors side by side squeezed each into a ~260px column —
  // unusable; a single focused editor is the DAW-standard device view.
  const [expandedFxId, setExpandedFxId] = useState<string | null>(null);
  // Audit 05 D3: an expanded id whose device was deleted via collab/undo
  // used to stick forever (rack collapsed until the next manual toggle).
  // "" = explicitly collapsed (sticky), null or a dead id = auto (newest).
  const effectiveExpandedFxId =
    expandedFxId === ""
      ? ""
      : expandedFxId !== null && track.effects.some((fx) => fx.id === expandedFxId)
        ? expandedFxId
        : (track.effects.at(-1)?.id ?? "");
  const hasInstrument = track.kind === "instrument" || track.kind === "drum";
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(
    () => track.effects.at(-1)?.id ?? (hasInstrument ? "instrument" : null),
  );
  const [sourceProfileId, setSourceProfileId] = useState<SourceProfileId>(() =>
    sourceProfileForTrack(track, selectedPadId),
  );
  const [sourceEffectIds, setSourceEffectIds] = useState<readonly string[]>([]);
  const [draggedFxId, setDraggedFxId] = useState<string | null>(null);
  const [dropTargetFxId, setDropTargetFxId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedDeviceId(null);
  }, [track.id]);
  useEffect(() => {
    setSourceProfileId(sourceProfileForTrack(track, selectedPadId));
    setSourceEffectIds([]);
  }, [track.id, selectedPadId]);
  const activeDeviceId =
    selectedDeviceId === "instrument" && hasInstrument
      ? "instrument"
      : selectedDeviceId && track.effects.some((fx) => fx.id === selectedDeviceId)
        ? selectedDeviceId
        : (track.effects.at(-1)?.id ?? (hasInstrument ? "instrument" : null));

  const sourceProfile = sourceProfileOf(sourceProfileId);
  const loadSourceProfile = () => {
    const chain = sourceChainOf(sourceProfile, BEATMAKING_EFFECT_CHAINS);
    if (!chain) return;
    const selectedIndex = track.effects.findIndex((fx) => fx.id === activeDeviceId);
    const insertionIndex =
      selectedIndex >= 0 ? selectedIndex + 1 : activeDeviceId === "instrument" ? 0 : track.effects.length;
    const command = applyEffectChainPreset(services.store.getDoc(), track.id, chain, insertionIndex);
    services.store.execute(command);
    setSourceEffectIds(command.effectIds);
    setSelectedDeviceId(command.firstEffectId);
  };
  const commitSourceMacro = (macro: SourceMacro, value: number) => {
    const edits = macro.targets
      .map((target) => {
        const fxId = sourceEffectIds[target.slot];
        if (!fxId) return null;
        return {
          fxId,
          paramId: target.paramId,
          value: target.from + (target.to - target.from) * Math.min(1, Math.max(0, value)),
        };
      })
      .filter((edit): edit is { fxId: string; paramId: string; value: number } => edit !== null);
    if (edits.length === 0) return;
    services.store.execute(setEffectMacroParams(services.store.getDoc(), track.id, edits));
  };

  // Observer-only poll: degraded fallbacks surface as warning badges, while
  // metered dynamics devices expose live GR readings without owning audio state.
  useEffect(() => {
    let last = 0;
    let fallbackSig = "";
    let grSig = "";
    let grBreakdownSig = "";
    const statusKey = statusScopeId ?? track.id;
    registerRaf(`fx-status-${statusKey}`, (t) => {
      if (t - last < 60) return;
      last = t;
      const nextFallbacks: Record<string, string> = {};
      const engineWithReport = services.engine as typeof services.engine & {
        getDegradedFx?: () => { fxId: string; reason: string }[];
        getFxGainReductionDb?: (trackId: string, fxId: string) => number | null;
        getFxGainReductionBreakdown?: (trackId: string, fxId: string) => readonly EffectGainReductionReading[] | null;
      };
      for (const item of engineWithReport.getDegradedFx?.() ?? []) nextFallbacks[item.fxId] = item.reason;
      const nextGr: Record<string, number> = {};
      const nextGrBreakdown: Record<string, readonly EffectGainReductionReading[]> = {};
      for (const fx of track.effects) {
        if (fx.bypassed) continue;
        const breakdown = engineWithReport.getFxGainReductionBreakdown?.(track.id, fx.id);
        if (breakdown?.length) {
          nextGrBreakdown[fx.id] = breakdown.map((reading) => ({
            label: reading.label,
            gainReductionDb: Math.round(reading.gainReductionDb * 2) / 2,
          }));
          continue;
        }
        if (
          fx.type !== "limiter" &&
          fx.type !== "compressor" &&
          fx.type !== "drumBuss" &&
          fx.type !== "bassBuss" &&
          fx.type !== "apeks"
        )
          continue;
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
      const nextGrBreakdownSig = Object.entries(nextGrBreakdown)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([fxId, readings]) =>
            `${fxId}:${readings.map(({ label, gainReductionDb }) => `${label}=${gainReductionDb}`).join(",")}`,
        )
        .join("|");
      if (nextFallbackSig !== fallbackSig) {
        fallbackSig = nextFallbackSig;
        setFallbacks(nextFallbacks);
      }
      if (nextGrSig !== grSig) {
        grSig = nextGrSig;
        setGainReduction(nextGr);
      }
      if (nextGrBreakdownSig !== grBreakdownSig) {
        grBreakdownSig = nextGrBreakdownSig;
        setGainReductionBreakdown(nextGrBreakdown);
      }
    });
    return () => unregisterRaf(`fx-status-${statusKey}`);
  }, [services, statusScopeId, track]);

  if (devicesMode) {
    const selectedFx = track.effects.find((fx) => fx.id === activeDeviceId);
    const instrumentLabel =
      track.kind === "instrument"
        ? INSTRUMENT_DEFS[track.instrument].name.toUpperCase()
        : track.kind === "drum"
          ? "DRUMS"
          : "BUS";

    return (
      <section
        className={`devices-panel${isMaster ? " mastering-device-panel" : ""}`}
        aria-label={isMaster ? "Master effects" : `Devices — ${track.name}`}
      >
        {/* V2 (ROADMAP-UI-2027): the panel identifies itself and hosts its
            add-actions in one header row; the chain strip below is pure
            navigation. Before, track name + chain + two selects shared one
            anonymous toolbar with no hierarchy. */}
        <PanelHeader
          kicker={isMaster ? "MASTERING" : "DEVICES"}
          title={track.name}
          hint={isMaster ? "Final mix inserts before the safety limiter and output meters." : undefined}
          actions={
            <>
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
                  const command = addLanded(type, insertionIndex);
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
              {!isMaster && (
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
                      selectedIndex >= 0
                        ? selectedIndex + 1
                        : activeDeviceId === "instrument"
                          ? 0
                          : track.effects.length;
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
              )}
            </>
          }
        />
        <div className="devices-toolbar">
          <div className="devices-chain" role="group" aria-label="Track device chain. Drag modules to reorder them.">
            {hasInstrument && (
              <button
                type="button"
                className={`device-chain-item is-instrument${activeDeviceId === "instrument" ? " active" : ""}`}
                data-family="instrument"
                aria-pressed={activeDeviceId === "instrument"}
                title={`${instrumentLabel} instrument`}
                onClick={() => setSelectedDeviceId("instrument")}
              >
                <span className="device-chain-index" aria-hidden="true">
                  0
                </span>
                <span className="device-chain-dot" aria-hidden="true" />
                {instrumentLabel}
              </button>
            )}
            {track.effects.map((fx, chainIndex) => (
              <button
                key={fx.id}
                type="button"
                draggable
                data-effect-id={fx.id}
                className={`device-chain-item${activeDeviceId === fx.id ? " active" : ""}${fx.bypassed ? " is-bypassed" : ""}${draggedFxId === fx.id ? " is-dragging" : ""}${dropTargetFxId === fx.id ? " is-drop-target" : ""}`}
                data-family={EFFECT_DEFS[fx.type].category}
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
                <span className="device-chain-index" aria-hidden="true">
                  {hasInstrument ? chainIndex + 1 : chainIndex}
                </span>
                <span className="device-chain-dot" aria-hidden="true" />
                {EFFECT_DEFS[fx.type].name}
              </button>
            ))}
          </div>
        </div>
        {/* The persistent idea input lives on BOTH rack surfaces — the dock
            renders this devices view for the selected track, the classic
            rack below for the mixer-focused flow. */}
        {!isMaster && <FxIntentBar trackId={track.id} />}
        {!isMaster && (
          <SourceMacroDock
            track={track}
            profile={sourceProfile}
            profileIds={SOURCE_PROFILE_IDS}
            loadedEffectIds={sourceEffectIds}
            onSelectProfile={(id) => {
              setSourceProfileId(id);
              setSourceEffectIds([]);
            }}
            onLoadProfile={loadSourceProfile}
            onCommitMacro={commitSourceMacro}
          />
        )}
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
              gainReductionBreakdown={gainReductionBreakdown[selectedFx.id]}
              allowUserImpulseResponses={allowUserImpulseResponses}
              expanded
              devicesMode
            />
          ) : (
            <EmptyState
              icon="🎛"
              title="No device on this track"
              hint={
                isMaster
                  ? "Add an insert with + FX. It processes the final mix before the safety limiter."
                  : "Add an effect with + FX, or a ready chain with + CHAIN — or describe the sound you want in the idea bar below."
              }
            />
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="fx-rack" aria-label={`Effect rack — ${track.name}`}>
      <div className="fx-rack-header">
        <h2 className="panel-title">FX — {track.name}</h2>
        <button
          type="button"
          className="btn fx-add-trigger"
          onClick={() => setAddOpen((open) => !open)}
          aria-expanded={addOpen}
        >
          ✚ ADD FX
        </button>
      </div>
      <FxIntentBar trackId={track.id} />
      {addOpen && (
        <FxAddPopover
          trackLabel={track.name}
          devices={addableDevices}
          role={role}
          onPick={(type) => {
            services.store.execute(addLanded(type));
            setAddOpen(false);
          }}
          onGoal={(goalText) => {
            const intent = parseProductionIntent(goalText);
            if (!intent) return;
            try {
              services.store.execute(applyProductionIntentToTrackCommand(doc, track.id, intent));
              setGoalNote(null);
              setAddOpen(false);
            } catch (err) {
              setGoalNote(err instanceof Error ? err.message : String(err));
            }
          }}
          onAssistant={(assistantIntent) => {
            // Wave D — the assistant's effect-intent, resolved at TRACK
            // level: finds or adds the best device for the goals, tunes it
            // through their plan/apply pipeline, one undo step.
            try {
              services.store.execute(applyEffectIntentOnTrack(doc, track.id, assistantIntent));
              setGoalNote(null);
              setAddOpen(false);
            } catch (err) {
              setGoalNote(err instanceof Error ? err.message : String(err));
            }
          }}
          onClose={() => setAddOpen(false)}
        />
      )}
      {goalNote && <div className="fx-goal-note">{goalNote}</div>}
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
              gainReductionBreakdown={gainReductionBreakdown[fx.id]}
              allowUserImpulseResponses={allowUserImpulseResponses}
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
  gainReductionBreakdown,
  allowUserImpulseResponses = true,
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
  gainReductionBreakdown?: readonly EffectGainReductionReading[];
  allowUserImpulseResponses?: boolean;
  expanded: boolean;
  /** Omit when the host has no expand state (the devices dock's single editor). */
  onToggleFocus?: () => void;
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
  const isModified =
    Object.keys({ ...defaultParams, ...fx.params }).some(
      (paramId) => (fx.params[paramId] ?? defaultParams[paramId]) !== defaultParams[paramId],
    ) || (fx.outputTrimDb ?? 0) !== 0;
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
  const quickParams = devicesMode ? usableParams.filter(isEffectQuickControlParam) : [];
  const detailParams = devicesMode
    ? usableParams.filter((param) => !quickParams.some((quick) => quick.id === param.id))
    : usableParams;
  const primaryParams = (editorSpec.primaryParamIds ?? [])
    .map((id) => detailParams.find((param) => param.id === id))
    .filter((param): param is (typeof detailParams)[number] => !!param);
  const remainingParams = detailParams.filter((param) => !primaryParams.some((primary) => primary.id === param.id));
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
      data-family={editorSpec.family}
    >
      <div className="fx-device-header">
        {/* Collapse control only exists where the host owns the expand state.
            The devices dock renders one always-expanded editor surface, so a
            toggle there was a button that looked live and did nothing. */}
        {onToggleFocus && (
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
        )}
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
        {allowUserImpulseResponses && fx.type === "ozvena" && irNote === "IR loaded" && (
          <button
            type="button"
            className="btn btn-small fx-ir-load"
            title="Drop the loaded user impulse response (fall back to the factory IR selection)"
            onClick={() => {
              const engine = services.engine as typeof services.engine & {
                clearUserIrForFx?: (trackId: string, fxId: string) => void;
              };
              try {
                engine.clearUserIrForFx?.(track.id, fx.id);
                setIrNote(null);
              } catch (err: unknown) {
                setIrNote(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            CLR
          </button>
        )}
        {allowUserImpulseResponses && fx.type === "ozvena" && (
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
                  .then(() => {
                    setIrNote("IR loaded");
                    // A freshly loaded IR is silent while convolution.mode
                    // is "algorithmic" (the default) — the convolver only
                    // runs in hybrid/convolution mode. Flip to hybrid so
                    // the IR is actually audible; the user can switch back
                    // to algorithmic (or to IR-only) in the VØID panel.
                    // (Reconciled from Pulse Forge audit, 2026-09-19.)
                    const mode = Math.round(fx.params["convolution.mode"] ?? 0);
                    if (mode === 0) {
                      try {
                        services.store.execute(setEffectParam(doc, track.id, fx.id, "convolution.mode", 1));
                      } catch {
                        // Non-fatal: the IR itself is loaded and the mode
                        // can still be flipped manually in the panel.
                      }
                    }
                  })
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
          {devicesMode && (
            <EffectQuickControls
              params={quickParams}
              values={fx.params}
              onChange={(paramId, value) =>
                services.store.execute(
                  fx.type === "morphdynamics"
                    ? setMorphDynamicsParam(doc, track.id, fx.id, paramId, value)
                    : setEffectParam(doc, track.id, fx.id, paramId, value),
                )
              }
            />
          )}
          {fx.type === "prud" && (
            <PrudMaxCutPreview
              params={fx.params}
              sampleRate={services.engine.getLiveAudioContext()?.sampleRate ?? 48_000}
            />
          )}
          {fx.type === "eq" && <EqResponseCurve params={fx.params} />}
          {(fx.type === "limiter" ||
            fx.type === "compressor" ||
            fx.type === "drumBuss" ||
            fx.type === "bassBuss" ||
            fx.type === "apeks") && (
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
          {gainReductionBreakdown && gainReductionBreakdown.length > 0 && (
            <div className="fx-gr-breakdown" role="group" aria-label={`${def.name} stage gain reduction`}>
              {gainReductionBreakdown.map(({ label, gainReductionDb: stageReductionDb }) => (
                <div className="fx-gr-breakdown-row" key={label}>
                  <span className="fx-gr-breakdown-stage">{label}</span>
                  <div className="fx-gr-track" aria-hidden="true">
                    <div className="fx-gr-fill" style={{ width: `${Math.min(100, (stageReductionDb / 12) * 100)}%` }} />
                  </div>
                  <span className="fx-gr-label">{stageReductionDb.toFixed(1)} dB</span>
                </div>
              ))}
            </div>
          )}
          {(fx.type === "sidechain" ||
            fx.type === "compressor" ||
            fx.type === "fxeq" ||
            fx.type === "pump" ||
            fx.type === "morphdynamics") && (
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
                // The blend pad writes two params per gesture step. Without a
                // frame, one drag produced two history entries per pointermove
                // and Ctrl+Z could only peel one param back at a time.
                onGestureStart={() => services.store.beginUndoFrame("Blend pad")}
                onGestureEnd={() => services.store.endUndoFrame()}
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
            {fx.type === "morphdynamics" && (
              <MorphDynamicsPanel
                trackId={track.id}
                fxId={fx.id}
                params={fx.params}
                degraded={!!fallbackReason}
                onParam={(paramId, value) =>
                  services.store.execute(setMorphDynamicsParam(doc, track.id, fx.id, paramId, value))
                }
                onApplyPreset={(name, presetParams) =>
                  services.store.execute(applyMorphDynamicsPreset(doc, track.id, fx.id, name, presetParams))
                }
                scenesState={
                  fx.deviceState?.kind === "morph-scenes-v1"
                    ? (fx.deviceState.data as unknown as MorphScenesState)
                    : undefined
                }
                onScenesStateChange={(next) =>
                  services.store.execute(
                    setDeviceState(doc, track.id, fx.id, { kind: "morph-scenes-v1", data: { ...next } }),
                  )
                }
              />
            )}
          </Suspense>
          {fx.type === "morphdynamics" && (
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
            <span className="fx-output-trim-note">Preset / manual</span>
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

function peakingCutMagnitudeDb(
  freqHz: number,
  centerHz: number,
  q: number,
  gainDb: number,
  sampleRate: number,
): number {
  if (gainDb >= 0) return 0;
  const a = Math.pow(10, gainDb / 40);
  const omega = (2 * Math.PI * freqHz) / sampleRate;
  const centerOmega = (2 * Math.PI * centerHz) / sampleRate;
  const alpha = Math.sin(centerOmega) / (2 * q);
  const cosOmega = Math.cos(omega);
  const sinOmega = Math.sin(omega);
  const cosDoubleOmega = Math.cos(2 * omega);
  const sinDoubleOmega = Math.sin(2 * omega);
  const denominator = 1 + alpha / a;
  const b0 = (1 + alpha * a) / denominator;
  const b1 = (-2 * Math.cos(centerOmega)) / denominator;
  const b2 = (1 - alpha * a) / denominator;
  const a1 = (-2 * Math.cos(centerOmega)) / denominator;
  const a2 = (1 - alpha / a) / denominator;
  const numerator = Math.hypot(b0 + b1 * cosOmega + b2 * cosDoubleOmega, -(b1 * sinOmega + b2 * sinDoubleOmega));
  const denominatorMagnitude = Math.hypot(
    1 + a1 * cosOmega + a2 * cosDoubleOmega,
    -(a1 * sinOmega + a2 * sinDoubleOmega),
  );
  if (denominatorMagnitude < 1e-12) return 0;
  const magnitudeDb = 20 * Math.log10(Math.max(1e-9, numerator / denominatorMagnitude));
  return Number.isFinite(magnitudeDb) ? Math.min(0, magnitudeDb) : 0;
}

function PrudMaxCutPreview({ params, sampleRate }: { params: Record<string, number>; sampleRate: number }) {
  const read = (id: string, fallback: number, min: number, max: number) => {
    const value = params[id];
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const bands = [
    {
      freq: read("freq1", 900, 80, 8000),
      q: read("q1", 2, 0.5, 8),
      cut: read("amount1", -6, -12, 0),
    },
    {
      freq: read("freq2", 3200, 80, 12000),
      q: read("q2", 2, 0.5, 8),
      cut: read("amount2", -6, -12, 0),
    },
  ] as const;
  const points = Array.from({ length: 65 }, (_, index) => {
    const t = index / 64;
    const freq = 20 * Math.pow(1000, t);
    const x = 26 + t * 254;
    const band1Db = peakingCutMagnitudeDb(freq, bands[0].freq, bands[0].q, bands[0].cut, sampleRate);
    const band2Db = peakingCutMagnitudeDb(freq, bands[1].freq, bands[1].q, bands[1].cut, sampleRate);
    return {
      x,
      band1Y: 14 + (Math.min(0, band1Db) / -24) * 58,
      band2Y: 14 + (Math.min(0, band2Db) / -24) * 58,
      combinedY: 14 + (Math.max(-24, Math.min(0, band1Db + band2Db)) / -24) * 58,
    };
  });
  const line = (pick: (point: (typeof points)[number]) => number) =>
    points.map((point) => `${point.x.toFixed(1)},${pick(point).toFixed(1)}`).join(" ");
  const markerX = (freq: number) => 26 + (Math.log10(freq / 20) / 3) * 254;
  const markerY = (cut: number) => 14 + (cut / -24) * 58;

  return (
    <div className="prud-cut-preview">
      <svg
        viewBox="0 0 300 100"
        preserveAspectRatio="none"
        role="img"
        aria-label="PRÚD maximum cut response preview. Dashed lines show each band's maximum cut; the solid line shows their combined maximum response."
      >
        <line x1="26" y1="14" x2="280" y2="14" className="prud-cut-grid" />
        <line x1="26" y1="43" x2="280" y2="43" className="prud-cut-grid" />
        <line x1="26" y1="72" x2="280" y2="72" className="prud-cut-grid" />
        <line x1="26" y1="14" x2="26" y2="72" className="prud-cut-grid" />
        <line x1="280" y1="14" x2="280" y2="72" className="prud-cut-grid" />
        <text x="2" y="17" className="prud-cut-axis-label">
          0 dB
        </text>
        <text x="2" y="46" className="prud-cut-axis-label">
          −12
        </text>
        <text x="2" y="75" className="prud-cut-axis-label">
          −24
        </text>
        <text x="22" y="88" className="prud-cut-axis-label">
          20
        </text>
        <text x="79" y="88" className="prud-cut-axis-label">
          100
        </text>
        <text x="163" y="88" className="prud-cut-axis-label">
          1k
        </text>
        <text x="247" y="88" className="prud-cut-axis-label">
          10k
        </text>
        <text x="280" y="88" textAnchor="end" className="prud-cut-axis-label">
          20k
        </text>
        <polyline points={line((point) => point.band1Y)} className="prud-cut-band prud-cut-band-one" />
        <polyline points={line((point) => point.band2Y)} className="prud-cut-band prud-cut-band-two" />
        <polyline points={line((point) => point.combinedY)} className="prud-cut-combined" />
        <circle cx={markerX(bands[0].freq)} cy={markerY(bands[0].cut)} r="2.5" className="prud-cut-marker-one" />
        <circle cx={markerX(bands[1].freq)} cy={markerY(bands[1].cut)} r="2.5" className="prud-cut-marker-two" />
        <text x="257" y="10" className="prud-cut-axis-label prud-cut-caption">
          MAX CUT
        </text>
      </svg>
      <div className="prud-cut-legend" aria-hidden="true">
        <span className="prud-cut-legend-one">BAND 1</span>
        <span className="prud-cut-legend-two">BAND 2</span>
        <span className="prud-cut-legend-combined">COMBINED</span>
      </div>
      <p className="prud-cut-help">
        Dashed curves show each band’s maximum cut; live GR meters below show current reduction.
      </p>
    </div>
  );
}

type TrackEffect = Track["effects"][number];
