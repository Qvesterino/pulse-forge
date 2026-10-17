import { TSAR_PARAM_DEFS } from "./params";

/**
 * TSAR Patch Mutations (the Session-Theatre loop for sound design).
 *
 * `mutateTsarPatch` walks a patch's parameter space deterministically: one
 * seed → the same set of variants, every render, every session. Only
 * sound-shaping axes mutate — loudness (LEVEL), tuning anchors (ROOT),
 * performance identity (ARP*, velocity) and the mod matrix stay put, so a
 * blind comparison compares TIMBRE, not loudness or rhythm.
 *
 * The UI pairs the variants into a blind A/B ladder (Session Theatre's
 * pattern); applying a winner is ONE undoable command in the panel — the
 * tournament itself never touches project state (T11: preview does not
 * modify the project).
 */

export interface TsarMutation {
  /** Stable ladder id: "m1"…"mN". */
  id: string;
  /** Revealed in history after a pick: the axes this variant moved. */
  label: string;
  /** The FULL patch (base overlaid with the moved axes) — audition-ready. */
  params: Record<string, number>;
  /** Axes this variant moved, strongest first (for the reveal). */
  moved: string[];
}

/** One mutable axis: how a random draw maps onto the parameter's range. */
interface MutationAxis {
  id: string;
  /** pct/bipolar: linear in [min,max] · log: multiplicative octaves · st: integer semitones · ct: cents. */
  kind: "pct" | "log" | "st" | "ct";
  /** Relative reach 0..1 — how far one full-strength draw can move it. */
  weight: number;
}

/** Sound-shaping axes only — see the module note for what stays fixed. */
const AXES: MutationAxis[] = [
  { id: "srcAMorph", kind: "pct", weight: 0.5 },
  { id: "srcBMorph", kind: "pct", weight: 0.4 },
  { id: "srcACutoff", kind: "log", weight: 0.6 },
  { id: "srcBCutoff", kind: "log", weight: 0.5 },
  { id: "srcAQ", kind: "pct", weight: 0.35 },
  { id: "srcBQ", kind: "pct", weight: 0.3 },
  { id: "srcACoarse", kind: "st", weight: 0.4 },
  { id: "srcBCoarse", kind: "st", weight: 0.35 },
  { id: "srcAFine", kind: "ct", weight: 0.35 },
  { id: "srcBFine", kind: "ct", weight: 0.3 },
  { id: "srcASpread", kind: "pct", weight: 0.3 },
  { id: "srcBSpread", kind: "pct", weight: 0.25 },
  { id: "srcAAtk", kind: "log", weight: 0.45 },
  { id: "srcADec", kind: "log", weight: 0.4 },
  { id: "srcASus", kind: "pct", weight: 0.35 },
  { id: "srcARel", kind: "log", weight: 0.35 },
  { id: "srcBAtk", kind: "log", weight: 0.35 },
  { id: "srcBDec", kind: "log", weight: 0.35 },
  { id: "srcBSus", kind: "pct", weight: 0.3 },
  { id: "srcBRel", kind: "log", weight: 0.3 },
  { id: "sub", kind: "pct", weight: 0.4 },
  { id: "noise", kind: "pct", weight: 0.3 },
  { id: "noiseColor", kind: "pct", weight: 0.25 },
  { id: "morph", kind: "pct", weight: 0.55 },
  { id: "tone", kind: "pct", weight: 0.5 },
  { id: "drive", kind: "pct", weight: 0.45 },
  { id: "width", kind: "pct", weight: 0.25 },
  { id: "glide", kind: "log", weight: 0.25 },
  { id: "lfoRate", kind: "log", weight: 0.4 },
];

