import type { AutomationPoint, AutomationTarget, Lfo, ProjectDocument, SceneAutomation } from "../project-model/types";
import {
  lfoKind,
  lfoWave,
  modulatorEventsInRange,
  modulatorPointValue,
  resolveLfoTarget,
} from "../project-model/modulators";
import { clampTargetValue, targetParamDef } from "../project-model/targets";
import { interpolateAutomationPoints, valueAt } from "../project-model/automation";
import { isWorkletReady } from "../audio-worklets/loader";
import { createEnvFollowerNode, type EnvFollowerHandle } from "../audio-worklets/envfollower-node";
import type { DeviceLookup, TrackOrGroupView, ReturnView } from "./deviceLookup";

/**
 * AutomationBridge — Wave 4d (step 2) of the AudioEngine decomposition
 * (docs/AUDIOENGINE-DECOMPOSITION-PLAN.md).
 *
 * Owns the modulation + automation write layer: LFO runtime state
 * (oscillator + envelope-follower buses), the macro/intensity composer
 * (modMacro* nodes + device offsets around persisted bases), schedulable
 * modulators (random S&H / step), scene-intensity scheduling, scene
 * automation lanes, the realtime/offline automation writers, the stop
 * takeover (automationReset) and MIDI-CC target writes. Device-target
 * resolution goes through the shared DeviceLookup (step 1) — the engine
 * and this bridge never keep private resolver copies.
 *
 * Writer-composition law (one writer per chain): macro/intensity offsets
 * resolve around the PERSISTED doc value; gain/pan offsets accumulate into
 * the dedicated modMacro* nodes; modulators own the modAuto* chain and
 * automation lanes their own writers — nobody else writes those params.
 *
 * Facade law: this module never imports AudioEngine. The engine's node
 * maps arrive as per-id reader closures; everything else is bridge-owned
 * state. VERBATIM move from AudioEngine.ts — same bodies, same clamps,
 * same writer semantics.
 */

const LFO_DIVISION_MULTS = [1 / 4, 1 / 2, 1, 2, 4];

interface OscModRuntime {
  osc: OscillatorNode;
  depth: GainNode;
  signature: string;
  targetParam?: AudioParam | null;
}

interface FollowerModRuntime {
  /** Null when AudioWorklet DSP is unavailable — surfaces as a degraded entry. */
  follower: EnvFollowerHandle | null;
  depth: GainNode | null;
  signature: string;
  targetParam?: AudioParam | null;
  degradedReason?: string;
  /**
   * The source node whose output feeds `follower.input`. `follower.dispose()`
   * only disconnects the follower's OUTGOING edges, so the upstream
   * `source.input → follower.input` edge must be dropped explicitly or the
   * retired worklet node is retained by its source for as long as the source
   * lives (the same leak class compressor/sidechain/vocoder already guard
   * with their own `lastSidechainSource`).
   */
  followerSource?: AudioNode | null;
}

type LfoRuntimeState = OscModRuntime | FollowerModRuntime;

function isOscRuntime(state: LfoRuntimeState): state is OscModRuntime {
  return "osc" in state;
}

