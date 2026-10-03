import type { Command } from "./types";
import type { AutomationLane, AutomationTarget, Lfo, LfoKind, Macro, ProjectDocument } from "../project-model/types";
import { DEFAULT_STEP_PATTERN } from "../project-model/modulators";
import { insertPointSorted } from "../project-model/automation";
import { clampTargetValue, isAutomationTargetValid, targetOwner } from "../project-model/targets";
import { clamp, uid } from "../shared/ids";
import { snapshot } from "./core";

/**
 * Automation lanes, LFOs / modulators and macros.
 *
 * Every lane point is clamped to the target parameter's legal range at the
 * command boundary: lane points are trusted data downstream (engine -> worklet
 * port -> DSP), so garbage must be rejected here, not in audio. Ultina deep
 * params clamp through the vendored schema, other effect params through their
 * registry def, and non-finite values fall back to the default. `clampTargetValue`
 * is the single implementation of that rule - the scene-automation commands in
 * commands.ts call it directly for the same reason, which is why this file used
 * to wrap it in a one-line alias of its own.
 */
/* ---------------- automation ---------------- */

export function automationLaneOf(doc: ProjectDocument, laneId: string): AutomationLane | undefined {
  return doc.automation.find((l) => l.id === laneId);
}

export function addAutomationLane(doc: ProjectDocument, target: AutomationTarget): Command {
  if (target.kind === "fxParam" && !target.fxId) throw new Error("fxParam target requires fxId");
  if ((target.kind === "fxParam" || target.kind === "instParam") && !target.paramId) {
    throw new Error(`${target.kind} target requires paramId`);
  }
  const owner = targetOwner(doc, target.trackId);
  if (!owner) throw new Error(`Track or return ${target.trackId} not found`);
  if (target.kind === "fxParam" && !owner.effects.some((fx) => fx.id === target.fxId)) {
    throw new Error(`Effect ${target.fxId} not found`);
  }
  if (!isAutomationTargetValid(doc, target)) {
    throw new Error(
      `Invalid automation target ${target.kind}:${target.trackId}:${target.fxId ?? ""}:${target.paramId ?? ""}`,
    );
  }
  const exists = doc.automation.some(
    (l) =>
      l.target.kind === target.kind &&
      l.target.trackId === target.trackId &&
      l.target.fxId === target.fxId &&
      l.target.paramId === target.paramId,
  );
  if (exists) throw new Error("Automation lane for this target already exists");
  // Copy the caller's target: the lane must not alias an object the caller
  // could later mutate in place — doc and undo snapshot would diverge (same
  // discipline as addSceneAutomation / addMacroTargetMapping).
  const lane: AutomationLane = { id: uid("lane"), target: { ...target }, points: [] };
  const next: ProjectDocument = { ...doc, automation: [...doc.automation, lane] };
  return snapshot("addAutomationLane", "Add automation lane", doc, next);
}

export function removeAutomationLane(doc: ProjectDocument, laneId: string): Command {
  const next: ProjectDocument = { ...doc, automation: doc.automation.filter((l) => l.id !== laneId) };
  return snapshot("removeAutomationLane", "Remove automation lane", doc, next);
}

function withLane(doc: ProjectDocument, laneId: string, fn: (lane: AutomationLane) => AutomationLane): ProjectDocument {
  return { ...doc, automation: doc.automation.map((l) => (l.id === laneId ? fn(l) : l)) };
}

/**
 * Clamp an automation point value to the target parameter's legal range at
 * the command boundary — lane points are trusted data downstream (engine →
 * worklet port → DSP), so garbage must be rejected here, not in audio.
 * Ultina deep params clamp through the vendored schema; other effect params
 * through their registry def. Non-finite values fall back to the default.
 */
function clampAutomationPointValue(doc: ProjectDocument, target: AutomationTarget, value: number): number {
  return clampTargetValue(doc, target, value);
}

export function addAutomationPoint(doc: ProjectDocument, laneId: string, tick: number, value: number): Command {
  const lane = automationLaneOf(doc, laneId);
  if (!lane) throw new Error(`Lane ${laneId} not found`);
  // Audit 06 D4: Math.max(0, NaN) === NaN — a non-finite tick sorted
  // nondeterministically and corrupted valueAt's scan. Gate it finite.
  const point = {
    tick: Number.isFinite(tick) ? Math.max(0, Math.round(tick)) : 0,
    value: clampAutomationPointValue(doc, lane.target, value),
  };
  return {
    type: "addAutomationPoint",
    label: "Add automation point",
    execute: (d) => withLane(d, laneId, (l) => ({ ...l, points: insertPointSorted(l.points, point) })),
    undo: (d) =>
      withLane(d, laneId, (l) => {
        // Inverse of the sorted insert: remove one instance of that (tick, value).
        const idx = l.points.findIndex((p) => p.tick === point.tick && p.value === point.value);
        if (idx === -1) return l;
        const points = [...l.points];
        points.splice(idx, 1);
        return { ...l, points };
      }),
  };
}

