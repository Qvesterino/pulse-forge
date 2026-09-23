import type { EffectType, ProjectDocument } from "../project-model/types";
import { hashString } from "../shared/rng";

/**
 * Production Intent layer (KYX_PRODUCTION_INTENT_ENGINE_MASTER.md §4.3, §19,
 * §21 Phase 1+2): sonic GOALS in natural language — "make the bass deeper" —
 * compiled deterministically into existing KYX effect operations.
 *
 * v1 is intentionally narrow (master doc §22): 9 concepts × a handful of
 * targets, comparative/imperative phrasing only, no models. SK extends
 * DETECTION; canonical concept ids stay English (repo convention).
 *
 * Language proposes intent. KYX owns execution.
 */

export type ProductionConcept =
  | "deeper"
  | "punchier"
  | "warmer"
  | "darker"
  | "brighter"
  | "wider"
  | "grittier"
  | "glue"
  | "lofi"
  | "wobbly"
  | "robotic"
  | "metallic";

export type ProductionTarget = "drums" | "bass" | "lead" | "chords" | "kick" | "snare" | "hats";

export interface ProductionGoal {
  concept: ProductionConcept;
  amount: number; // 0..1, default 0.7
}

export interface ProductionIntent {
  targets: ProductionTarget[];
  goals: ProductionGoal[];
  sourceText: string;
  /**
   * ELEMENT-LEVEL targets (vibe-code wave): "kick more knock" names a PAD
   * family inside the drum track. The planner adds per-pad gain
   * adjustments on top of the track FX.
   */
  padTargets?: Array<"kick" | "snare" | "hats">;
}

/** One planned DSP change on one track — params fold over effect defaults. */
export interface ProductionAction {
  trackId: string;
  type: EffectType;
  params: Record<string, number>;
  /** beatMangler only — 16-step volume/pitch envelope planted with the instance. */
  volumeSteps?: number[];
  pitchSteps?: number[];
}

export interface ProductionPlan {
  label: string;
  summary: string;
  actions: ProductionAction[];
  /** Per-pad gain adjustments for pad-family targets (element-level intents). */
  padAdjustments?: Array<{ family: "kicks" | "snares" | "hats"; factor: number }>;
}

/**
 * Concept → per-pad gain factor for pad-family targets. All concepts are
 * intensifiers, so every factor leans ≥ 1; amounts scale the step.
 */
const PAD_CONCEPT_FACTOR: Partial<Record<ProductionConcept, number>> = {
  punchier: 1.3,
  deeper: 1.15,
  grittier: 1.2,
  warmer: 1.05,
  metallic: 1.1,
  robotic: 1.1,
  wobbly: 1.15,
  brighter: 1.05,
  glue: 1.1,
  lofi: 0.9,
};

interface ConceptDef {
  concept: ProductionConcept;
  /** Detection regexes — comparative/imperative forms (SK extends detection). */
  patterns: RegExp[];
  /** Default target when the text names none. */
  defaultTarget: ProductionTarget;
}

export const PRODUCTION_CONCEPTS: readonly ProductionConcept[] = [
  "deeper",
  "punchier",
  "warmer",
  "darker",
  "brighter",
  "wider",
  "grittier",
  "glue",
  "lofi",
  "wobbly",
  "robotic",
  "metallic",
];

export const PRODUCTION_TARGETS: readonly ProductionTarget[] = ["drums", "bass", "lead", "chords"];

