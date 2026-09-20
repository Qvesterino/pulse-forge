import type { EffectInstance, EffectType, ProjectDocument } from "../project-model/types";
import { EFFECT_DEFS, clampEffectParam } from "../effects/registry";
import { targetEffectsOf } from "../project-model/targets";
import { effectIntentFingerprint } from "./canonical";
import { effectIntentParameterCatalog, formatEffectIntentValue, supportsEffectIntent } from "./catalog";
import type {
  EffectChangeProposal,
  EffectIntentGoal,
  EffectIntentPlanResult,
  EffectIntentProtectedArea,
  EffectIntentSpec,
  EffectIntentTarget,
} from "./types";
import {
  EFFECT_INTENT_PARSER_VERSION,
  EFFECT_INTENT_PLANNER_VERSION,
  EFFECT_INTENT_SCHEMA_VERSION,
} from "./types";

interface ParameterRule {
  paramId: string;
  /** Signed change when the named goal moves in its positive direction. */
  amount: number;
  mode: "add" | "logScale";
  protects: readonly EffectIntentProtectedArea[];
  safeMin?: number;
  safeMax?: number;
  rationale: (direction: "increase" | "decrease") => string;
}

const RULES: Partial<Record<EffectType, Partial<Record<EffectIntentGoal, readonly ParameterRule[]>>>> = {
  eq: {
    warmth: [
      {
        paramId: "lowShelfGain",
        amount: 0.8,
        mode: "add",
        protects: ["lowEnd"],
        safeMin: -4,
        safeMax: 4,
        rationale: (direction) => (direction === "increase" ? "jemne pridá telo v nízkych frekvenciách" : "jemne uberie telo v nízkych frekvenciách"),
      },
      {
        paramId: "highShelfGain",
        amount: -0.7,
        mode: "add",
        protects: ["highs"],
        safeMin: -4,
        safeMax: 4,
        rationale: (direction) => (direction === "increase" ? "zjemní horný shelf pre teplejší tón" : "otvorí horný shelf pre chladnejší tón"),
      },
    ],
    brightness: [
      {
        paramId: "highShelfGain",
        amount: 1.1,
        mode: "add",
        protects: ["highs"],
        safeMin: -4,
        safeMax: 4,
        rationale: (direction) => (direction === "increase" ? "jemne otvorí horný shelf" : "jemne stlmí horný shelf"),
      },
    ],
  },
  reverb: {
    warmth: [
      {
        paramId: "tone",
        amount: -0.14,
        mode: "logScale",
        protects: ["highs"],
        safeMin: 900,
        safeMax: 9000,
        rationale: (direction) => (direction === "increase" ? "stlmí jasnosť dozvuku pre teplejší priestor" : "otvorí dozvuk pre chladnejší tón"),
      },
    ],
    brightness: [
      {
        paramId: "tone",
        amount: 0.14,
        mode: "logScale",
        protects: ["highs"],
        safeMin: 900,
        safeMax: 9000,
        rationale: (direction) => (direction === "increase" ? "otvorí horné frekvencie dozvuku" : "zjemní horné frekvencie dozvuku"),
      },
    ],
    space: [
      {
        paramId: "mix",
        amount: 0.075,
        mode: "add",
        protects: ["highs"],
        safeMin: 0,
        safeMax: 0.75,
        rationale: (direction) => (direction === "increase" ? "pridá trochu mokrého dozvuku" : "stiahne množstvo mokrého dozvuku"),
      },
      {
        paramId: "decay",
        amount: Math.log(1.22),
        mode: "logScale",
        protects: [],
        safeMin: 0.25,
        safeMax: 4.5,
        rationale: (direction) => (direction === "increase" ? "predĺži dozvuk pre väčší priestor" : "skráti dozvuk pre suchší výsledok"),
      },
    ],
  },
};

function findEffect(doc: ProjectDocument, trackId: string, fxId: string): EffectInstance | undefined {
  return targetEffectsOf(doc, trackId).find((effect) => effect.id === fxId);
}

