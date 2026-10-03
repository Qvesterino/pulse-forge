import type { Command } from "./types";
import type { GrooveSettings, Pattern, ProjectDocument, StepMeta } from "../project-model/types";
import { applyVerbRows, type PatternVerb } from "../intent/pattern-verbs";
import { clampUnit, drumTracksOf } from "../project-model/schema";
import { hashString, mulberry32 } from "../shared/rng";
import { clamp, uid } from "../shared/ids";
import { snapshot } from "./core";
import { cloneStepMeta } from "./docOps";
import { getYDocHelpers } from "./yDocBridge";

/**
 * Groove and step performance: the feel layer on top of a pattern.
 *
 * Swing, groove settings, velocity shaping, step locks and the per-step
 * metadata edits. Everything here mutates an existing pattern in place, so it
 * reaches for the pattern model helpers and for docOps' stepMeta deep copy and
 * nothing else.
 */
/* ---------------- groove & step performance ---------------- */

export function setGroove(doc: ProjectDocument, groove: Partial<GrooveSettings>): Command {
  // prev === undefined when the doc carried NO groove object at all — undo
  // must restore that ABSENCE, not write an empty object (which normalize
  // would then materialize into a default groove the doc never had).
  const prev = doc.groove;
  const base = prev ?? {};
  const nextGroove: Partial<GrooveSettings> = { ...base, ...groove };
  const describe = (g: Partial<GrooveSettings>) =>
    `swing ${Math.round((g.swing ?? 0) * 100)}% · humanize ${Math.round((g.humanizeTiming ?? 0) * 100)}/${Math.round((g.humanizeVelocity ?? 0) * 100)}`;
  return {
    type: "setGroove",
    label: `Groove → ${describe(nextGroove)}`,
    execute: (d) => ({ ...d, groove: nextGroove }),
    undo: (d) => {
      if (prev === undefined) {
        const { groove: _restored, ...withoutGroove } = d;
        return withoutGroove;
      }
      return { ...d, groove: prev };
    },
    applyToYDoc: (yMap) => {
      let g = yMap.get("groove") as any;
      if (!g) {
        g = getYDocHelpers()?.createYMap?.();
        if (!g) return;
        yMap.set("groove", g);
      }
      for (const [k, v] of Object.entries(nextGroove)) {
        if (v !== undefined) g.set(k, v);
      }
    },
  };
}

/**
 * Merge per-step performance metadata (probability / ratchet / microtiming).
 * Values that land on the defaults (1 / 1 / 0) are pruned so the model stays
 * clean; an entry with nothing left is removed entirely.
 */
export function setStepMeta(
  doc: ProjectDocument,
  patternId: string,
  padId: string,
  stepIndex: number,
  meta: StepMeta,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const prevEntry = pattern.stepMeta?.[padId]?.[stepIndex];

  const apply = (d: ProjectDocument, entry: StepMeta | undefined): ProjectDocument => ({
    ...d,
    patterns: d.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const padMeta = { ...(p.stepMeta?.[padId] ?? {}) };
      if (entry && Object.keys(entry).length > 0) padMeta[stepIndex] = entry;
      else delete padMeta[stepIndex];
      const stepMeta = { ...(p.stepMeta ?? {}) };
      if (Object.keys(padMeta).length > 0) stepMeta[padId] = padMeta;
      else delete stepMeta[padId];
      return { ...p, stepMeta: Object.keys(stepMeta).length > 0 ? stepMeta : undefined };
    }),
  });

  const hasLocksPatch = Object.prototype.hasOwnProperty.call(meta, "locks");
  const merged: StepMeta = { ...(prevEntry ?? {}) };
  for (const [k, v] of Object.entries(meta)) {
    if (k === "locks") continue;
    (merged as Record<string, unknown>)[k] = v;
  }
  if (hasLocksPatch) {
    const patch = (meta as StepMeta).locks;
    const baseLocks: Record<string, number> = { ...(prevEntry?.locks ?? {}) };
    if (patch === undefined) {
      // explicit locks: undefined → clear all
      (merged as StepMeta).locks = undefined;
    } else {
      for (const [k, v] of Object.entries(patch as Record<string, number | undefined>)) {
        if (v === undefined) delete baseLocks[k];
        else baseLocks[k] = v;
      }
      (merged as StepMeta).locks = Object.keys(baseLocks).length > 0 ? (baseLocks as StepMeta["locks"]) : undefined;
    }
  }
  const cleaned: StepMeta = {};
  if (merged.probability !== undefined && merged.probability < 1) cleaned.probability = clampUnit(merged.probability);
  if (merged.ratchet !== undefined && merged.ratchet > 1)
    cleaned.ratchet = Math.max(1, Math.min(8, Math.round(merged.ratchet)));
  if (merged.microtiming !== undefined && merged.microtiming !== 0)
    cleaned.microtiming = Math.max(-1, Math.min(1, merged.microtiming));
  if (merged.locks !== undefined && Object.keys(merged.locks).length > 0) {
    const cleanedLocks: NonNullable<StepMeta["locks"]> = {};
    const ALLOWED = new Set(["pitch", "gain", "pan", "cutoff", "sampleStart", "length"]);
    const clampMap = {
      pitch: { min: -24, max: 24 },
      gain: { min: 0, max: 2 },
      pan: { min: -1, max: 1 },
      cutoff: { min: 80, max: 16000 },
      sampleStart: { min: 0, max: 1 },
      length: { min: 0.1, max: 2 },
    } as const;
    for (const [k, v] of Object.entries(merged.locks)) {
      if (!ALLOWED.has(k)) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const clamped = Math.min(
        clampMap[k as keyof typeof clampMap].max,
        Math.max(clampMap[k as keyof typeof clampMap].min, v),
      );
      let rounded: number;
      if (k === "pitch") rounded = Math.round(clamped * 10) / 10;
      else if (k === "cutoff") rounded = Math.round(clamped);
      else rounded = Math.round(clamped * 100) / 100;
      cleanedLocks[k as keyof typeof cleanedLocks] = rounded;
    }
    if (Object.keys(cleanedLocks).length > 0) cleaned.locks = cleanedLocks;
  }

  return {
    type: "setStepMeta",
    label: "Edit step performance",
    execute: (d) => apply(d, Object.keys(cleaned).length > 0 ? cleaned : undefined),
    undo: (d) => apply(d, prevEntry),
  };
}