/** Exposed for section-scoped FX parsing ("vinyl break") in intent/sections.ts. */
export const CONCEPTS: readonly ConceptDef[] = [
  {
    concept: "deeper",
    defaultTarget: "bass",
    patterns: [/\bdeeper\b/, /\bhlb\u0161(ia|\u00ed|ie|\u00fd)?\b/, /\bsub-ier\b/, /\bhlb\u010d\b/],
  },
  {
    concept: "punchier",
    defaultTarget: "drums",
    patterns: [/\bpunchier\b/, /\bmore punch\b/, /\bknock\b/, /\bv\u00e4\u010d\u0161\u00ed punch\b/, /\brazantnej/i],
  },
  {
    concept: "warmer",
    defaultTarget: "bass",
    patterns: [/\bwarmer\b/, /\bteplej\u0161(ia|\u00ed|ie)?\b/],
  },
  {
    concept: "darker",
    defaultTarget: "drums",
    patterns: [/\bdarker\b/, /\btmav\u0161(ia|\u00ed|ie)?\b/],
  },
  {
    concept: "brighter",
    defaultTarget: "drums",
    patterns: [/\bbrighter\b/, /\bsvetlej\u0161(ia|\u00ed|ie)?\b/],
  },
  {
    concept: "wider",
    defaultTarget: "lead",
    patterns: [/\bwider\b/, /\b\u0161ir\u0161(ia|\u00ed|ie)?\b/],
  },
  {
    concept: "grittier",
    defaultTarget: "drums",
    patterns: [
      /\bgrittier\b/,
      /\bdirtier\b/,
      /\b\u0161pinavej\u0161(ia|\u00ed|ie)?\b/,
      /\bmore grit\b/,
      /\bviac gritu\b/,
    ],
  },
  {
    concept: "glue",
    defaultTarget: "drums",
    patterns: [/\bmore glue\b/, /\bviac lepidla\b/, /\bglue(?:-?ier)?\b/],
  },
  {
    concept: "lofi",
    defaultTarget: "drums",
    patterns: [/\blo-?fi(er)?\b/, /\bvinyl(?:-?ier)?\b/, /\bvintage(?:-?r)?\b/, /\bstar\u0161\u00ed zvuk\b/],
  },
  {
    concept: "wobbly",
    defaultTarget: "drums",
    patterns: [/\bwobbl/i, /\bhoupav/i, /\bweird(er)?\b/i, /\bskreslen/i],
  },
  {
    concept: "robotic",
    defaultTarget: "lead",
    patterns: [/\brobot/i, /\brobotick/i, /\bmachine-?like\b/i],
  },
  {
    concept: "metallic",
    defaultTarget: "drums",
    patterns: [/\bmetallic/i, /\bkovov/i, /\bmetalov/i],
  },
];

const TARGET_PATTERNS: [RegExp, ProductionTarget][] = [
  [/((?:^|[^a-z0-9])kicks?(?:[^a-z0-9]|$))|kopák|((?:^|[^a-z0-9])808(?:[^a-z0-9]|$))/i, "kick"],
  [/((?:^|[^a-z0-9])snares?(?:[^a-z0-9]|$))|claps?|ženír/i, "snare"],
  [/hi-?hats?|((?:^|[^a-z0-9])hats?(?:[^a-z0-9]|$))|činel/i, "hats"],
  [/\bdrums?\b|\bbic\u00edc|\bbubny\b/i, "drums"],
  [/\bbass\b|\b808\b|\bsub\b|\bbasa\b/i, "bass"],
  [/\blead\b|\bsynth\b|\bsynt\u00e9z/i, "lead"],
  [/\bchords?\b|\bkeys?\b|\bakord/i, "chords"],
];

/**
 * True when the text explicitly names a production target track family
 * ("the drums", "the bass", …). The unified router uses this to give a
 * TARGETED production intent precedence over the global mix profile —
 * "make the drums darker" names where, so the change lands on the drums
 * track, not on the master tilt.
 */
export function namesProductionTarget(text: string): boolean {
  return TARGET_PATTERNS.some(([re]) => re.test(text));
}

/** Default amounts — modifiers ("much", "slightly") scale around these. */
const DEFAULT_AMOUNT = 0.7;

function detectAmount(lower: string): number {
  if (/\b(much|a lot|way|harder|ve\u013emi|dos\u0165|poriadne)\b/.test(lower)) return 0.9;
  if (/\b(slightly|a bit|a little|trochu|mierne|jemne)\b/.test(lower)) return 0.45;
  return DEFAULT_AMOUNT;
}

/**
 * Parse a production intent from free text. Returns null when the text is a
 * generation intent (no comparative/imperative production phrase matched) —
 * the caller then falls back to the pattern-generation pipeline.
 */
