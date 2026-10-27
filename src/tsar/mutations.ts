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
 *
 * WAVE 4 — CONTROLLED MUTATIONS. Three controls were added, and one honesty
 * rule that the controls exist to serve:
 *
 *  - **LOCKS** — the producer may freeze whole PARAMETER GROUPS (source,
 *    tuning, envelope, filter, modulation, character). A locked group's
 *    parameters are bit-identical in every variant.
 *  - **RANGE** — how far a variant may move, from a gentle change to a
 *    pronounced transformation. `range = 1` reproduces the pre-wave-4 reach
 *    EXACTLY, so the control adds capability instead of changing the default.
 *  - **SEED** — the full seed is shown and can be typed back in, so the same
 *    variations can be re-invoked later.
 *
 * The honesty rule: **a parameter the engine never reads changes numbers and
 * no sound.** Numeric difference is not proof of quality, so the mutator does
 * not spend its budget on axes that cannot be heard in the current patch —
 * see `isMutationAxisLive`, whose rules are taken from the DSP itself.
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

/**
 * The parameter groups a producer can lock.
 *
 * The groups are a PARTITION of the TSAR parameter set: every parameter
 * belongs to exactly one group, so locking "tuning" cannot accidentally leave
 * a tuning parameter behind in "source".
 */
export type MutationGroup = "source" | "tuning" | "envelope" | "filter" | "modulation" | "character";

/** Display order and short labels for the panel. */
export const MUTATION_GROUPS: { id: MutationGroup; label: string }[] = [
  { id: "source", label: "SOURCE" },
  { id: "tuning", label: "TUNING" },
  { id: "envelope", label: "ENV" },
  { id: "filter", label: "FILTER" },
  { id: "modulation", label: "MOD" },
  { id: "character", label: "CHAR" },
];

/**
 * Every TSAR parameter id and the group it belongs to.
 *
 * The split follows what the parameter DOES, not where it sits in the panel:
 * the source group is the sound sources and their mix, tuning is the pitch
 * anchors, envelope the ADSRs and the velocity response, filter the two
 * filters, modulation the mod matrix + LFO + arpeggiator, and character the
 * output stage.
 */
export const MUTATION_GROUP_PARAMS: Record<MutationGroup, readonly string[]> = {
  source: [
    "srcAEngine",
    "srcALevel",
    "srcAPan",
    "srcAMorph",
    "srcAScan",
    "srcAGrainSize",
    "srcAGrainDensity",
    "srcAGrainJitter",
    "srcAUnison",
    "srcASpread",
    "srcBEngine",
    "srcBLevel",
    "srcBPan",
    "srcBMorph",
    "srcBScan",
    "srcBGrainSize",
    "srcBGrainDensity",
    "srcBGrainJitter",
    "srcBUnison",
    "srcBSpread",
    "morph",
    "sub",
    "subOct",
    "noise",
    "noiseColor",
  ],
  tuning: ["srcARoot", "srcACoarse", "srcAFine", "srcBRoot", "srcBCoarse", "srcBFine", "glide", "drift"],
  envelope: ["srcAAtk", "srcADec", "srcASus", "srcARel", "srcBAtk", "srcBDec", "srcBSus", "srcBRel", "velocity"],
  filter: ["srcAFilter", "srcACutoff", "srcAQ", "srcAFilterEnv", "srcBFilter", "srcBCutoff", "srcBQ", "srcBFilterEnv"],
  modulation: [
    "mod1Src",
    "mod1Dst",
    "mod1Amt",
    "mod2Src",
    "mod2Dst",
    "mod2Amt",
    "mod3Src",
    "mod3Dst",
    "mod3Amt",
    "mod4Src",
    "mod4Dst",
    "mod4Amt",
    "lfoRate",
    "lfoShape",
    "lfoSync",
    "arpOn",
    "arpMode",
    "arpRate",
    "arpOctaves",
    "arpGate",
    "arpSwing",
    "arpSnap",
  ],
  character: ["tone", "drive", "width", "level"],
};

const PARAM_GROUP_BY_ID: Record<string, MutationGroup> = (() => {
  const map: Record<string, MutationGroup> = {};
  for (const group of MUTATION_GROUPS) {
    for (const id of MUTATION_GROUP_PARAMS[group.id]) map[id] = group.id;
  }
  return map;
})();