function validIntent(intent: EffectIntentSpec): boolean {
  const goals = new Set<EffectIntentGoal>(["warmth", "brightness", "space"]);
  const protectedAreas = new Set<EffectIntentProtectedArea>(["lowEnd", "highs", "stereo", "drive"]);
  const seenGoals = new Set<EffectIntentGoal>();
  const seenProtectedAreas = new Set<EffectIntentProtectedArea>();
  if (Array.isArray(intent?.goals)) {
    for (const goal of intent.goals) {
      if (seenGoals.has(goal.goal)) return false;
      seenGoals.add(goal.goal);
    }
  }
  if (Array.isArray(intent?.preserve)) {
    for (const area of intent.preserve) {
      if (seenProtectedAreas.has(area)) return false;
      seenProtectedAreas.add(area);
    }
  }
  return (
    !!intent &&
    intent.schemaVersion === EFFECT_INTENT_SCHEMA_VERSION &&
    intent.parserVersion === EFFECT_INTENT_PARSER_VERSION &&
    typeof intent.sourceText === "string" &&
    intent.sourceText.length <= 500 &&
    Array.isArray(intent.goals) &&
    intent.goals.length > 0 &&
    intent.goals.length <= 3 &&
    intent.goals.every(
      (goal) =>
        goals.has(goal.goal) &&
        (goal.direction === "increase" || goal.direction === "decrease") &&
        Number.isFinite(goal.amount) &&
        goal.amount >= 0 &&
        goal.amount <= 1,
    ) &&
    Array.isArray(intent.preserve) &&
    intent.preserve.every((area) => protectedAreas.has(area))
  );
}

export function effectIntentTargetStateHash(effect: EffectInstance): string {
  return effectIntentFingerprint(effect);
}