export function parseProductionIntent(text: string): ProductionIntent | null {
  const lower = text.toLowerCase();
  const goals: ProductionGoal[] = [];
  for (const def of CONCEPTS) {
    if (def.patterns.some((re) => re.test(lower))) {
      goals.push({ concept: def.concept, amount: detectAmount(lower) });
    }
  }
  if (goals.length === 0) return null;

  const targets: ProductionTarget[] = [];
  for (const [re, target] of TARGET_PATTERNS) {
    if (re.test(lower) && !targets.includes(target)) targets.push(target);
  }
  if (targets.length === 0) {
    // No target named — each concept falls back to its natural home.
    for (const goal of goals) {
      const def = CONCEPTS.find((c) => c.concept === goal.concept)!;
      if (!targets.includes(def.defaultTarget)) targets.push(def.defaultTarget);
    }
  }

  // ELEMENT-LEVEL targets: pad families ride along separately so the
  // planner can add per-pad adjustments on top of the track FX.
  const padTargets = targets.filter(
    (target): target is "kick" | "snare" | "hats" => target === "kick" || target === "snare" || target === "hats",
  );

  return { targets, goals, sourceText: text, padTargets: padTargets.length > 0 ? padTargets : undefined };
}

/**
 * Resolve targets to concrete track ids. Throws with an actionable message
 * when a named target has no matching track — production intents must fail
 * clearly rather than silently doing nothing (master doc §17.12).
 */
export function resolveProductionTargets(doc: ProjectDocument, targets: ProductionTarget[]): string[] {
  const ids: string[] = [];
  for (const target of targets) {
    if (target === "drums" || target === "kick" || target === "snare" || target === "hats") {
      // Pad-family targets land on the drum track too — the per-pad part
      // rides in plan.padAdjustments, the track FX apply normally.
      const drum = doc.tracks.find((t) => t.kind === "drum");
      if (drum) ids.push(drum.id);
      continue;
    }
    const instruments = doc.tracks.filter((t) => t.kind === "instrument");
    const match =
      instruments.find((t) => {
        if (target === "bass") {
          return ["bass", "808", "logdrum"].includes(t.instrument) || /\bbass\b|\b808\b|\bsub\b/i.test(t.name);
        }
        if (target === "chords") {
          return /\bchord|\bkeys?\b|\bpad\b/i.test(t.name) || t.instrument === "keys";
        }
        return /\blead\b|\bsynth\b|\bpluck\b/i.test(t.name) || ["lead", "pluck", "spectral"].includes(t.instrument);
      }) ?? (target === "lead" ? instruments[0] : undefined);
    if (match) ids.push(match.id);
  }
  return [...new Set(ids)];
}

/**
 * Deterministic planner: concept × target → concrete effect operations.
 * Folded over effect DEFAULTS (never raw guesses) with the goal amount
 * scaling the primary parameter. One mechanism per concept in v1 — the
 * planner stays explainable (master doc §15 keeps multi-candidate ranking
 * for later phases).
 */
