import type { EffectRuntime } from "../effects/types";
import type { InstrumentRuntime } from "../instruments/types";
import type { AutomationTarget, ProjectDocument } from "../project-model/types";
import { clampTargetValue, targetOwner, targetParamDef } from "../project-model/targets";
import { MASTER_EFFECT_OWNER_ID } from "../project-model/types";

/**
 * DeviceLookup — Wave 4d (step 1) of the AudioEngine decomposition
 * (docs/AUDIOENGINE-DECOMPOSITION-PLAN.md).
 *
 * The five shared device-target resolvers: AudioParam lookup for
 * audio-rate modulation, effect/instrument runtime lookup, persisted
 * base-value read, and the single clamped device-parameter write path used
 * by macros, modulators, automation and MIDI CC. Extracted BEFORE the
 * automation bridge so GraphSync (the engine) and the bridge share ONE
 * resolution source instead of two private copies that can drift.
 *
 * Facade law: this module never imports AudioEngine. The engine's node maps
 * arrive as per-id reader closures (the Map type is invariant, so read-only
 * closures are the clean seam — same shape MeteringRig uses).
 */

/** Narrow read-view of a track/group node's modulation + FX surfaces. */
export interface TrackOrGroupView {
  fx: { runtimes: Map<string, EffectRuntime> };
  modAutoGain: { gain: AudioParam };
  modAutoPan: { pan: AudioParam };
  /** Macro/intensity composer writes (modMacro bus). */
  modMacroGain: { gain: AudioParam };
  modMacroPan: { pan: AudioParam };
  /** Follower modulators tap the host's input to listen to its signal. */
  input: AudioNode;
}

/** Narrow read-view of a return node. */
export interface ReturnView {
  fx: { runtimes: Map<string, EffectRuntime> };
  modAutoGain: { gain: AudioParam };
  /** Return-strip gain (macro composer restores its persisted base). */
  gain: { gain: AudioParam };
  /** Macro composer writes the return's modMacro bus too. */
  modMacroGain: { gain: AudioParam };
  /** Follower modulators tap the return's input to listen to its signal. */
  input: AudioNode;
}

export interface DeviceLookupDeps {
  doc: () => ProjectDocument | null;
  trackNodes: (id: string) => TrackOrGroupView | undefined;
  groupNodes: (id: string) => TrackOrGroupView | undefined;
  returnNodes: (id: string) => ReturnView | undefined;
  masterFx?: () => { runtimes: Map<string, EffectRuntime> } | undefined;
  instrumentStates: () => Map<string, { runtime: InstrumentRuntime }>;
}

export class DeviceLookup {
  constructor(private readonly deps: DeviceLookupDeps) {}

  resolveModTargetParam(target: AutomationTarget): AudioParam | null {
    switch (target.kind) {
      case "trackGain":
      case "trackPan": {
        const nodes = this.deps.trackNodes(target.trackId) ?? this.deps.groupNodes(target.trackId);
        if (nodes) return target.kind === "trackGain" ? nodes.modAutoGain.gain : nodes.modAutoPan.pan;
        const returnNodes = this.deps.returnNodes(target.trackId);
        return returnNodes && target.kind === "trackGain" ? returnNodes.modAutoGain.gain : null;
      }
      case "fxParam": {
        if (!target.fxId || !target.paramId) return null;
        const candidates: Array<{ runtimes: Map<string, EffectRuntime> }> = [];
        const t = this.deps.trackNodes(target.trackId);
        if (t) candidates.push(t.fx);
        const g = this.deps.groupNodes(target.trackId);
        if (g) candidates.push(g.fx);
        const r = this.deps.returnNodes(target.trackId);
        if (r) candidates.push(r.fx);
        if (target.trackId === MASTER_EFFECT_OWNER_ID) {
          const master = this.deps.masterFx?.();
          if (master) candidates.push(master);
        }
        for (const state of candidates) {
          const rt = state.runtimes.get(target.fxId);
          if (rt?.getAudioParam) {
            const p = rt.getAudioParam(target.paramId);
            if (p) return p;
          }
        }
        return null;
      }
      case "instParam":
        return null;
    }
  }

  effectRuntimeForTarget(target: AutomationTarget): EffectRuntime | null {
    if (target.kind !== "fxParam" || !target.fxId) return null;
    const nodes =
      this.deps.trackNodes(target.trackId) ??
      this.deps.groupNodes(target.trackId) ??
      this.deps.returnNodes(target.trackId);
    return (
      nodes?.fx.runtimes.get(target.fxId) ??
      (target.trackId === MASTER_EFFECT_OWNER_ID ? this.deps.masterFx?.()?.runtimes.get(target.fxId) : undefined) ??
      null
    );
  }

  instrumentRuntimeForTarget(target: AutomationTarget): InstrumentRuntime | null {
    if (target.kind !== "instParam") return null;
    return this.deps.instrumentStates().get(target.trackId)?.runtime ?? null;
  }

  /** Current persisted base value for a device target (before modulation). */
  baseValueForTarget(doc: ProjectDocument, target: AutomationTarget): number | null {
    const def = targetParamDef(doc, target);
    if (!def) return null;
    if (target.kind === "fxParam" && target.fxId && target.paramId) {
      const effect = targetOwner(doc, target.trackId)?.effects.find((fx) => fx.id === target.fxId);
      return effect?.params[target.paramId] ?? def.default;
    }
    if (target.kind === "instParam" && target.paramId) {
      const track = targetOwner(doc, target.trackId);
      return track?.kind === "instrument" ? (track.params[target.paramId] ?? def.default) : null;
    }
    return null;
  }

  /**
   * The single device-parameter write path used by macros, modulators and
   * automation. It resolves track/group/return ownership and clamps against
   * the same catalog used by schema + UI before touching a runtime.
   */
  writeDeviceTargetAt(target: AutomationTarget, value: number, when?: number): boolean {
    const doc = this.deps.doc();
    if (!target.paramId) return false;
    // The engine always has a document in production. Keeping the runtime
    // fallback makes the small isolated engine tests useful with injected
    // node maps, while real document-bound writes remain strictly validated.
    if (doc && Array.isArray(doc.tracks) && !targetParamDef(doc, target)) return false;
    const clamped = doc ? clampTargetValue(doc, target, value) : value;
    if (target.kind === "fxParam") {
      const runtime = this.effectRuntimeForTarget(target);
      if (!runtime) return false;
      if (when !== undefined && runtime.setParameterAt) runtime.setParameterAt(target.paramId, clamped, when);
      else runtime.setParameter(target.paramId, clamped);
      return true;
    }
    if (target.kind === "instParam") {
      const runtime = this.instrumentRuntimeForTarget(target);
      if (!runtime) return false;
      if (when !== undefined && runtime.setParameterAt) runtime.setParameterAt(target.paramId, clamped, when);
      else runtime.setParameter(target.paramId, clamped);
      return true;
    }
    return false;
  }
}