export function moveAutomationPoint(
  doc: ProjectDocument,
  laneId: string,
  index: number,
  delta: { tick?: number; value?: number },
): Command {
  const lane = automationLaneOf(doc, laneId);
  if (!lane || index < 0 || index >= lane.points.length) throw new Error("Automation point not found");
  const prev = lane.points;
  // Audit 06 D3: re-anchor by IDENTITY, then by (tick, value) — the index
  // was validated against the FACTORY doc only; a collab peer shifting the
  // array used to make points[index] undefined (TypeError) or move the
  // WRONG point.
  const original = lane.points[index]!;
  const nextValue = delta.value === undefined ? undefined : clampAutomationPointValue(doc, lane.target, delta.value);
  return {
    type: "moveAutomationPoint",
    label: "Move automation point",
    execute: (d) =>
      withLane(d, laneId, (l) => {
        let at = l.points.findIndex((p) => p === original);
        if (at === -1) at = l.points.findIndex((p) => p.tick === original.tick && p.value === original.value);
        if (at === -1) return l;
        const points = [...l.points];
        points[at] = {
          tick: Math.max(0, Math.round(delta.tick ?? original.tick)),
          value: nextValue ?? original.value,
        };
        return { ...l, points: points.sort((a, b) => a.tick - b.tick) };
      }),
    undo: (d) => withLane(d, laneId, (l) => ({ ...l, points: prev })),
  };
}

export function deleteAutomationPoint(doc: ProjectDocument, laneId: string, index: number): Command {
  const lane = automationLaneOf(doc, laneId);
  if (!lane || index < 0 || index >= lane.points.length) throw new Error("Automation point not found");
  const removed = lane.points[index];
  return {
    type: "deleteAutomationPoint",
    label: "Delete automation point",
    execute: (d) =>
      withLane(d, laneId, (l) => {
        // Same re-anchor as moveAutomationPoint (Audit 06 D3).
        let at = l.points.findIndex((p) => p === removed);
        if (at === -1) at = l.points.findIndex((p) => p.tick === removed.tick && p.value === removed.value);
        if (at === -1) return l;
        const points = [...l.points];
        points.splice(at, 1);
        return { ...l, points };
      }),
    undo: (d) =>
      withLane(d, laneId, (l) => {
        // Re-insert SORTED: splicing at the creation-time index after the
        // array shifted (delete B, add tick-5, undo) produced an unsorted
        // array and wrong interpolation between ticks.
        if (l.points.some((p) => p.tick === removed.tick && p.value === removed.value)) return l;
        return { ...l, points: insertPointSorted(l.points, removed) };
      }),
  };
}

/* ---------------- LFO / modulators ---------------- */

/** Fresh seed for a random modulator. The seed itself is stored — streams are deterministic once created. */
export function newModulatorSeed(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function addLfo(doc: ProjectDocument, trackId: string, kind: LfoKind = "osc"): Command {
  if (!targetOwner(doc, trackId)) throw new Error(`LFO host ${trackId} not found`);
  const id = uid("lfo");
  let lfo: Lfo;
  if (kind === "random") {
    lfo = {
      id,
      trackId,
      kind,
      param: "gain",
      snh: "hold",
      rateMode: "sync",
      rateHz: 8,
      division: 3,
      amount: 0.4,
      seed: newModulatorSeed(),
    };
  } else if (kind === "step") {
    lfo = {
      id,
      trackId,
      kind,
      param: "gain",
      division: 3,
      glideSec: 0.02,
      amount: 0.6,
      steps: [...DEFAULT_STEP_PATTERN],
    };
  } else if (kind === "envFollower") {
    lfo = {
      id,
      trackId,
      kind,
      param: "gain",
      sourceTrackId: trackId,
      attackMs: 12,
      releaseMs: 180,
      sensitivity: 1.5,
      amount: 0.5,
    };
  } else {
    lfo = { id, trackId, param: "gain", wave: "sine", rateMode: "sync", rateHz: 2, division: 2, amount: 0.3 };
  }
  const next: ProjectDocument = { ...doc, lfos: [...doc.lfos, lfo] };
  return snapshot("addLfo", ADD_LFO_LABELS[kind], doc, next);
}

const ADD_LFO_LABELS: Record<LfoKind, string> = {
  osc: "Add LFO",
  random: "Add Random S&H",
  step: "Add Step Modulator",
  envFollower: "Add Envelope Follower",
};

export function removeLfo(doc: ProjectDocument, lfoId: string): Command {
  const next: ProjectDocument = { ...doc, lfos: doc.lfos.filter((l) => l.id !== lfoId) };
  return snapshot("removeLfo", "Remove LFO", doc, next);
}

export function setLfoParams(
  doc: ProjectDocument,
  lfoId: string,
  patch: Partial<Omit<Lfo, "id" | "trackId">>,
): Command {
  const prev: Partial<Omit<Lfo, "id" | "trackId">> = {};
  const current = doc.lfos.find((l) => l.id === lfoId);
  if (!current) throw new Error(`LFO ${lfoId} not found`);
  for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
    (prev as Record<string, unknown>)[key] = current[key];
  }
  const apply = (d: ProjectDocument, values: Partial<Omit<Lfo, "id" | "trackId">>): ProjectDocument => ({
    ...d,
    lfos: d.lfos.map((l) => (l.id === lfoId ? { ...l, ...values } : l)),
  });
  return {
    type: "setLfoParams",
    label: "Edit LFO",
    execute: (d) => apply(d, patch),
    undo: (d) => apply(d, prev),
  };
}