/** The group a parameter belongs to, or null when it is not a TSAR parameter. */
export function mutationGroupOf(paramId: string): MutationGroup | null {
  return PARAM_GROUP_BY_ID[paramId] ?? null;
}

/**
 * How a mutation run is constrained.
 *
 * `range` and `locks` are part of the mutation KEY: the same (base, seed,
 * count, range, locks) always yields the same variants.
 */
export interface MutationOptions {
  /**
   * How far a variant may move, 0..1. `1` is the pre-wave-4 reach (the axis
   * weights as they were); `0` cannot move anything and the run refuses.
   */
  range?: number;
  /** Groups whose parameters must stay bit-identical in every variant. */
  locks?: readonly MutationGroup[];
}

/** The named range stops the panel offers. */
export const MUTATION_RANGES: { id: string; label: string; value: number }[] = [
  { id: "subtle", label: "SUBTLE", value: 0.25 },
  { id: "medium", label: "MEDIUM", value: 0.5 },
  { id: "bold", label: "BOLD", value: 0.75 },
  { id: "full", label: "FULL", value: 1 },
];

const RANGE_MIN = 0.05;
const RANGE_MAX = 1;
/**
 * The smallest share of an axis's weight a move may have.
 *
 * A move scaled much below half its weight changes a number and not a
 * sound — the measurement in `tests/tsar/mutation-audibility.test.ts` shows
 * variants collapsing to "inaudible" long before the reach reaches zero.
 */
const REACH_FLOOR = 0.5;

/** The engine's LFO is mod-matrix source 1 (processor: `mod.src === 1 ? lfo`). */
const LFO_MOD_SOURCE = 1;
/** The wavetable engine (TsarEngine 1) is the only one that reads a morph. */
const ENGINE_WAVETABLE = 1;

function paramValue(base: Record<string, number>, paramId: string): number {
  const raw = base[paramId];
  if (Number.isFinite(raw)) return raw!;
  const def = TSAR_PARAM_DEFS[paramId];
  return def ? def.default : 0;
}

/**
 * Can this axis be HEARD in the current patch?
 *
 * The rules are read off the DSP, not off taste:
 *
 *  - a slot with LEVEL 0 is silent — the processor scales the source by
 *    `levelA`/`levelB`, so its parameters reach no ear;
 *  - `srcAMorph`/`srcBMorph` select the WAVETABLE frame; the granular engine
 *    returns before reading them and the sampler's branch ignores them;
 *  - `srcASpread`/`srcBSpread` only detune when UNISON > 1 — with one voice
 *    the spread offset is zero;
 *  - the global `morph` blends A against B, so it needs B to sound at all;
 *  - `lfoRate` reaches the sound only through a mod slot that uses the LFO.
 *
 * A "no" here does not make the parameter wrong — it makes it INVISIBLE to
 * this patch. Moving it would change numbers and no sound.
 */