function disposeLfoRuntime(state: LfoRuntimeState): void {
  if (isOscRuntime(state)) {
    try {
      state.osc.stop();
    } catch {
      /* not started */
    }
    state.osc.disconnect();
    state.depth.disconnect();
  } else {
    if (state.followerSource) {
      try {
        if (state.follower) state.followerSource.disconnect(state.follower.input);
        else state.followerSource.disconnect();
      } catch {
        /* edge may already be gone */
      }
      state.followerSource = null;
    }
    try {
      state.follower?.dispose();
    } catch {
      /* already disposed */
    }
    if (state.depth) {
      try {
        state.depth.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }
}

function lfoSignature(lfo: Lfo, workletAvailable?: boolean): string {
  const kind = lfo.kind ?? "osc";
  const parts: (string | number)[] = [kind, lfo.trackId, lfo.param, lfo.amount];
  if (lfo.target) {
    parts.push(`t:${lfo.target.kind}:${lfo.target.trackId}:${lfo.target.fxId ?? ""}:${lfo.target.paramId ?? ""}`);
  }
  if (kind === "osc") {
    parts.push(lfo.wave ?? "", lfo.rateMode ?? "", lfo.rateHz ?? 0, lfo.division ?? 0);
  } else if (kind === "envFollower") {
    parts.push(lfo.sourceTrackId ?? lfo.trackId, lfo.attackMs ?? 0, lfo.releaseMs ?? 0, lfo.sensitivity ?? 0);
    if (workletAvailable !== undefined) parts.push(`ok:${workletAvailable ? 1 : 0}`);
    const pol = lfo.polarity === 1 ? "swell" : "duck";
    parts.push(pol);
  }
  return parts.join("|");
}

/**
 * Expand a scene-relative automation lane to absolute-tick events for one
 * window: interpolated boundary values plus every interior lane point
 * (mirrors the offline scheduleSceneAutomation expansion). Pure —
 * unit-tested; the live lane writer and any future caller share it.
 */
export function expandSceneLaneWindow(
  lane: { points: AutomationPoint[] },
  fromTick: number,
  toTick: number,
  sceneStartTick: number,
): Array<{ tick: number; value: number }> {
  const valueAtLocal = (tick: number): number => {
    if (lane.points.length === 0) return 0;
    if (tick <= lane.points[0].tick) return lane.points[0].value;
    if (tick >= lane.points[lane.points.length - 1].tick) return lane.points[lane.points.length - 1].value;
    for (let i = 0; i < lane.points.length - 1; i++) {
      const a = lane.points[i];
      const b = lane.points[i + 1];
      if (tick >= a.tick && tick <= b.tick) {
        const span = b.tick - a.tick;
        if (span <= 0) return a.value;
        return a.value + ((b.value - a.value) * (tick - a.tick)) / span;
      }
    }
    return lane.points[lane.points.length - 1].value;
  };
  const expanded = [
    { tick: fromTick, value: valueAtLocal(Math.max(0, fromTick - sceneStartTick)) },
    { tick: toTick, value: valueAtLocal(Math.max(0, toTick - sceneStartTick)) },
  ];
  const sorted = [...lane.points].sort((a, b) => a.tick - b.tick);
  for (const point of sorted) {
    const absoluteTick = sceneStartTick + point.tick;
    if (absoluteTick > fromTick && absoluteTick < toTick) {
      expanded.push({ tick: absoluteTick, value: point.value });
    }
  }
  expanded.sort((a, b) => a.tick - b.tick);
  return expanded;
}

export interface AutomationBridgeDeps {
  ctx: () => BaseAudioContext | null;
  doc: () => ProjectDocument | null;
  currentTime: () => number;
  /** Read-only node-map views (per-id gets + whole-map iteration for resets). */
  trackNodes: Map<string, TrackOrGroupView>;
  groupNodes: Map<string, TrackOrGroupView>;
  returnNodes: Map<string, ReturnView>;
}

export class AutomationBridge {
  private lfos = new Map<string, LfoRuntimeState>();
  private macroCache = new Map<string, { gain: number; pan: number }>();
  private currentSceneIntensity = 0.7;

  constructor(
    private readonly deps: AutomationBridgeDeps,
    private readonly lookup: DeviceLookup,
  ) {}

  /** Diagnostics + degraded-reporting surface. */
  get lfoCount(): number {
    return this.lfos.size;
  }

  degradedLfos(): Array<{ id: string; reason: string }> {
    const out: Array<{ id: string; reason: string }> = [];
    for (const [id, state] of this.lfos) {
      if (!isOscRuntime(state) && state.degradedReason) out.push({ id, reason: state.degradedReason });
    }
    return out;
  }

  /** Hard dispose of every LFO runtime (context swap / panic paths). */
  disposeLfos(): void {
    for (const state of [...this.lfos.values()]) disposeLfoRuntime(state);
    this.lfos.clear();
  }

  clearMacroCache(): void {
    this.macroCache.clear();
  }

  private lfoFrequency(lfo: Lfo): number {
    if (lfo.rateMode === "hz") return Math.max(0.01, lfo.rateHz ?? 2);
    const bpm = this.deps.doc()?.bpm ?? 124;
    const mult =
      LFO_DIVISION_MULTS[Math.max(0, Math.min(LFO_DIVISION_MULTS.length - 1, Math.round(lfo.division ?? 2)))];
    return Math.max(0.01, (bpm / 60) * mult);
  }

  private modulationDepthForTarget(lfo: Lfo, target: AutomationTarget): number {
    const amount = lfo.amount ?? 0.3;
    if (target.kind === "trackGain" || target.kind === "trackPan") {
      // Additive bipolar/unipolar around the native param (base 1 / 0). Keep range tight.
      return amount;
    }
    // fxParam / instParam — scale to half the param's declared range so
    // amount=1 sweeps roughly the full range. This matches the polling writer's
    // `def.min + (range/2)*(1+value)` absolute mapping but keeps the user's
    // base param as the centre for additive modulation.
    const doc = this.deps.doc();
    const def = doc ? targetParamDef(doc, target) : null;
    const range = def ? def.max - def.min : 1;
    return (range / 2) * amount;
  }

  /**
   * Runtime kinds only — oscillators (audio-rate) and envelope followers
   * (worklet). Random / step modulators are event-scheduled in
   * applyModulators/scheduleModulatorsOffline and need no graph node.
   * P2 bus: oscillators and followers can now drive ANY AutomationTarget whose
   * effect runtime exposes an AudioParam (see EffectRuntime.getAudioParam).
   * Targets without an AudioParam (instruments, fallback Worklet) keep the
   * polling path via applyEnvFollowersToParams.
   */
  syncLfos(doc: ProjectDocument): void {
    const ctx = this.deps.ctx();
    if (!ctx) return;
    const runtimeIds = new Set<string>();
    for (const lfo of doc.lfos) {
      const kind = lfoKind(lfo);
      if (kind === "osc" || kind === "envFollower") runtimeIds.add(lfo.id);
    }
    for (const [id, state] of [...this.lfos]) {
      if (!runtimeIds.has(id)) {
        disposeLfoRuntime(state);
        this.lfos.delete(id);
      }
    }
    for (const lfo of doc.lfos) {
      const kind = lfoKind(lfo);
      if (kind !== "osc" && kind !== "envFollower") continue;
      const hostNodes =
        this.deps.trackNodes.get(lfo.trackId) ??
        this.deps.groupNodes.get(lfo.trackId) ??
        this.deps.returnNodes.get(lfo.trackId);
      // Host may be a return track (for return-targeted bus); allow any nodes.
      if (!hostNodes && kind === "osc" && lfoKind(lfo) === "osc" && !lfo.target) continue;
      if (!hostNodes && !resolveLfoTarget(lfo)) continue;
      const target = resolveLfoTarget(lfo);
      // ProjectStore local commands can reach the engine before a full
      // normalization pass. Never let a stale/deleted FX id fall through to
      // the runtime lookup or accidentally bind an LFO to a different chain.
      if (!targetParamDef(doc, target)) continue;
      // Resolve the AudioParam for the bus connection. For trackGain/pan it is
      // always present when the host track exists; for FX it is null until the
      // effect runtime is built (or when the param has no AudioParam exposure).
      const destParam = this.lookup.resolveModTargetParam(target);

      if (kind === "osc") {
        const sig = lfoSignature(lfo);
        const existing = this.lfos.get(lfo.id);
        const paramMatches = existing && (existing as OscModRuntime).targetParam === destParam;
        if (existing && isOscRuntime(existing) && existing.signature === sig && paramMatches) {
          // BPM-synced rate may have drifted — keep frequency live.
          const freq = this.lfoFrequency(lfo);
          if (Math.abs(existing.osc.frequency.value - freq) > 1e-6) {
            try {
              existing.osc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.05);
            } catch {
              /* best effort */
            }
          }
          continue;
        }
        if (existing) disposeLfoRuntime(existing);
        if (!destParam) {
          (this.lfos as Map<string, LfoRuntimeState>).set(lfo.id, {
            follower: null,
            depth: null,
            signature: sig,
            targetParam: null,
            degradedReason: "Modulation target has no audio-rate param — LFO idle",
          } as unknown as FollowerModRuntime);
          continue;
        }
        const wave = lfoWave(lfo);
        const osc = ctx.createOscillator();
        osc.type = wave === "sawUp" || wave === "sawDown" ? "sawtooth" : wave;
        osc.frequency.value = this.lfoFrequency(lfo);
        const depth = ctx.createGain();
        const sign = wave === "sawDown" ? -1 : 1;
        const scale = this.modulationDepthForTarget(lfo, target);
        // For native track params scale is already 0..1 (amount); for FX it is range/2*amount
        const isFx = target.kind === "fxParam" || target.kind === "instParam";
        depth.gain.value = sign * (isFx ? scale : lfo.amount);
        osc.connect(depth).connect(destParam);
        osc.start();
        this.lfos.set(lfo.id, { osc, depth, signature: sig, targetParam: destParam });
        continue;
      }

      // envFollower: detector taps the SOURCE track's input (pre-FX/pre-gain)
      // so a follower listening to its own host can never form a feedback loop.
      const available = isWorkletReady("envFollower", ctx);
      const sourceTrackId =
        typeof lfo.sourceTrackId === "string" && lfo.sourceTrackId !== "" ? lfo.sourceTrackId : lfo.trackId;
      const sourceNodes =
        this.deps.trackNodes.get(sourceTrackId) ??
        this.deps.groupNodes.get(sourceTrackId) ??
        this.deps.returnNodes.get(sourceTrackId);
      if (!sourceNodes) continue;
      const sig = lfoSignature(lfo, available);
      const existing = this.lfos.get(lfo.id);
      const paramMatches =
        existing && !isOscRuntime(existing) && (existing as FollowerModRuntime).targetParam === destParam;
      if (existing && !isOscRuntime(existing) && existing.signature === sig && paramMatches) continue;
      if (existing) disposeLfoRuntime(existing);
      if (!available) {
        this.lfos.set(lfo.id, {
          follower: null,
          depth: null,
          signature: sig,
          targetParam: destParam,
          degradedReason: "AudioWorklet unavailable — envelope follower idle",
        });
        continue;
      }
      const follower = createEnvFollowerNode(ctx, {
        params: {
          attackMs: lfo.attackMs ?? 12,
          releaseMs: lfo.releaseMs ?? 180,
          sensitivity: lfo.sensitivity ?? 1.5,
        },
      });
      sourceNodes.input.connect(follower.input);
      // If the bus can drive an AudioParam, wire audio-rate path; otherwise
      // keep the follower alive for the polling path (applyEnvFollowersToParams).
      if (destParam) {
        const depth = ctx.createGain();
        const isFx = target.kind === "fxParam" || target.kind === "instParam";
        const scale = this.modulationDepthForTarget(lfo, target);
        const polarity = lfo.polarity === 1 ? 1 : -1;
        depth.gain.value = polarity * (isFx ? scale : lfo.amount);
        follower.output.connect(depth).connect(destParam);
        this.lfos.set(lfo.id, {
          follower,
          depth,
          signature: sig,
          targetParam: destParam,
          followerSource: sourceNodes.input,
        });
      } else {
        // No AudioParam — follower posts envelope via port, polling will apply to FX/inst params.
        // Keep the depth null but preserve the follower for getEnvelope().
        // A dummy gain keeps the type uniform; not connected anywhere.
        this.lfos.set(lfo.id, {
          follower,
          depth: null,
          signature: sig,
          targetParam: null,
          followerSource: sourceNodes.input,
        });
      }
    }
  }

  syncMacros(doc: ProjectDocument): void {
    const ctx = this.deps.ctx();
    if (!ctx) return;
    const next = new Map<string, { gain: number; pan: number }>();
    for (const track of doc.tracks) {
      next.set(track.id, { gain: 1, pan: 0 });
    }
    for (const ret of doc.returns) {
      next.set(ret.id, { gain: 1, pan: 0 });
    }
    const deviceOffsets = new Map<string, { target: AutomationTarget; delta: number }>();
    // Writer composition rule (one writer per chain):
    // - macro/intensity performance offsets resolve FX/inst params as
    //   base ± half-range·bipolar·amount around the PERSISTED doc value —
    //   repeated syncs can never accumulate;
    // - gain/pan offsets accumulate into the dedicated modMacro* nodes;
    // - modulators (LFO/step/S&H) own the modAuto* chain and automation
    //   lanes their own writers — nobody else writes those params.
    const applyToTarget = (
      target: import("../project-model/types").AutomationTarget,
      bipolar: number,
      amount: number,
    ): void => {
      if (target.kind === "trackGain" || target.kind === "trackPan") {
        const acc = next.get(target.trackId);
        if (!acc) return;
        if (target.kind === "trackGain") acc.gain += amount * bipolar;
        else acc.pan += amount * bipolar;
        return;
      }
      if (target.kind === "fxParam") {
        if (!target.fxId || !target.paramId) return;
        const def = targetParamDef(doc, target);
        if (!def) return;
        const delta = ((def.max - def.min) / 2) * bipolar * amount;
        const key = `fx:${target.trackId}:${target.fxId}:${target.paramId}`;
        const existing = deviceOffsets.get(key);
        if (existing) existing.delta += delta;
        else deviceOffsets.set(key, { target: { ...target }, delta });
        return;
      }
      if (target.kind === "instParam") {
        if (!target.paramId) return;
        const def = targetParamDef(doc, target);
        if (!def) return;
        const delta = ((def.max - def.min) / 2) * bipolar * amount;
        const key = `inst:${target.trackId}:${target.paramId}`;
        const existing = deviceOffsets.get(key);
        if (existing) existing.delta += delta;
        else deviceOffsets.set(key, { target: { ...target }, delta });
      }
    };
    const intensityBipolar = Math.max(-1, Math.min(1, this.currentSceneIntensity * 2 - 1));
    for (const macro of doc.macros) {
      const bipolar = Math.max(-1, Math.min(1, macro.value * 2 - 1));
      for (const mapping of macro.mappings) {
        const amount = mapping.amount;
        if (mapping.source === "intensity") {
          // Scene intensity drives ANY target; gain/pan accumulate via next map.
          if (mapping.target) applyToTarget(mapping.target, intensityBipolar, amount);
          else {
            if (mapping.param !== "gain" && mapping.param !== "pan") continue;
            const acc = next.get(mapping.trackId);
            if (!acc) continue;
            if (mapping.param === "gain") acc.gain += amount * intensityBipolar;
            else acc.pan += amount * intensityBipolar;
          }
          continue;
        }
        // source "macro" (and legacy midiCC): bipolar from THIS macro's value.
        // Generic target (P2 bus) takes precedence over legacy trackId/param.
        if (mapping.target) {
          applyToTarget(mapping.target, bipolar, amount);
          continue;
        }
        if (mapping.param !== "gain" && mapping.param !== "pan") continue;
        const acc = next.get(mapping.trackId);
        if (!acc) continue;
        if (mapping.param === "gain") acc.gain += amount * bipolar;
        else acc.pan += amount * bipolar;
      }
    }
    // Device mappings compose before the single runtime write. This prevents
    // two macros/intensity mappings to the same deep parameter from silently
    // overwriting each other in iteration order.
    for (const { target, delta } of deviceOffsets.values()) {
      const base = this.lookup.baseValueForTarget(doc, target);
      if (base !== null) this.lookup.writeDeviceTargetAt(target, base + delta);
    }
    for (const [trackId, offsets] of next) {
      // Gain offsets had no ceiling: N stacked macros × full-positive mappings
      // composed an unbounded channel multiplier (runaway gain). Cap at 2
      // (+6 dB) — a single full-depth mapping still lands exactly at 2, so
      // existing projects are unchanged; only pathological stacking is bounded.
      const gain = Math.min(2, Math.max(0, offsets.gain));
      const pan = Math.min(1, Math.max(-1, offsets.pan));
      const cached = this.macroCache.get(trackId);
      if (cached && cached.gain === gain && cached.pan === pan) continue;
      const nodes = this.deps.trackNodes.get(trackId) ?? this.deps.groupNodes.get(trackId);
      const returnNodes = this.deps.returnNodes.get(trackId);
      if (nodes) {
        nodes.modMacroGain.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
        nodes.modMacroPan.pan.setTargetAtTime(pan, ctx.currentTime, 0.01);
      } else if (returnNodes) {
        const returnTrack = doc.returns.find((ret) => ret.id === trackId);
        if (returnTrack) {
          const baseGain = Number.isFinite(returnTrack.gain) ? Math.min(1.5, Math.max(0, returnTrack.gain)) : 0.9;
          returnNodes.gain.gain.setTargetAtTime(baseGain, ctx.currentTime, 0.01);
          returnNodes.modMacroGain.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
        }
      }
      this.macroCache.set(trackId, { gain, pan });
    }
    for (const trackId of [...this.macroCache.keys()]) {
      if (!next.has(trackId)) this.macroCache.delete(trackId);
    }
  }

  /** Update the live scene intensity signal. Idempotent. */
  setSceneIntensity(value: number): void {
    const next = Math.max(0, Math.min(1, value));
    if (next === this.currentSceneIntensity) return;
    this.currentSceneIntensity = next;
    // The signal is a live modulation source, not merely UI state. Recompose
    // the same macro writer immediately so scheduler intensity changes are
    // audible in realtime and use the exact same mapping semantics as export.
    const doc = this.deps.doc();
    if (doc) this.syncMacros(doc);
  }

  /**
   * Schedule the scene-intensity macro bus for offline rendering. The live
   * scheduler updates this signal at control rate; an offline render must
   * write the same composed macro/intensity values onto the audio timeline or
   * exports will silently stay at the default 0.7 intensity.
   */
  scheduleSceneIntensity(points: Array<{ tick: number; value: number }>, timeAt: (tick: number) => number): void {
    const ctx = this.deps.ctx();
    const doc = this.deps.doc();
    if (!ctx || !doc || points.length === 0) return;

    const ordered = points
      .filter((point) => Number.isFinite(point.tick) && Number.isFinite(point.value))
      .slice()
      .sort((a, b) => a.tick - b.tick);
    for (const point of ordered) {
      const next = new Map<string, { gain: number; pan: number }>();
      for (const track of doc.tracks) next.set(track.id, { gain: 1, pan: 0 });
      for (const ret of doc.returns) next.set(ret.id, { gain: 1, pan: 0 });

      const deviceOffsets = new Map<string, { target: AutomationTarget; delta: number }>();
      const applyToTarget = (target: AutomationTarget, bipolar: number, amount: number): void => {
        if (target.kind === "trackGain" || target.kind === "trackPan") {
          const acc = next.get(target.trackId);
          if (!acc) return;
          if (target.kind === "trackGain") acc.gain += amount * bipolar;
          else acc.pan += amount * bipolar;
          return;
        }
        if (target.kind !== "fxParam" && target.kind !== "instParam") return;
        if (!target.paramId) return;
        const def = targetParamDef(doc, target);
        if (!def) return;
        const delta = ((def.max - def.min) / 2) * bipolar * amount;
        const key = `${target.kind}:${target.trackId}:${target.fxId ?? ""}:${target.paramId}`;
        const existing = deviceOffsets.get(key);
        if (existing) existing.delta += delta;
        else deviceOffsets.set(key, { target: { ...target }, delta });
      };

      const intensityBipolar = Math.max(-1, Math.min(1, point.value * 2 - 1));
      for (const macro of doc.macros) {
        const macroBipolar = Math.max(-1, Math.min(1, macro.value * 2 - 1));
        for (const mapping of macro.mappings) {
          const bipolar = mapping.source === "intensity" ? intensityBipolar : macroBipolar;
          if (mapping.target) {
            applyToTarget(mapping.target, bipolar, mapping.amount);
            continue;
          }
          if (mapping.param !== "gain" && mapping.param !== "pan") continue;
          const acc = next.get(mapping.trackId);
          if (!acc) continue;
          if (mapping.param === "gain") acc.gain += mapping.amount * bipolar;
          else acc.pan += mapping.amount * bipolar;
        }
      }

      const mappedTime = timeAt(point.tick);
      const when = Math.max(ctx.currentTime, Number.isFinite(mappedTime) ? mappedTime : ctx.currentTime);
      for (const { target, delta } of deviceOffsets.values()) {
        const base = this.lookup.baseValueForTarget(doc, target);
        if (base !== null) this.lookup.writeDeviceTargetAt(target, base + delta, when);
      }
      for (const [trackId, offsets] of next) {
        const gain = Math.max(0, offsets.gain);
        const pan = Math.min(1, Math.max(-1, offsets.pan));
        const nodes = this.deps.trackNodes.get(trackId) ?? this.deps.groupNodes.get(trackId);
        const returnNodes = this.deps.returnNodes.get(trackId);
        if (nodes) {
          nodes.modMacroGain.gain.setTargetAtTime(gain, when, 0.008);
          nodes.modMacroPan.pan.setTargetAtTime(pan, when, 0.008);
        } else if (returnNodes) {
          returnNodes.modMacroGain.gain.setTargetAtTime(gain, when, 0.008);
        }
      }
    }
  }

  /**
   * Apply a scene automation lane within an absolute tick window. The lane
   * is scene-relative, so we interpolate scene-local ticks and dispatch the
   * resulting target/value to the existing track / FX / instrument pipeline.
   * Interior lane points inside the window are written at their exact ticks
   * (same boundary+interior rule the offline scheduleSceneAutomation uses) —
   * endpoint-only collapse played dense sweeps as straight lines live.
   */
  applySceneAutomationLane(
    lane: SceneAutomation,
    fromTick: number,
    toTick: number,
    sceneStartTick: number,
    scheduleOffsetSec = 0,
    timeAt?: (tick: number) => number,
  ): void {
    if (lane.points.length === 0 || fromTick >= toTick) return;
    const t0Local = Math.max(0, fromTick - sceneStartTick);
    const t1Local = Math.max(0, toTick - sceneStartTick);
    const valueAt = (tick: number) => {
      if (tick <= lane.points[0].tick) return lane.points[0].value;
      if (tick >= lane.points[lane.points.length - 1].tick) return lane.points[lane.points.length - 1].value;
      for (let i = 0; i < lane.points.length - 1; i++) {
        const a = lane.points[i];
        const b = lane.points[i + 1];
        if (tick >= a.tick && tick <= b.tick) {
          const span = b.tick - a.tick;
          if (span <= 0) return a.value;
          const t = (tick - a.tick) / span;
          return a.value + (b.value - a.value) * t;
        }
      }
      return lane.points[lane.points.length - 1].value;
    };
    const v0 = valueAt(t0Local);
    const v1 = valueAt(t1Local);
    this.applyLane(lane, v0, v1, fromTick, toTick, scheduleOffsetSec, timeAt);
    // Interior expansion (offline parity): every lane point strictly inside
    // the window lands at its exact tick through the same tick→time map.
    const ctx = this.deps.ctx();
    if (ctx && timeAt) {
      const offset = Number.isFinite(scheduleOffsetSec) ? scheduleOffsetSec : 0;
      for (const ev of expandSceneLaneWindow(lane, fromTick, toTick, sceneStartTick)) {
        if (ev.tick <= fromTick || ev.tick >= toTick) continue;
        const when = timeAt(ev.tick);
        if (!Number.isFinite(when)) continue;
        this.writeAutomationTargetAt(lane.target, ev.value, Math.max(ctx.currentTime, when + offset));
      }
    }
  }

  /** Apply a single automation lane directly (not via doc.automation). */
  private applyLane(
    lane: { id: string; target: import("../project-model/types").AutomationTarget; points: AutomationPoint[] },
    v0: number,
    v1: number,
    fromTick: number,
    toTick: number,
    scheduleOffsetSec = 0,
    timeAt?: (tick: number) => number,
  ): void {
    const ctx = this.deps.ctx();
    if (!ctx) return;
    const offset = Number.isFinite(scheduleOffsetSec) ? scheduleOffsetSec : 0;
    const t0Fallback = Math.max(ctx.currentTime, ctx.currentTime + offset);
    const t1Fallback = Math.max(t0Fallback, this.deps.currentTime() + 0.1 + offset);
    let t0 = t0Fallback;
    let t1 = t1Fallback;
    if (timeAt) {
      const mapped0 = timeAt(fromTick);
      const mapped1 = timeAt(toTick);
      if (Number.isFinite(mapped0) && Number.isFinite(mapped1)) {
        t0 = Math.max(ctx.currentTime, mapped0 + offset);
        t1 = Math.max(t0, mapped1 + offset);
      }
    }
    this.writeAutomationTargetAt(lane.target, v0, t0);
    this.writeAutomationTargetAt(lane.target, v1, t1);
  }

  /**
   * Deterministic schedulable-modulator pass (random S&H / step generators).
   * Contributors sharing a target compose ADDITIVELY: corner values merge into
   * a piecewise-linear chain written onto the destination, so natives read
   * `base + Σ contributions` (audio-rate oscillators keep adding on top) and
   * device params land mid-range relative to their ParamDef spans. The same
   * routine serves live playback (whenFor anchored to the transport) and
   * offline rendering (timeAt absolute), which keeps parity by construction.
   */
  applyModulators(fromTick: number, toTick: number, whenFor: (tick: number) => number): void {
    const ctx = this.deps.ctx();
    const doc = this.deps.doc();
    if (!ctx || !doc) return;
    const from = Math.max(0, fromTick);
    const to = Math.max(from, toTick);

    interface ModGroup {
      target: AutomationTarget;
      members: Lfo[];
    }
    const groups = new Map<string, ModGroup>();
    for (const lfo of doc.lfos) {
      const kind = lfoKind(lfo);
      if (kind !== "random" && kind !== "step") continue;
      const target = resolveLfoTarget(lfo);
      const key = `${target.kind}:${target.trackId}:${target.fxId ?? ""}:${target.paramId ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = { target, members: [] };
        groups.set(key, group);
      }
      group.members.push(lfo);
    }
    if (groups.size === 0) return;

    for (const [, group] of groups) {
      const streams = group.members.map((member) => ({ member, events: modulatorEventsInRange(member, from, to) }));
      const times = new Set<number>([from, to]);
      for (const stream of streams) {
        for (const event of stream.events) times.add(event.tick);
      }
      const sorted = [...times].sort((a, b) => a - b);

      const compositeAt = (tick: number): number => {
        let total = 0;
        for (const stream of streams) total += modulatorPointValue(stream.member, tick) * stream.member.amount;
        return total;
      };

      const write = this.makeModulatorWriter(group.target);
      if (!write) continue;

      // Audit 06 D1: honor each event's mode — modulatorEventsInRange emits
      // "set" for hard holds (S&H) and "ramp" for glides, but the loop wrote
      // "ramp" for every non-first event, so Hold-mode S&H glided across the
      // entire hold interval (the Hold/Glide toggle was audibly near-no-op).
      // A composite tick inherits "set" when ANY stream holds there.
      const modeAtTick = new Map<number, "set" | "ramp">();
      for (const stream of streams) {
        for (const event of stream.events) {
          if (event.mode === "set" || !modeAtTick.has(event.tick)) modeAtTick.set(event.tick, event.mode);
        }
      }

      let isFirst = true;
      for (const tick of sorted) {
        const when = Math.max(ctx.currentTime, whenFor(tick));
        const mode = isFirst ? "set" : (modeAtTick.get(tick) ?? "ramp");
        write(compositeAt(tick), mode, when);
        isFirst = false;
      }
    }
  }

  /**
   * Builds a clamped writer for one modulation target. Natives write absolute
   * composited values; device params scale the contribution around the
   * parameter's mid-point using its registry definition.
   */
  private makeModulatorWriter(
    target: AutomationTarget,
  ): ((value: number, mode: "set" | "ramp", when: number) => void) | null {
    switch (target.kind) {
      case "trackGain":
      case "trackPan": {
        const nodes = this.deps.trackNodes.get(target.trackId) ?? this.deps.groupNodes.get(target.trackId);
        const returnNodes = this.deps.returnNodes.get(target.trackId);
        if (!nodes && !returnNodes) return null;
        const param = nodes
          ? target.kind === "trackGain"
            ? nodes.modAutoGain.gain
            : nodes.modAutoPan.pan
          : returnNodes!.modAutoGain.gain;
        // Gain modulators swing the channel multiplier around base 1; the
        // ceiling matches the authoritative gain domain (0..1.5) so no writer
        // can push a channel past what a fader could legally reach.
        const clamp =
          target.kind === "trackGain"
            ? (v: number) => Math.max(0, Math.min(1.5, 1 + v))
            : (v: number) => Math.max(-1, Math.min(1, v));
        return (value, mode, when) => {
          try {
            if (mode === "set") param.setValueAtTime(clamp(value), when);
            else param.linearRampToValueAtTime(clamp(value), when);
          } catch {
            /* overlapping automations — best effort */
          }
        };
      }
      case "fxParam":
      case "instParam": {
        const paramId = target.paramId;
        if (!paramId) return null;
        return (value, _mode, when) => {
          try {
            const doc = this.deps.doc();
            const def = doc ? targetParamDef(doc, target) : null;
            const base = doc ? this.lookup.baseValueForTarget(doc, target) : null;
            if (!def || base === null) return;
            const mapped = base + (def.max - def.min) * 0.5 * value;
            this.lookup.writeDeviceTargetAt(target, mapped, when);
          } catch {
            /* best effort */
          }
        };
      }
    }
  }

  /** Offline hook — renderer sweeps every window with absolute time mapping. */
  scheduleModulatorsOffline(windows: { from: number; to: number }[], timeAt: (tick: number) => number): void {
    for (const win of windows) this.applyModulators(win.from, win.to, timeAt);
  }

  /**
   * Poll envFollower modulators and apply their envelope to FX/inst param
   * targets that could not be wired at audio-rate (no AudioParam exposure).
   * Called from the scheduler's applyModulators hook (~25 ms refresh).
   * Volume/Pan and any FX with an AudioParam are driven by the audio graph
   * in syncLfos and must NOT be double-driven here.
   */
  applyEnvFollowersToParams(): void {
    const ctx = this.deps.ctx();
    const doc = this.deps.doc();
    if (!ctx || !doc) return;
    for (const lfo of doc.lfos) {
      if (lfoKind(lfo) !== "envFollower") continue;
      const target = resolveLfoTarget(lfo);
      if (target.kind === "trackGain" || target.kind === "trackPan") continue;
      const state = this.lfos.get(lfo.id);
      if (!state || isOscRuntime(state)) continue;
      const runtime = state as FollowerModRuntime;
      // If this follower is already wired audio-rate to an FX AudioParam, the
      // graph drives it — polling would double-modulate.
      if (runtime.targetParam) continue;
      const follower = runtime.follower;
      if (!follower || !follower.getEnvelope) continue;
      const env = (follower as EnvFollowerHandle).getEnvelope();
      if (!Number.isFinite(env) || env <= 0) continue;

      // Map envelope 0..1 to bipolar −1..1 for the existing writer.
      const bipolar = env * 2 - 1;
      const writer = this.makeModulatorWriter(target);
      if (writer) writer(bipolar * lfo.amount, "set", ctx.currentTime);
    }
  }

  /** Shared target writer for realtime and offline automation. */
  private writeAutomationTargetAt(target: AutomationTarget, value: number, when: number): void {
    const doc = this.deps.doc();
    if (doc && Array.isArray(doc.tracks) && !targetParamDef(doc, target)) return;
    if (target.kind === "trackGain" || target.kind === "trackPan") {
      const trackNodes = this.deps.trackNodes.get(target.trackId) ?? this.deps.groupNodes.get(target.trackId);
      const returnNodes = this.deps.returnNodes.get(target.trackId);
      if (target.kind === "trackGain" && returnNodes) {
        returnNodes.modAutoGain.gain.setTargetAtTime(Math.max(0, Math.min(1.5, value)), when, 0.008);
      } else if (trackNodes && target.kind === "trackGain") {
        // Authoritative range is targetParamDef (0..1.5) — the historical 2
        // here let an imported lane push a channel +6 dB past every other
        // gain surface (fader, send, return all clamp at 1.5).
        trackNodes.modAutoGain.gain.setTargetAtTime(Math.max(0, Math.min(1.5, value)), when, 0.008);
      } else if (trackNodes && target.kind === "trackPan") {
        trackNodes.modAutoPan.pan.setTargetAtTime(Math.min(1, Math.max(-1, value)), when, 0.008);
      }
      return;
    }
    this.lookup.writeDeviceTargetAt(target, value, when);
  }

  applyAutomation(
    fromTick: number,
    toTick: number,
    relOf: (tick: number) => number,
    scheduleOffsetSec = 0,
    timeAt?: (tick: number) => number,
  ): void {
    const ctx = this.deps.ctx();
    const doc = this.deps.doc();
    if (!ctx || !doc || doc.automation.length === 0) return;
    const offset = Number.isFinite(scheduleOffsetSec) ? scheduleOffsetSec : 0;
    // Tick-mapped writes (release roadmap 2.3): when the scheduler supplies
    // its tick→time map, the lane endpoints land at the events' musical
    // times — contiguous windows then produce a continuous param timeline
    // (v1 of window N == v0 of window N+1, same time, same value), which
    // also removes the stale setTargetAtTime override of the old
    // wall-clock staircase. Wall-clock fallback stays for callers without
    // a map.
    const t0Fallback = Math.max(ctx.currentTime, ctx.currentTime + offset);
    const t1Fallback = Math.max(t0Fallback, this.deps.currentTime() + 0.1 + offset);
    let t0 = t0Fallback;
    let t1 = t1Fallback;
    if (timeAt) {
      const mapped0 = timeAt(fromTick);
      const mapped1 = timeAt(toTick);
      if (Number.isFinite(mapped0) && Number.isFinite(mapped1)) {
        t0 = Math.max(ctx.currentTime, mapped0 + offset);
        t1 = Math.max(t0, mapped1 + offset);
      }
    }
    for (const lane of doc.automation) {
      if (lane.points.length === 0) continue;
      const fallback =
        targetParamDef(doc, lane.target)?.default ??
        (lane.target.kind === "trackGain" ? 1 : lane.target.kind === "trackPan" ? 0 : 0);
      const rel0 = relOf(fromTick);
      const rel1 = relOf(toTick);
      const v0 = valueAt(lane.points, rel0, fallback);
      const v1 = valueAt(lane.points, rel1, fallback);
      this.writeAutomationTargetAt(lane.target, v0, t0);
      // Audit 06 D2: interior points inside this window must land in the
      // realtime timeline — the offline renderer expands them, so writing
      // only the endpoints played dense sweeps/spikes as straight lines
      // (live != export). Wall-clock fallback callers keep endpoint-only.
      if (timeAt && lane.points.length > 1) {
        for (const point of lane.points) {
          const rel = relOf(point.tick);
          if (rel <= rel0 || rel >= rel1) continue;
          const when = timeAt(point.tick);
          if (!Number.isFinite(when)) continue;
          this.writeAutomationTargetAt(lane.target, point.value, Math.max(ctx.currentTime, when + offset));
        }
      }
      this.writeAutomationTargetAt(lane.target, v1, t1);
    }
  }

  scheduleTrackAutomation(
    trackId: string,
    param: "gain" | "pan",
    points: AutomationPoint[],
    timeAt: (tick: number) => number,
  ): void {
    if (points.length === 0) return;
    const target: AutomationTarget = { kind: param === "gain" ? "trackGain" : "trackPan", trackId };
    this.writeAutomationTargetAt(target, valueAt(points, 0, param === "gain" ? 1 : 0), 0);
    // Gain/pan are continuous: sparse lanes render as the ramps the lane
    // editor draws (16th-note grid), not as a single step at the last point.
    const expanded = interpolateAutomationPoints(points);
    for (const point of expanded) this.writeAutomationTargetAt(target, point.value, Math.max(0, timeAt(point.tick)));
  }

  scheduleDeviceAutomation(
    trackId: string,
    kind: "fx" | "inst",
    deviceId: string | undefined,
    paramId: string | undefined,
    points: AutomationPoint[],
    timeAt: (tick: number) => number,
  ): void {
    if (!paramId) return;
    const target: AutomationTarget =
      kind === "fx" ? { kind: "fxParam", trackId, fxId: deviceId, paramId } : { kind: "instParam", trackId, paramId };
    // Continuous params ramp on a 16th-note grid so a sparse lane renders as
    // the straight lines the lane editor draws. Discrete params (toggles,
    // enums, stepped selectors) keep raw point events — interpolating between
    // enum positions would write undefined intermediate states.
    const doc = this.deps.doc();
    const def = doc ? targetParamDef(doc, target) : null;
    const discrete = def?.kind === "toggle" || def?.kind === "enum" || def?.kind === "discrete";
    const events = discrete ? points : interpolateAutomationPoints(points);
    for (const point of events) {
      this.writeAutomationTargetAt(target, point.value, Math.max(0, timeAt(point.tick)));
    }
  }

  automationReset(): void {
    const ctx = this.deps.ctx();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const nodes of [...this.deps.trackNodes.values(), ...this.deps.groupNodes.values()]) {
      // Cancel pending modulator/automation writes before restoring — otherwise
      // stale future events would snap parameters right back.
      try {
        nodes.modAutoGain.gain.cancelScheduledValues(now);
      } catch {
        /* nothing scheduled */
      }
      try {
        nodes.modAutoPan.pan.cancelScheduledValues(now);
      } catch {
        /* nothing scheduled */
      }
      nodes.modAutoGain.gain.setTargetAtTime(1, now, 0.01);
      nodes.modAutoPan.pan.setTargetAtTime(0, now, 0.01);
    }
    for (const nodes of this.deps.returnNodes.values()) {
      try {
        nodes.modAutoGain.gain.cancelScheduledValues(now);
      } catch {
        /* nothing scheduled */
      }
      nodes.modAutoGain.gain.setTargetAtTime(1, now, 0.01);
    }

    // Worklet parameters do not have an AudioParam cancelScheduledValues API:
    // a manual set is the takeover operation that removes future timed
    // events. Reset every device target touched by either project or scene
    // automation, then re-compose persistent macro offsets below.
    const deviceTargets = new Map<string, AutomationTarget>();
    for (const lane of this.deps.doc()?.automation ?? []) {
      if (lane.target.kind === "fxParam" || lane.target.kind === "instParam") {
        deviceTargets.set(JSON.stringify(lane.target), lane.target);
      }
    }
    for (const lane of this.deps.doc()?.sceneAutomation ?? []) {
      if (lane.target.kind === "fxParam" || lane.target.kind === "instParam") {
        deviceTargets.set(JSON.stringify(lane.target), lane.target);
      }
    }
    for (const target of deviceTargets.values()) {
      const base = this.lookup.baseValueForTarget(this.deps.doc()!, target);
      if (base !== null) this.lookup.writeDeviceTargetAt(target, base);
    }
    if (this.deps.doc()) {
      // Return and device macros share the same canonical base writer after a
      // stop; force a fresh composition so stopping automation never erases
      // an intentionally active macro value.
      this.macroCache.clear();
      const doc = this.deps.doc();
      if (doc) this.syncMacros(doc);
    }
  }

  applyMidiCc(target: AutomationTarget, value: number): void {
    const ctx = this.deps.ctx();
    const doc = this.deps.doc();
    if (!ctx || !doc || !targetParamDef(doc, target)) return;
    const clamped = clampTargetValue(doc, target, value);
    const now = ctx.currentTime;
    switch (target.kind) {
      case "trackGain": {
        const nodes = this.deps.trackNodes.get(target.trackId) ?? this.deps.groupNodes.get(target.trackId);
        const returnNodes = this.deps.returnNodes.get(target.trackId);
        if (nodes) nodes.modMacroGain.gain.setTargetAtTime(clamped, now, 0.005);
        else if (returnNodes) returnNodes.modMacroGain.gain.setTargetAtTime(clamped, now, 0.005);
        break;
      }
      case "trackPan": {
        const nodes = this.deps.trackNodes.get(target.trackId) ?? this.deps.groupNodes.get(target.trackId);
        if (nodes) nodes.modMacroPan.pan.setTargetAtTime(clamped, now, 0.005);
        break;
      }
      case "fxParam": {
        this.lookup.writeDeviceTargetAt(target, clamped);
        break;
      }
      case "instParam": {
        this.lookup.writeDeviceTargetAt(target, clamped);
        break;
      }
    }
  }
}