/**
 * Shorthand for p-locks: patch `locks` on one step without touching
 * probability/ratchet/microtiming. `patch` keys with `undefined` delete.
 */
export function setStepLocks(
  doc: ProjectDocument,
  patternId: string,
  padId: string,
  stepIndex: number,
  patch: Partial<Record<import("../project-model/types").StepLockKey, number | undefined>>,
): Command {
  return setStepMeta(doc, patternId, padId, stepIndex, { locks: patch } as StepMeta);
}

/** Bulk apply p-locks to every step in a rectangular selection. */
export function setStepsLocks(
  doc: ProjectDocument,
  patternId: string,
  padIds: string[],
  fromStep: number,
  toStep: number,
  patch: Partial<Record<import("../project-model/types").StepLockKey, number | undefined>>,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  let nextDoc = doc;
  for (const padId of padIds) {
    for (let step = fromStep; step <= toStep; step++) {
      if (step < 0 || step >= pattern.stepCount) continue;
      nextDoc = setStepLocks(nextDoc, patternId, padId, step, patch).execute(nextDoc);
    }
  }
  // Delta snapshot, not a whole-doc pin — `execute: () => next` would revert
  // concurrent edits (live MIDI writes, collab fallback) captured after this
  // command was built. The delta applies only the lock changes.
  return snapshot("setStepsLocks", `Set p-locks for ${padIds.length}×${toStep - fromStep + 1} steps`, doc, nextDoc);
}

/** Paste locks from a copied source (shallow) onto a selection. */
export function pasteStepLocks(
  doc: ProjectDocument,
  patternId: string,
  padIds: string[],
  fromStep: number,
  toStep: number,
  locks: Partial<Record<import("../project-model/types").StepLockKey, number>>,
): Command {
  if (!locks || Object.keys(locks).length === 0) {
    return { type: "pasteStepLocks", label: "Paste p-locks (empty)", execute: (d) => d, undo: (d) => d };
  }
  return setStepsLocks(
    doc,
    patternId,
    padIds,
    fromStep,
    toStep,
    locks as Partial<Record<import("../project-model/types").StepLockKey, number | undefined>>,
  );
}

export function clearStepLocks(
  doc: ProjectDocument,
  patternId: string,
  padIds: string[],
  fromStep: number,
  toStep: number,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  let nextDoc = doc;
  for (const padId of padIds) {
    for (let step = fromStep; step <= toStep; step++) {
      const locks = pattern.stepMeta?.[padId]?.[step]?.locks;
      if (!locks) continue;
      const patch: Record<string, undefined> = {};
      for (const k of Object.keys(locks)) patch[k] = undefined;
      nextDoc = setStepLocks(nextDoc, patternId, padId, step, patch as any).execute(nextDoc);
    }
  }
  // Delta snapshot — see setStepsLocks for why whole-doc pins are forbidden.
  return snapshot("clearStepLocks", `Clear p-locks for ${padIds.length}×${toStep - fromStep + 1} steps`, doc, nextDoc);
}