/* ---------------- macros ---------------- */

export function setMacroValue(doc: ProjectDocument, macroId: string, value: number): Command {
  const prev = doc.macros.find((m) => m.id === macroId)?.value ?? 0.5;
  const clamped = clamp(value, 0, 1);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    macros: d.macros.map((m) => (m.id === macroId ? { ...m, value: v } : m)),
  });
  return {
    type: "setMacroValue",
    label: "Set macro",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const macros = yMap.get("macros") as any;
      for (let i = 0; i < macros.length; i++) {
        const m = macros.get(i);
        if (m.get("id") === macroId) {
          m.set("value", clamped);
          break;
        }
      }
    },
  };
}

export function renameMacro(doc: ProjectDocument, macroId: string, name: string): Command {
  const prev = doc.macros.find((m) => m.id === macroId)?.name ?? "";
  const apply = (d: ProjectDocument, v: string): ProjectDocument => ({
    ...d,
    macros: d.macros.map((m) => (m.id === macroId ? { ...m, name: v } : m)),
  });
  return {
    type: "renameMacro",
    label: `Rename macro to "${name}"`,
    execute: (d) => apply(d, name),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const macros = yMap.get("macros") as any;
      for (let i = 0; i < macros.length; i++) {
        const m = macros.get(i);
        if (m.get("id") === macroId) {
          m.set("name", name);
          break;
        }
      }
    },
  };
}

export function addMacroMapping(
  doc: ProjectDocument,
  macroId: string,
  trackId: string,
  param: "gain" | "pan",
  options?: { source?: "macro" | "intensity" },
): Command {
  const owner = targetOwner(doc, trackId);
  if (!owner) throw new Error(`Track or return ${trackId} not found`);
  if (!doc.macros.some((m) => m.id === macroId)) throw new Error(`Macro ${macroId} not found`);
  if (owner.kind === "return" && param === "pan") throw new Error("Return targets do not support pan");
  const mapping: import("../project-model/types").MacroMapping = {
    id: uid("map"),
    trackId,
    param,
    amount: 0.5,
    // Return buses do not have the track modMacro gain/pan layer. Persist a
    // first-class target so the engine applies the same macro semantics to
    // the return gain node instead of silently ignoring the mapping.
    ...(owner.kind === "return" ? { target: { kind: "trackGain" as const, trackId } } : {}),
    ...(options?.source ? { source: options.source } : {}),
  };
  const next: ProjectDocument = {
    ...dMap(doc, macroId, (m) => ({ ...m, mappings: [...m.mappings, mapping] })),
  };
  return snapshot("addMacroMapping", "Add macro mapping", doc, next);
}

export function addMacroMappingMidiCC(
  doc: ProjectDocument,
  macroId: string,
  trackId: string,
  param: "gain" | "pan" | string,
  ccNumber: number,
  channel?: number,
  target?: AutomationTarget,
): Command {
  const owner = targetOwner(doc, trackId);
  if (!owner) throw new Error(`Track or return ${trackId} not found`);
  if (!doc.macros.some((m) => m.id === macroId)) throw new Error(`Macro ${macroId} not found`);
  if (!Number.isFinite(ccNumber) || ccNumber < 0 || ccNumber > 127) throw new Error("Invalid CC number");
  if (channel !== undefined && (!Number.isFinite(channel) || channel < 1 || channel > 16)) {
    throw new Error("Invalid MIDI channel");
  }
  if (!target && param !== "gain" && param !== "pan") throw new Error("MIDI macro target is required");
  if (owner?.kind === "return" && !target && param === "pan") throw new Error("Return targets do not support pan");
  const resolvedTarget = target ?? (owner?.kind === "return" ? { kind: "trackGain" as const, trackId } : undefined);
  if (resolvedTarget && !isAutomationTargetValid(doc, resolvedTarget)) throw new Error("Invalid MIDI macro target");
  const mapping: import("../project-model/types").MacroMapping = {
    id: uid("map"),
    trackId,
    param,
    amount: 0.5,
    source: "midiCC",
    ccNumber: Math.floor(ccNumber),
    ...(channel !== undefined ? { channel: Math.floor(channel) } : {}),
    ...(resolvedTarget ? { target: { ...resolvedTarget }, param: resolvedTarget.kind } : {}),
  };
  const next: ProjectDocument = {
    ...dMap(doc, macroId, (m) => ({ ...m, mappings: [...m.mappings, mapping] })),
  };
  return snapshot("addMacroMappingMidiCC", `Map CC${ccNumber} → ${param}`, doc, next);
}

