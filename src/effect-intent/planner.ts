import type { EffectInstance, ProjectDocument } from "../project-model/types";
import { EFFECT_DEFS, clampEffectParam } from "../effects/registry";
import { targetEffectsOf } from "../project-model/targets";
import { effectIntentFingerprint } from "./canonical";
import {
  effectIntentCatalogSnapshot,
  effectParameterSchemaFingerprint,
  formatEffectIntentValue,
  supportsEffectIntent,
} from "./catalog";
import { effectIntentMappingsForGoal } from "./capabilities";
import type {
  EffectChangeProposal,
  EffectIntentGoal,
  EffectIntentPlanResult,
  EffectIntentProtectedArea,
  EffectIntentSpec,
  EffectIntentTarget,
} from "./types";
import { EFFECT_INTENT_PARSER_VERSION, EFFECT_INTENT_PLANNER_VERSION, EFFECT_INTENT_SCHEMA_VERSION } from "./types";

function findEffect(doc: ProjectDocument, trackId: string, fxId: string): EffectInstance | undefined {
  return targetEffectsOf(doc, trackId).find((effect) => effect.id === fxId);
}

function validIntent(intent: EffectIntentSpec): boolean {
  const goals = new Set<EffectIntentGoal>(["warmth", "brightness", "space"]);
  const protectedAreas = new Set<EffectIntentProtectedArea>(["lowEnd", "highs", "stereo", "drive"]);
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return false;
  if (
    intent.schemaVersion !== EFFECT_INTENT_SCHEMA_VERSION ||
    intent.parserVersion !== EFFECT_INTENT_PARSER_VERSION ||
    typeof intent.sourceText !== "string" ||
    intent.sourceText.length > 500 ||
    !Array.isArray(intent.goals) ||
    intent.goals.length === 0 ||
    intent.goals.length > 3 ||
    !Array.isArray(intent.preserve)
  ) {
    return false;
  }

  const seenGoals = new Set<EffectIntentGoal>();
  for (const value of intent.goals as unknown[]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const goal = value as Record<string, unknown>;
    if (
      typeof goal.goal !== "string" ||
      !goals.has(goal.goal as EffectIntentGoal) ||
      (goal.direction !== "increase" && goal.direction !== "decrease") ||
      typeof goal.amount !== "number" ||
      !Number.isFinite(goal.amount) ||
      goal.amount < 0 ||
      goal.amount > 1 ||
      seenGoals.has(goal.goal as EffectIntentGoal)
    ) {
      return false;
    }
    seenGoals.add(goal.goal as EffectIntentGoal);
  }

  const seenProtectedAreas = new Set<EffectIntentProtectedArea>();
  for (const value of intent.preserve as unknown[]) {
    if (typeof value !== "string" || !protectedAreas.has(value as EffectIntentProtectedArea)) return false;
    if (seenProtectedAreas.has(value as EffectIntentProtectedArea)) return false;
    seenProtectedAreas.add(value as EffectIntentProtectedArea);
  }
  return true;
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
    return {
      status: "unsupported",
      diagnostics: [`${EFFECT_DEFS[effect.type].name} zatiaľ nemá kurátorované mapovanie pre FX intent.`],
    };
  }

  const catalog = effectIntentCatalogSnapshot(effect);
  const parameterDescriptors = catalog.intentDescriptors;
  const descriptors = new Map(parameterDescriptors.map((descriptor) => [descriptor.id, descriptor]));
  const targetSchemaId = catalog.schemaId;
  if (!targetSchemaId) {
    return { status: "unsupported", diagnostics: ["Parameter schéma zariadenia nemá platnú identitu."] };
  }
  const accumulators = new Map<
    string,
    {
      mode: "add" | "logScale";
      amount: number;
      reasons: string[];
      safeMin: number;
      safeMax: number;
      contributors: Array<{ goal: EffectIntentGoal; sign: -1 | 1 }>;
    }
  >();
  const warnings: string[] = [];
  let usesUnreviewedMapping = false;

  for (const goal of intent.goals) {
    const mappings = effectIntentMappingsForGoal(effect.type, goal.goal);
    if (mappings.length === 0) {
      return {
        status: "unsupported",
        diagnostics: [`${EFFECT_DEFS[effect.type].name} nepodporuje cieľ „${goal.goal}“.`],
      };
    }
    let applicable = 0;
    let protectedCount = 0;
    for (const mapping of mappings) {
      const descriptor = descriptors.get(mapping.paramId);
      if (!descriptor) {
        return {
          status: "unsupported",
          diagnostics: [
            `Kurátorované mapovanie ${mapping.paramId} už nie je dostupné v schéme zariadenia; návrh bol zastavený.`,
          ],
        };
      }
      if (
        descriptor.kind !== "continuous" ||
        !descriptor.intentGoals.includes(goal.goal) ||
        !descriptor.intentMappings.some((candidate) => candidate === mapping)
      ) {
        return {
          status: "unsupported",
          diagnostics: [`Kurátorované mapovanie pre ${descriptor.label} sa nezhoduje s aktuálnou schémou zariadenia.`],
        };
      }
      if (!descriptor.currentIsValid) {
        return {
          status: "unsupported",
          diagnostics: [
            `Aktuálna hodnota parametra ${descriptor.label} je mimo platnej schémy; najprv oprav stav zariadenia.`,
          ],
        };
      }
      if (mapping.evidence === "curated-unreviewed") usesUnreviewedMapping = true;
      if (mapping.risk === "elevated") {
        warnings.push(`Mapovanie parametra ${descriptor.label} má zvýšené riziko; skontroluj celý diff pred Apply.`);
      }
      if (mapping.protects.some((area) => intent.preserve.includes(area))) {
        protectedCount++;
        continue;
      }
      applicable++;
      const signed = goal.direction === "increase" ? 1 : -1;
      const contribution = mapping.positiveStep * goal.amount * signed;
      const existing = accumulators.get(mapping.paramId);
      if (existing && existing.mode !== mapping.mode) {
        return {
          status: "needsClarification",
          diagnostics: [`Ciele sa pokúšajú upraviť ${descriptor.label} nekompatibilnými spôsobmi.`],
        };
      }
      if (existing && contribution !== 0) {
        const opposing = existing.contributors.find((item) => item.sign !== Math.sign(contribution));
        if (opposing) {
          return {
            status: "needsClarification",
            diagnostics: [
              `Ciele „${opposing.goal}“ a „${goal.goal}“ vyžadujú opačné zmeny parametra ${descriptor.label}.`,
            ],
          };
        }
      }
      const accumulator = existing ?? {
        mode: mapping.mode,
        amount: 0,
        reasons: [],
        safeMin: mapping.safeMin,
        safeMax: mapping.safeMax,
        contributors: [],
      };
      accumulator.amount += contribution;
      accumulator.reasons.push(mapping.rationale[goal.direction]);
      if (contribution !== 0)
        accumulator.contributors.push({ goal: goal.goal, sign: Math.sign(contribution) as -1 | 1 });
      accumulator.safeMin = Math.max(accumulator.safeMin, mapping.safeMin);
      accumulator.safeMax = Math.min(accumulator.safeMax, mapping.safeMax);
      accumulators.set(mapping.paramId, accumulator);
    }
    if (applicable === 0 && protectedCount > 0) {
      return {
        status: "unsupported",
        diagnostics: [`Obmedzenia chránia všetky parametre, ktorými by sa dal upraviť cieľ „${goal.goal}".`],
      };
    }
    if (protectedCount > 0)
      warnings.push(
        `Časť mapovania pre „${goal.goal}“ bola vynechaná kvôli zachovaniu zvolených frekvenčných oblastí.`,
      );
  }

  if (usesUnreviewedMapping) {
    warnings.push(
      "Pilotné zvukové mapovanie ešte neprešlo blind golden review; pred Apply si návrh vypočuj, ak je preview dostupné.",
    );
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
    return {
      status: "noChange",
      diagnostics: ["Zariadenie už je na bezpečnej hranici tejto zmeny; návrh by nič nezmenil."],
    };
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
      targetSchemaId,
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
  return (
    !!effect &&
    effect.type === proposal.target.effectType &&
    effectParameterSchemaFingerprint(effect) === proposal.targetSchemaId &&
    effectIntentTargetStateHash(effect) === proposal.baseStateHash
  );
}