export function clearSteps(
  doc: ProjectDocument,
  patternId: string,
  padIds: string[],
  fromStep: number,
  toStep: number,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const prevRows: Record<string, number[]> = {};
  for (const padId of padIds) prevRows[padId] = [...(pattern.rows[padId] ?? [])];
  const prevMeta = cloneStepMeta(pattern.stepMeta);

  const apply = (d: ProjectDocument, rows: Record<string, number[]>, meta: Pattern["stepMeta"]): ProjectDocument => ({
    ...d,
    patterns: d.patterns.map((p) =>
      p.id === patternId ? { ...p, rows: { ...p.rows, ...rows }, stepMeta: cloneStepMeta(meta) } : p,
    ),
  });

  const clearedRows: Record<string, number[]> = {};
  for (const padId of padIds) {
    const row = [...(pattern.rows[padId] ?? [])];
    for (let i = fromStep; i <= toStep && i < row.length; i++) row[i] = 0;
    clearedRows[padId] = row;
  }
  const clearedMeta = cloneStepMeta(pattern.stepMeta) ?? {};
  for (const padId of padIds) {
    const padMeta = clearedMeta[padId];
    if (!padMeta) continue;
    for (const key of Object.keys(padMeta)) {
      const idx = Number(key);
      if (idx >= fromStep && idx <= toStep) delete padMeta[idx];
    }
    if (Object.keys(padMeta).length === 0) delete clearedMeta[padId];
  }

  return {
    type: "clearSteps",
    label: `Clear steps ${fromStep + 1}–${toStep + 1}`,
    execute: (d) => apply(d, clearedRows, Object.keys(clearedMeta).length > 0 ? clearedMeta : undefined),
    undo: (d) => apply(d, prevRows, prevMeta),
  };
}

/** Batch-set velocities for a set of steps (multi-select velocity drag). */
export function setStepsVelocity(
  doc: ProjectDocument,
  patternId: string,
  entries: { padId: string; stepIndex: number; velocity: number }[],
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const prev: { padId: string; stepIndex: number; velocity: number }[] = entries.map((e) => ({
    ...e,
    velocity: pattern.rows[e.padId]?.[e.stepIndex] ?? 0,
  }));

  const apply = (
    d: ProjectDocument,
    list: { padId: string; stepIndex: number; velocity: number }[],
  ): ProjectDocument => ({
    ...d,
    patterns: d.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const rows = { ...p.rows };
      for (const entry of list) {
        const row = [...(rows[entry.padId] ?? [])];
        // Raw write previously let NaN/over-unity velocities poison a row
        // (NaN passes row<=0 checks and reaches the scheduler) — clamp here.
        if (!Number.isInteger(entry.stepIndex) || entry.stepIndex < 0 || entry.stepIndex >= row.length) continue;
        row[entry.stepIndex] = clamp(entry.velocity, 0, 1);
        rows[entry.padId] = row;
      }
      return { ...p, rows };
    }),
  });

  return {
    type: "setStepsVelocity",
    label: `Set velocity for ${entries.length} steps`,
    execute: (d) => apply(d, entries),
    undo: (d) => apply(d, prev),
  };
}

/**
 * Mutate the active pattern into a variation: seeded velocity jitter, sparse
 * ghost notes next to existing hits, occasional dropped weak hits and a touch
 * of microtiming. One undo step returns the original.
 */
/**
 * PATTERN-DIFF VERBS (vibe-code wave 1): "fewer hats", "menej hi-hatov",
 * "denser snare", "add ghosts", "simplify", "swing it" — applied to the
 * pattern you're HEARING, in place, as ONE undoable snapshot. Families
 * resolve via classifyPads on the drum track; rows never empty entirely
 * (the family's first original hit survives) and the swing verb composes
 * into doc.groove instead of rows. Deterministic per (pattern, verbs).
 */