/** Deterministic LCG — the same one the arp RANDOM mode and KOPA use. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function clampToDef(paramId: string, value: number): number {
  const def = TSAR_PARAM_DEFS[paramId];
  if (!def) return value;
  return Math.max(def.min, Math.min(def.max, value));
}

function drawAxis(axis: MutationAxis, current: number, draw: () => number): number {
  const def = TSAR_PARAM_DEFS[axis.id];
  if (!def) return current;
  const u = (draw() * 2 - 1) * axis.weight; // bipolar, weighted
  switch (axis.kind) {
    case "log": {
      const base = current > 0 ? current : def.default > 0 ? def.default : def.max * 0.25;
      return clampToDef(axis.id, base * Math.pow(2, u * 1.5));
    }
    case "st": {
      const base = Number.isFinite(current) ? current : def.default;
      return clampToDef(axis.id, Math.round(base + u * 12));
    }
    case "ct": {
      const base = Number.isFinite(current) ? current : def.default;
      return clampToDef(axis.id, base + u * 50);
    }
    default: {
      const base = Number.isFinite(current) ? current : def.default;
      return clampToDef(axis.id, base + u * (def.max - def.min));
    }
  }
}

/** Human-readable axis name for the reveal — cents/steps keep their units. */
function deltaSummary(paramId: string, from: number, to: number): string {
  const def = TSAR_PARAM_DEFS[paramId];
  if (!def) return paramId;
  const span = def.max - def.min || 1;
  const moved = ((to - from) / span) * 100;
  const arrow = moved > 0 ? "▲" : "▼";
  return `${def.label} ${arrow}${Math.abs(moved).toFixed(0)}%`;
}

/**
 * Mutate a TSAR patch into `count` (default 6) tournament variants.
 * Deterministic: the same (base, seed) pair yields byte-identical variants.
 */
export function mutateTsarPatch(
  base: Record<string, number>,
  seed: number,
  count = 6,
): TsarMutation[] {
  const draw = lcg(seed);
  const mutations: TsarMutation[] = [];
  for (let index = 0; index < count; index++) {
    // 3–6 axes per variant: readable differences, not a full-patch scramble.
    const touchCount = 3 + Math.floor(draw() * 4);
    const movedIds = new Set<string>();
    let guard = 0;
    while (movedIds.size < touchCount && guard < 50) {
      guard += 1;
      const axis = AXES[Math.floor(draw() * AXES.length)]!;
      if (!TSAR_PARAM_DEFS[axis.id]) continue;
      movedIds.add(axis.id);
    }
    const params = { ...base };
    const moved: string[] = [];
    for (const id of movedIds) {
      const axis = AXES.find((candidate) => candidate.id === id)!;
      const from = Number.isFinite(params[id]) ? params[id] : TSAR_PARAM_DEFS[id]!.default;
      const to = drawAxis(axis, from, draw);
      if (to === from) continue;
      params[id] = to;
      moved.push(id);
    }
    if (moved.length === 0) continue; // the draw collapsed — skip, keep the count honest
    const strongest = moved
      .map((id) => ({
        id,
        span: Math.abs(
          (params[id]! - (Number.isFinite(base[id]) ? base[id] : TSAR_PARAM_DEFS[id]!.default)) /
            ((TSAR_PARAM_DEFS[id]?.max ?? 1) - (TSAR_PARAM_DEFS[id]?.min ?? 0) || 1),
        ),
      }))
      .sort((a, b) => b.span - a.span)
      .slice(0, 3)
      .map((entry) => deltaSummary(entry.id, Number.isFinite(base[entry.id]) ? base[entry.id] : TSAR_PARAM_DEFS[entry.id]!.default, params[entry.id]!));
    mutations.push({
      id: `m${index + 1}`,
      label: strongest.join(" · "),
      params,
      moved,
    });
  }
  // The skipped-collapse case above can undershoot the requested count; top
  // up deterministically so the ladder always has the promised rounds.
  let topUp = count;
  while (mutations.length < count && topUp < count * 4) {
    topUp += 1;
    const extra = mutateTsarPatch(base, (seed + topUp * 7919) >>> 0, 1);
    if (extra.length > 0) mutations.push({ ...extra[0]!, id: `m${mutations.length + 1}` });
  }
  return mutations.slice(0, count);
}

/**
 * The reveal: the moved axes of a variant against the base patch, strongest
 * first. Shown AFTER a pick — the comparison itself stays blind.
 */
export function mutationReveal(base: Record<string, number>, variant: TsarMutation, top = 4): string[] {
  return variant.moved
    .map((id) => {
      const def = TSAR_PARAM_DEFS[id];
      if (!def) return null;
      const from = Number.isFinite(base[id]) ? base[id] : def.default;
      return { id, text: deltaSummary(id, from, variant.params[id] ?? from), span: Math.abs((variant.params[id] ?? from) - from) };
    })
    .filter((entry): entry is { id: string; text: string; span: number } => entry !== null)
    .sort((a, b) => b.span - a.span)
    .slice(0, top)
    .map((entry) => entry.text);
}

/** How many of the shipped TSAR parameters the mutator knows how to move. */
export const MUTATION_AXIS_COUNT = AXES.filter((axis) => TSAR_PARAM_DEFS[axis.id]).length;