export function planProductionActions(
  doc: ProjectDocument,
  intent: ProductionIntent,
): { actions: ProductionAction[]; padAdjustments?: Array<{ family: "kicks" | "snares" | "hats"; factor: number }>; plan: ProductionPlan } {
  const trackIds = resolveProductionTargets(doc, intent.targets);
  if (trackIds.length === 0) {
    throw new Error(
      `No matching track for targets: ${intent.targets.join(", ")} — add the track first or name another target`,
    );
  }
  const actions: ProductionAction[] = [];
  for (const trackId of trackIds) {
    for (const goal of intent.goals) {
      switch (goal.concept) {
        case "deeper":
          actions.push({
            trackId,
            type: "pitchShift",
            params: { semitones: -Math.round(2 + goal.amount * 5), grainMs: 65, mix: 1 },
          });
          break;
        case "punchier":
          actions.push({
            trackId,
            type: "transient",
            params: { attack: Math.min(1, 0.25 + goal.amount * 0.6), sustain: -0.5 * goal.amount, mix: 1 },
          });
          break;
        case "warmer":
          actions.push({
            trackId,
            type: "tapeSat",
            params: {
              drive: Math.min(1, 0.2 + goal.amount * 0.5),
              tone: Math.round(6500 - goal.amount * 2500),
              mix: 1,
            },
          });
          break;
        case "darker":
          actions.push({
            trackId,
            type: "svFilter",
            params: { cutoff: Math.round(16000 / Math.pow(10, goal.amount * 1.2)), mode: 0, mix: 1 },
          });
          break;
        case "brighter":
          actions.push({
            trackId,
            type: "svFilter",
            params: { mode: 3, cutoff: Math.round(120 + goal.amount * 260), mix: 1 },
          });
          break;
        case "wider":
          actions.push({
            trackId,
            type: "haasWidener",
            params: { width: Math.min(1, 0.25 + goal.amount * 0.6), delayMs: 14 },
          });
          break;
        case "grittier":
          actions.push({
            trackId,
            type: "distortion",
            params: { drive: Math.min(1, 0.15 + goal.amount * 0.65), tone: 6000, mix: 1 },
          });
          break;
        case "glue":
          actions.push({
            trackId,
            type: "drumBuss",
            params: { compressor: Math.min(1, 0.25 + goal.amount * 0.45), drive: 0.25, mix: 1 },
          });
          break;
        case "lofi":
          actions.push({
            trackId,
            type: "vinyl",
            params: { amount: Math.min(1, 0.3 + goal.amount * 0.6), crackle: 0.5, wow: 0.5, year: 0.7, mix: 1 },
          });
          break;
        case "wobbly":
          actions.push({
            trackId,
            type: "beatMangler",
            params: { playMode: 0, repeatFill: 4, mix: 1 },
            volumeSteps: [1, 0.35, 1, 0.55, 1, 0.35, 1, 0.55, 1, 0.35, 1, 0.55, 1, 0.35, 1, 0.55],
            pitchSteps: [0, 0, 12, 0, 0, -12, 0, 0, 0, 0, 12, 0, -12, 0, 0, 0],
          });
          break;
        case "robotic":
          actions.push({
            trackId,
            type: "ringMod",
            params: { frequency: 95, feedback: 0.4, mix: 0.9 },
          });
          break;
        case "metallic":
          actions.push({
            trackId,
            type: "freqShifter",
            params: { shift: Math.round(300 + goal.amount * 500), mix: 0.9 },
          });
          break;
      }
    }
  }
  // ELEMENT-LEVEL: pad families named in the intent get per-pad gain
  // adjustments scaled by the concepts aimed at them — on top of the
  // track FX actions above.
  const FAMILY_ALIAS: Record<"kick" | "snare" | "hats", "kicks" | "snares" | "hats"> = {
    kick: "kicks",
    snare: "snares",
    hats: "hats",
  };
  const padAdjustments = (intent.padTargets ?? []).map((family) => {
    const factor = intent.goals.reduce((product, goal) => {
      const per = PAD_CONCEPT_FACTOR[goal.concept] ?? 1.1;
      return product * (1.0 + (per - 1.0) * goal.amount);
    }, 1.0);
    return { family: FAMILY_ALIAS[family], factor: Math.round(factor * 100) / 100 };
  });

  const summary = intent.goals.map((g) => `${g.concept} ×${g.amount.toFixed(2)}`).join(", ");
  return {
    actions,
    padAdjustments: (intent.padTargets ?? []).length > 0 ? padAdjustments : undefined,
    plan: {
      label: `Production: ${intent.targets.join("+")} → ${intent.goals.map((g) => g.concept).join(", ")}`,
      summary: `${summary} on ${trackIds.length} track(s)`,
      actions,
    },
  };
}

/** Stable display hash for provenance (intent text + goals). */
export function productionIntentHash(intent: ProductionIntent): string {
  return hashString(`${intent.sourceText}|${intent.goals.map((g) => `${g.concept}:${g.amount}`).join("|")}`).toString(
    36,
  );
}

/**
 * Sanitize untrusted fx data (normalized intents carry it through share
 * codes, song builds and candidate plans). Returns null unless the shape is
 * a valid ProductionIntent with known concepts/targets — an invalid fx field
 * must never reject the whole intent.
 */
export function sanitizeFxIntent(raw: unknown): ProductionIntent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.targets) || !Array.isArray(r.goals)) return null;
  const targets = [...new Set(r.targets.filter((t): t is ProductionTarget => PRODUCTION_TARGETS.includes(t as never)))];
  const goals: ProductionGoal[] = [];
  for (const goal of r.goals) {
    if (typeof goal !== "object" || goal === null) continue;
    const g = goal as Record<string, unknown>;
    if (typeof g.concept !== "string" || !PRODUCTION_CONCEPTS.includes(g.concept as never)) continue;
    const amount =
      typeof g.amount === "number" && Number.isFinite(g.amount) ? Math.min(1, Math.max(0, g.amount)) : DEFAULT_AMOUNT;
    goals.push({ concept: g.concept as ProductionConcept, amount });
  }
  if (goals.length === 0) return null;
  return {
    targets,
    goals,
    sourceText: typeof r.sourceText === "string" ? r.sourceText.slice(0, 500) : "",
  };
}