export function planEffectIntent(
  doc: ProjectDocument,
  target: EffectIntentTarget,
  intent: EffectIntentSpec,
): EffectIntentPlanResult {
  if (!validIntent(intent)) {
    return { status: "unsupported", diagnostics: ["FX intent má neplatnú alebo nepodporovanú schému."] };
  }
  if (typeof target?.trackId !== "string" || typeof target.fxId !== "string" || !target.trackId || !target.fxId) {
    return { status: "unsupported", diagnostics: ["FX intent nemá platný cieľ zariadenia."] };
  }
  const effect = findEffect(doc, target.trackId, target.fxId);
  if (!effect) return { status: "unsupported", diagnostics: ["Vybrané zariadenie už v projekte neexistuje."] };
  if (effect.type !== target.effectType) {
    return { status: "unsupported", diagnostics: ["Typ vybraného zariadenia sa medzičasom zmenil."] };
  }
  if (!supportsEffectIntent(effect.type)) {
    return { status: "unsupported", diagnostics: [`${EFFECT_DEFS[effect.type].name} zatiaľ nemá kurátorované mapovanie pre FX intent.`] };
  }

  const descriptors = new Map(effectIntentParameterCatalog(effect).map((descriptor) => [descriptor.id, descriptor]));
  const accumulators = new Map<
    string,
    { mode: ParameterRule["mode"]; amount: number; reasons: string[]; safeMin: number; safeMax: number }
  >();
  const warnings: string[] = [];

  for (const goal of intent.goals) {
    const rules = RULES[effect.type]?.[goal.goal];
    if (!rules?.length) {
      return { status: "unsupported", diagnostics: [`${EFFECT_DEFS[effect.type].name} nepodporuje cieľ „${goal.goal}“.`] };
    }
    let applicable = 0;
    let protectedCount = 0;
    for (const rule of rules) {
      const descriptor = descriptors.get(rule.paramId);
      if (!descriptor || descriptor.kind !== "continuous" || !descriptor.intentGoals.includes(goal.goal)) continue;
      if (rule.protects.some((area) => intent.preserve.includes(area))) {
        protectedCount++;
        continue;
      }
      applicable++;
      const signed = goal.direction === "increase" ? 1 : -1;
      const contribution = rule.amount * goal.amount * signed;
      const existing = accumulators.get(rule.paramId);
      if (existing && existing.mode !== rule.mode) {
        return {
          status: "needsClarification",
          diagnostics: [`Ciele sa pokúšajú upraviť ${descriptor.label} nekompatibilnými spôsobmi.`],
        };
      }
      const accumulator = existing ?? {
        mode: rule.mode,
        amount: 0,
        reasons: [],
        safeMin: rule.safeMin ?? descriptor.min,
        safeMax: rule.safeMax ?? descriptor.max,
      };
      accumulator.amount += contribution;
      accumulator.reasons.push(rule.rationale(goal.direction));
      accumulator.safeMin = Math.max(accumulator.safeMin, rule.safeMin ?? descriptor.min);
      accumulator.safeMax = Math.min(accumulator.safeMax, rule.safeMax ?? descriptor.max);
      accumulators.set(rule.paramId, accumulator);
    }
    if (applicable === 0 && protectedCount > 0) {
      return {
        status: "unsupported",
        diagnostics: [`Obmedzenia chránia všetky parametre, ktorými by sa dal upraviť cieľ „${goal.goal}".`],
      };
    }
    if (protectedCount > 0) warnings.push(`Časť mapovania pre „${goal.goal}“ bola vynechaná kvôli zachovaniu zvolených frekvenčných oblastí.`);
  }

  const changes: EffectChangeProposal["changes"] = [];
  for (const [paramId, accumulator] of accumulators) {
    const descriptor = descriptors.get(paramId);
    if (!descriptor) continue;
    const before = effect.params[paramId] ?? descriptor.default;
    const raw = accumulator.mode === "add" ? before + accumulator.amount : before * Math.exp(accumulator.amount);
    const safe = Math.min(accumulator.safeMax, Math.max(accumulator.safeMin, raw));
    const after = clampEffectParam(effect.type, paramId, Math.round(safe * 1_000_000) / 1_000_000);
    if (after === before) continue;
    changes.push({
      paramId,
      label: descriptor.label,
      before,
      after,
      beforeText: formatEffectIntentValue(effect.type, paramId, before),
      afterText: formatEffectIntentValue(effect.type, paramId, after),
      rationale: [...new Set(accumulator.reasons)].join("; "),
    });
  }

  if (changes.length === 0) {
    return { status: "noChange", diagnostics: ["Zariadenie už je na bezpečnej hranici tejto zmeny; návrh by nič nezmenil."] };
  }

  const name = EFFECT_DEFS[effect.type].name;
  const summary = intent.goals
    .map(({ goal, direction }) => {
      const labels: Record<EffectIntentGoal, Record<"increase" | "decrease", string>> = {
        warmth: { increase: "teplejšie", decrease: "chladnejšie" },
        brightness: { increase: "jasnejšie", decrease: "tmavšie" },
        space: { increase: "viac priestoru", decrease: "menej priestoru" },
      };
      return labels[goal][direction];
    })
    .join(" + ");
  return {
    status: "ready",
    proposal: {
      schemaVersion: EFFECT_INTENT_SCHEMA_VERSION,
      plannerVersion: EFFECT_INTENT_PLANNER_VERSION,
      target: { ...target },
      baseStateHash: effectIntentTargetStateHash(effect),
      intent,
      summary: `${name}: ${summary}`,
      changes,
      warnings: [...new Set(warnings)],
    },
  };
}

export function isEffectIntentProposalCurrent(doc: ProjectDocument, proposal: EffectChangeProposal): boolean {
  const effect = findEffect(doc, proposal.target.trackId, proposal.target.fxId);
  return !!effect && effect.type === proposal.target.effectType && effectIntentTargetStateHash(effect) === proposal.baseStateHash;
}