export function removeMacroMapping(doc: ProjectDocument, macroId: string, mappingId: string): Command {
  const next: ProjectDocument = {
    ...dMap(doc, macroId, (m) => ({ ...m, mappings: m.mappings.filter((x) => x.id !== mappingId) })),
  };
  return snapshot("removeMacroMapping", "Remove macro mapping", doc, next);
}

/**
 * Map a macro to ANY engine target: track gain/pan, an FX device parameter
 * or an instrument parameter (AutomationTarget P2 bus). The engine resolves
 * the mapping as an offset around the persisted base value.
 */
export function addMacroTargetMapping(
  doc: ProjectDocument,
  macroId: string,
  target: import("../project-model/types").AutomationTarget,
  amount = 0.5,
  options?: { source?: "macro" | "intensity" },
): Command {
  if (!doc.macros.some((m) => m.id === macroId)) throw new Error(`Macro ${macroId} not found`);
  if (target.kind === "fxParam" && (!target.fxId || !target.paramId))
    throw new Error("fxParam target needs fxId + paramId");
  if (target.kind === "instParam" && !target.paramId) throw new Error("instParam target needs paramId");
  if (!isAutomationTargetValid(doc, target)) throw new Error("Invalid macro target");
  const mapping: import("../project-model/types").MacroMapping = {
    id: uid("map"),
    trackId: target.trackId,
    param: target.kind,
    amount: clamp(amount, -1, 1),
    source: options?.source ?? "macro",
    target: { ...target },
  };
  const next: ProjectDocument = {
    ...dMap(doc, macroId, (m) => ({ ...m, mappings: [...m.mappings, mapping] })),
  };
  return snapshot("addMacroTargetMapping", `Map macro → ${target.kind}`, doc, next);
}

/** Retarget (or clear the generic target of) an existing macro mapping. */
export function setMacroMappingTarget(
  doc: ProjectDocument,
  macroId: string,
  mappingId: string,
  target: import("../project-model/types").AutomationTarget | null,
): Command {
  const macro = doc.macros.find((m) => m.id === macroId);
  const prev = macro?.mappings.find((x) => x.id === mappingId);
  if (!prev) throw new Error("Macro mapping not found");
  if (target && !isAutomationTargetValid(doc, target)) throw new Error("Invalid macro target");
  const apply = (
    d: ProjectDocument,
    t: import("../project-model/types").AutomationTarget | null,
    legacyParam?: string,
  ): ProjectDocument => ({
    ...dMap(d, macroId, (m) => ({
      ...m,
      mappings: m.mappings.map((x) =>
        x.id === mappingId
          ? {
              ...x,
              target: t ? { ...t } : undefined,
              param: t
                ? t.kind
                : (legacyParam ?? (x.target?.kind === "trackPan" || x.param === "pan" ? "pan" : "gain")),
            }
          : x,
      ),
    })),
  });
  const prevTarget = prev.target ?? null;
  return {
    type: "setMacroMappingTarget",
    label: target ? "Retarget macro mapping" : "Macro mapping → legacy",
    execute: (d) => apply(d, target),
    undo: (d) => apply(d, prevTarget, prev.param),
  };
}

export function setMacroMappingAmount(
  doc: ProjectDocument,
  macroId: string,
  mappingId: string,
  amount: number,
): Command {
  const prev = doc.macros.find((m) => m.id === macroId)?.mappings.find((x) => x.id === mappingId)?.amount;
  if (prev === undefined) throw new Error("Macro mapping not found");
  const clamped = clamp(amount, -1, 1);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    macros: d.macros.map((m) =>
      m.id === macroId ? { ...m, mappings: m.mappings.map((x) => (x.id === mappingId ? { ...x, amount: v } : x)) } : m,
    ),
  });
  return {
    type: "setMacroMappingAmount",
    label: "Set macro amount",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
  };
}

function dMap(doc: ProjectDocument, macroId: string, fn: (m: Macro) => Macro): ProjectDocument {
  return { ...doc, macros: doc.macros.map((m) => (m.id === macroId ? fn(m) : m)) };
}
