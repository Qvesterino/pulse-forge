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
  "deeper" | "punchier" | "warmer" | "darker" | "brighter" | "wider" | "grittier" | "glue" | "lofi";

export type ProductionTarget = "drums" | "bass" | "lead" | "chords";

export interface ProductionGoal {
  concept: ProductionConcept;
  amount: number; // 0..1, default 0.7
}

export interface ProductionIntent {
  targets: ProductionTarget[];
  goals: ProductionGoal[];
  sourceText: string;
}

/** One planned DSP change on one track — params fold over effect defaults. */
export interface ProductionAction {
  trackId: string;
  type: EffectType;
  params: Record<string, number>;
}

export interface ProductionPlan {
  label: string;
  summary: string;
  actions: ProductionAction[];
}

interface ConceptDef {
  concept: ProductionConcept;
  /** Detection regexes — comparative/imperative forms (SK extends detection). */
  patterns: RegExp[];
  /** Default target when the text names none. */
  defaultTarget: ProductionTarget;
}

const CONCEPTS: ConceptDef[] = [
  {
    concept: "deeper",
    defaultTarget: "bass",
    patterns: [/\bdeeper\b/, /\bhlb\u0161(ia|\u00ed|ie|\u00fd)?\b/, /\bsub-ier\b/, /\bhlb\u010d\b/],
  },
  {
    concept: "punchier",
    defaultTarget: "drums",
    patterns: [/\bpunchier\b/, /\bmore punch\b/, /\bv\u00e4\u010d\u0161\u00ed punch\b/, /\braza(ntn)?\u017enej\u0161/i],
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
];

const TARGET_PATTERNS: [RegExp, ProductionTarget][] = [
  [/\bdrums?\b|\bbic\u00edc|\bbubny\b/i, "drums"],
  [/\bbass\b|\b808\b|\bsub\b|\bbasa\b/i, "bass"],
  [/\blead\b|\bsynth\b|\bsynt\u00e9z/i, "lead"],
  [/\bchords?\b|\bkeys?\b|\bakord/i, "chords"],
];

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

  return { targets, goals, sourceText: text };
}

/**
 * Resolve targets to concrete track ids. Throws with an actionable message
 * when a named target has no matching track — production intents must fail
 * clearly rather than silently doing nothing (master doc §17.12).
 */
export function resolveProductionTargets(doc: ProjectDocument, targets: ProductionTarget[]): string[] {
  const ids: string[] = [];
  for (const target of targets) {
    if (target === "drums") {
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
): { actions: ProductionAction[]; plan: ProductionPlan } {
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
      }
    }
  }
  const summary = intent.goals.map((g) => `${g.concept} ×${g.amount.toFixed(2)}`).join(", ");
  return {
    actions,
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