export function applyPatternVerbsCommand(
  doc: ProjectDocument,
  patternId: string,
  verbs: PatternVerb[],
  seed = "pattern-verbs",
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const drumTrack = doc.tracks.find((t) => t.kind === "drum");
  const pads = drumTrack && drumTrack.kind === "drum" ? drumTrack.pads : [];
  const { rows, grooveSwingDelta } = applyVerbRows(pattern, pads, verbs, seed);
  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) => (p.id === patternId ? { ...p, rows: { ...p.rows, ...rows } } : p)),
    ...(grooveSwingDelta > 0
      ? {
          groove: {
            ...doc.groove,
            swing: Math.min(0.6, Math.round(((doc.groove?.swing ?? 0) + grooveSwingDelta) * 100) / 100),
          },
        }
      : {}),
  };
  const unchanged = next.patterns === doc.patterns && next.groove === doc.groove;
  if (unchanged) return snapshot("applyPatternVerbs", "Pattern verbs (no-op)", doc, doc);
  const describe = verbs.map((v) => v.kind + (v.family !== "all" ? ` ${v.family}` : "")).join(" + ");
  return snapshot("applyPatternVerbs", `Pattern verbs: ${describe}`, doc, next);
}

export function mutatePattern(doc: ProjectDocument, patternId: string): Command {
  const source = doc.patterns.find((p) => p.id === patternId);
  if (!source) throw new Error(`Pattern ${patternId} not found`);
  const rand = mulberry32(hashString(`${source.id}|${uid("mut")}`));

  const rows: Record<string, number[]> = {};
  const meta: NonNullable<Pattern["stepMeta"]> = cloneStepMeta(source.stepMeta) ?? {};
  for (const [padId, row] of Object.entries(source.rows)) {
    const next = [...row];
    for (let i = 0; i < next.length; i++) {
      const velocity = next[i];
      if (velocity > 0) {
        if (velocity < 0.5 && rand() < 0.12) {
          next[i] = 0;
          continue;
        }
        next[i] = Math.min(1, Math.max(0.1, velocity + (rand() - 0.5) * 0.35));
        if (rand() < 0.25) {
          const padMeta = meta[padId] ?? (meta[padId] = {});
          const jitter = (rand() - 0.5) * 0.6;
          if (Math.abs(jitter) > 0.05) padMeta[i] = { ...padMeta[i], microtiming: jitter };
        }
      } else {
        const neighbor = row[i - 1] > 0 || row[i + 1] > 0;
        if (neighbor && i % 2 === 1 && rand() < 0.08) {
          next[i] = 0.22 + rand() * 0.15;
        }
      }
    }
    rows[padId] = next;
  }

  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === patternId ? { ...p, rows, stepMeta: Object.keys(meta).length > 0 ? meta : undefined } : p,
    ),
  };
  return snapshot("mutatePattern", `Mutate ${source.name}`, doc, next);
}

/**
 * Duplicate the pattern as an explicit fill: a snare roll with rising velocity
 * over the last beat, capped by a ratcheted final hit. The fill becomes active.
 */
export function createFill(doc: ProjectDocument, patternId: string): Command {
  const source = doc.patterns.find((p) => p.id === patternId);
  if (!source) throw new Error(`Pattern ${patternId} not found`);
  const drumTrack = drumTracksOf(doc)[0];
  if (!drumTrack) throw new Error("No drum track for fill");
  const snarePad = drumTrack.pads.find((p) => /snare/i.test(p.name)) ?? drumTrack.pads[4] ?? drumTrack.pads[0];

  const rows = Object.fromEntries(Object.entries(source.rows).map(([padId, row]) => [padId, [...row]]));
  const rollVelocities = [0.45, 0.6, 0.78, 0.95];
  const snareRow = [...(rows[snarePad.id] ?? new Array<number>(source.stepCount).fill(0))];
  for (let k = 0; k < 4; k++) {
    const idx = source.stepCount - 4 + k;
    if (idx >= 0) snareRow[idx] = rollVelocities[k];
  }
  rows[snarePad.id] = snareRow;

  const stepMeta = cloneStepMeta(source.stepMeta) ?? {};
  const lastStep = source.stepCount - 1;
  stepMeta[snarePad.id] = { ...(stepMeta[snarePad.id] ?? {}), [lastStep]: { ratchet: 2 } };

  const copy: Pattern = {
    id: uid("pattern"),
    name: `${source.name} Fill`,
    stepCount: source.stepCount,
    rows,
    notes: Object.fromEntries(
      Object.entries(source.notes ?? {}).map(([trackId, notes]) => [
        trackId,
        notes.map((n) => ({ ...n, id: uid("note") })),
      ]),
    ),
    stepMeta,
  };
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, copy],
    activePatternId: copy.id,
  };
  return snapshot("createFill", `Fill from ${source.name}`, doc, next);
}