export function isMutationAxisLive(axisId: string, base: Record<string, number>): boolean {
  if (axisId.endsWith("Q") || axisId.endsWith("FilterEnv") || axisId.endsWith("Filter")) {
    // An OPEN filter passes everything, so its Q, its type and its envelope
    // amount change no sound. The cutoff is at its maximum when the filter
    // is open — and the maximum IS the default, so this is the common case.
    const slot = axisId.startsWith("srcB") ? "B" : "A";
    const cutoff = paramValue(base, slot === "A" ? "srcACutoff" : "srcBCutoff");
    const max = TSAR_PARAM_DEFS[slot === "A" ? "srcACutoff" : "srcBCutoff"]?.max ?? Number.POSITIVE_INFINITY;
    return cutoff < max - 1e-9;
  }
  if (axisId === "noiseColor") {
    // The noise COLOUR only colours noise that is there.
    return paramValue(base, "noise") > 0;
  }
  if (axisId === "width") {
    // The stereo width works on the SIDE signal, and the side signal is
    // proportional to (panR − panL). A source panned to the centre has no
    // side at all — so with every audible source centred, the width does
    // nothing.
    const audible = (slot: "A" | "B") => paramValue(base, slot === "A" ? "srcALevel" : "srcBLevel") > 0;
    const offCentre = (slot: "A" | "B") => Math.abs(paramValue(base, slot === "A" ? "srcAPan" : "srcBPan")) > 0.001;
    return (audible("A") && offCentre("A")) || (audible("B") && offCentre("B"));
  }
  if (axisId === "glide") {
    // The engine ignores a glide at or below 0.001 (processor: glide > 0.001).
    return paramValue(base, "glide") > 0.001;
  }
  if (axisId === "lfoRate") {
    for (let slotIndex = 1; slotIndex <= 4; slotIndex += 1) {
      if (paramValue(base, `mod${slotIndex}Src`) !== LFO_MOD_SOURCE) continue;
      if (paramValue(base, `mod${slotIndex}Amt`) !== 0) return true;
    }
    return false;
  }
  const slot = axisId.startsWith("srcA") ? "A" : axisId.startsWith("srcB") ? "B" : null;
  if (slot) {
    const level = paramValue(base, slot === "A" ? "srcALevel" : "srcBLevel");
    if (level <= 0) return false;
    const engine = paramValue(base, slot === "A" ? "srcAEngine" : "srcBEngine");
    if (axisId.endsWith("Morph") && engine !== ENGINE_WAVETABLE) return false;
    if (axisId.endsWith("Spread")) {
      const unison = paramValue(base, slot === "A" ? "srcAUnison" : "srcBUnison");
      if (unison <= 1) return false;
    }
    return true;
  }
  if (axisId === "morph") {
    // The A↔B blend needs both sides to sound.
    return paramValue(base, "srcALevel") > 0 && paramValue(base, "srcBLevel") > 0;
  }
  return true;
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

/**
 * Draw the next value for one axis.
 *
 * `range` scales the reach: at 1 this is exactly the pre-wave-4 draw, so the
 * control adds capability without silently changing what a seed produces.
 */
function drawAxis(axis: MutationAxis, current: number, draw: () => number, range = 1): number {
  const def = TSAR_PARAM_DEFS[axis.id];
  if (!def) return current;
  const u = (draw() * 2 - 1) * axis.weight * range; // bipolar, weighted
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
 *
 * Deterministic: the same (base, seed, count, range, locks) yields
 * byte-identical variants. The range and the locks are part of the key.
 *
 * Three rules make a variant worth hearing:
 *  - a LOCKED group is never touched (its parameters stay bit-identical);
 *  - a DEAD axis is never touched (see `isMutationAxisLive`);
 *  - the RANGE decides how far, and how many axes, a variant may move.
 */
export function mutateTsarPatch(
  base: Record<string, number>,
  seed: number,
  count = 6,
  options: MutationOptions = {},
): TsarMutation[] {
  const range = Math.max(RANGE_MIN, Math.min(RANGE_MAX, options.range ?? RANGE_MAX));
  const locks = new Set<MutationGroup>(options.locks ?? []);
  // The pool of axes a variant may touch: not locked, and audible here.
  const pool = AXES.filter((axis) => {
    const group = mutationGroupOf(axis.id);
    if (group && locks.has(group)) return false;
    return isMutationAxisLive(axis.id, base);
  });
  if (pool.length === 0) return [];

  // The range decides HOW MUCH of the patch changes — how many axes a
  // variant may touch. It deliberately does NOT shrink the reach: a move
  // scaled to a seventh of its weight changes a number and not a sound, and
  // the reach therefore keeps at least half of its weight even at the
  // gentlest range.
  const reach = REACH_FLOOR + (1 - REACH_FLOOR) * range;

  const draw = lcg(seed);
  const mutations: TsarMutation[] = [];
  for (let index = 0; index < count; index++) {
    // 3–6 axes per variant at full range: readable differences, not a
    // full-patch scramble. A gentler range touches fewer axes.
    const fullTouch = 3 + Math.floor(draw() * 4);
    const touchCount = Math.max(1, Math.min(6, 1 + Math.round((fullTouch - 1) * range)));
    const movedIds = new Set<string>();
    let guard = 0;
    while (movedIds.size < touchCount && guard < 50) {
      guard += 1;
      const axis = pool[Math.floor(draw() * pool.length)]!;
      if (!TSAR_PARAM_DEFS[axis.id]) continue;
      movedIds.add(axis.id);
    }
    const params = { ...base };
    const moved: string[] = [];
    for (const id of movedIds) {
      const axis = pool.find((candidate) => candidate.id === id)!;
      const from = Number.isFinite(params[id]) ? params[id] : TSAR_PARAM_DEFS[id]!.default;
      const to = drawAxis(axis, from, draw, reach);
      if (to === from) continue;
      if (!isMutationValueAudible(axis.id, to)) continue; // the value would change no sound
      params[id] = to;
      moved.push(id);
    }
    if (moved.length === 0) continue; // the draw collapsed — skip, keep the count honest
    // A variant that moved ONLY a spectrum-dependent axis may sound exactly
    // like the original (a cutoff that landed where it does not bite).
    // Numeric difference is not proof of quality, so such a variant is not
    // offered at all.
    if (!moved.some((id) => isSpectrumIndependentAxis(id, base))) continue;
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
      .map((entry) =>
        deltaSummary(
          entry.id,
          Number.isFinite(base[entry.id]) ? base[entry.id] : TSAR_PARAM_DEFS[entry.id]!.default,
          params[entry.id]!,
        ),
      );
    mutations.push({
      id: `m${index + 1}`,
      label: strongest.join(" · "),
      params,
      moved,
    });
  }
  // The skipped-collapse case above can undershoot the requested count; top
  // up deterministically so the ladder always has the promised rounds. The
  // options travel with the top-up — a top-up variant MUST obey the locks.
  let topUp = count;
  while (mutations.length < count && topUp < count * 4) {
    topUp += 1;
    const extra = mutateTsarPatch(base, (seed + topUp * 7919) >>> 0, 1, options);
    if (extra.length > 0) mutations.push({ ...extra[0]!, id: `m${mutations.length + 1}` });
  }
  return mutations.slice(0, count);
}

/**
 * Does this VALUE have an effect?
 *
 * A value can be inside its range and still change nothing: the engine
 * ignores a glide at or below 0.001, so a mutation that lands there would
 * move a number and not a sound.
 */
export function isMutationValueAudible(axisId: string, value: number): boolean {
  if (axisId === "glide") return value > 0.001;
  return true;
}

/**
 * Is this axis's effect independent of where the source sits in the spectrum?
 *
 * A filter cutoff moved while the filter is OPEN may land in a region that
 * does not bite — the numbers change, the sound does not. Every other axis
 * changes the sound whatever the source's spectrum is: an envelope, a
 * tuning anchor, the wavetable frame, the output stage, a generator.
 *
 * A cutoff on an ALREADY CLOSED filter does bite, so it counts there.
 */
export function isSpectrumIndependentAxis(axisId: string, base: Record<string, number>): boolean {
  if (!axisId.endsWith("Cutoff")) return true;
  const slot = axisId.startsWith("srcB") ? "B" : "A";
  const cutoffId = slot === "A" ? "srcACutoff" : "srcBCutoff";
  const max = TSAR_PARAM_DEFS[cutoffId]?.max ?? Number.POSITIVE_INFINITY;
  return paramValue(base, cutoffId) < max - 1e-9;
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
      return {
        id,
        text: deltaSummary(id, from, variant.params[id] ?? from),
        span: Math.abs((variant.params[id] ?? from) - from),
      };
    })
    .filter((entry): entry is { id: string; text: string; span: number } => entry !== null)
    .sort((a, b) => b.span - a.span)
    .slice(0, top)
    .map((entry) => entry.text);
}

/** How many of the shipped TSAR parameters the mutator knows how to move. */
export const MUTATION_AXIS_COUNT = AXES.filter((axis) => TSAR_PARAM_DEFS[axis.id]).length;

/** The named stop a range value belongs to (the closest one at or below it). */
export function mutationRangeLabel(range: number): string {
  let label = MUTATION_RANGES[0]!.label;
  for (const stop of MUTATION_RANGES) {
    if (range + 1e-9 >= stop.value) label = stop.label;
  }
  return label;
}

/**
 * The one-line description of a mutation run — what makes it re-invokable.
 *
 * The seed alone is not enough: the range and the locks are part of the key.
 * Putting the whole key in the panel (and in the winner's history label)
 * means a producer can come back to the exact same variations.
 */
export function describeMutationRun(seed: number, options: MutationOptions = {}): string {
  const range = options.range ?? RANGE_MAX;
  const locks = options.locks ?? [];
  const lockText = locks.length
    ? ` · locks ${locks.map((group) => MUTATION_GROUPS.find((entry) => entry.id === group)?.label ?? group).join(", ")}`
    : "";
  return `seed ${seed} · ${mutationRangeLabel(range)}${lockText}`;
}
