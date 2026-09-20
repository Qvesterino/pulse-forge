import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { EffectInstance, EffectType, ProjectDocument } from "../src/project-model/types";
import { clampEffectParam, EFFECT_DEFS } from "../src/effects/registry";
import { buildSchema as buildFxEqSchema } from "../src/effects/fxeq-core/core/parameterSchema";
import { ALL_PARAMS as ULTINA_PARAMS } from "../src/effects/ultina-core/contracts/parameterSchema";
import { effectTargetParamDefs } from "../src/project-model/targets";
import {
  effectParameterDescriptorCatalog,
  effectParameterSchemaFingerprint,
  effectIntentCatalogCoverageReport,
  EFFECT_INTENT_MAPPINGS,
  applyEffectIntentProposal,
  effectIntentParameterCatalog,
  isEffectIntentProposalCurrent,
  parseEffectIntent,
  planEffectIntent,
} from "../src/effect-intent";
import { canonicalEffectIntentJson } from "../src/effect-intent/canonical";

function docWithEffect(
  type: EffectType,
  params: Record<string, number> = {},
): { doc: ProjectDocument; trackId: string; fx: EffectInstance } {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
  const fx: EffectInstance = { id: `fx-${type}`, type, bypassed: false, params };
  track.effects = [fx];
  return { doc, trackId: track.id, fx };
}

function readyIntent(text: string) {
  const result = parseEffectIntent(text);
  if (result.status !== "ready") throw new Error(result.diagnostics.join(" "));
  return result.intent;
}

function readyProposal(doc: ProjectDocument, trackId: string, fx: EffectInstance, text: string) {
  const result = planEffectIntent(doc, { trackId, fxId: fx.id, effectType: fx.type }, readyIntent(text));
  if (result.status !== "ready") throw new Error(result.diagnostics.join(" "));
  return result.proposal;
}

describe("Effect Intent Engine — offline parser", () => {
  it("normalizes Slovak diacritics and preserves explicit spectral constraints", () => {
    const result = parseEffectIntent("Trochu teplejšie, ale nechaj výšky a stereo tak");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.intent.goals).toEqual([{ goal: "warmth", direction: "increase", amount: 0.3 }]);
    expect(result.intent.preserve).toEqual(["highs", "stereo"]);
  });

  it("parses English goals and subtle intensity deterministically", () => {
    const first = parseEffectIntent("make it slightly brighter");
    const second = parseEffectIntent("make it slightly brighter");
    expect(first).toEqual(second);
    expect(first.status).toBe("ready");
    if (first.status === "ready")
      expect(first.intent.goals[0]).toMatchObject({ goal: "brightness", direction: "increase", amount: 0.3 });
  });

  it("accepts compatible compound goals and rejects contradictory intensity", () => {
    const compatible = parseEffectIntent("warmer and more space");
    expect(compatible.status).toBe("ready");
    const conflict = parseEffectIntent("slightly warmer but much brighter");
    expect(conflict.status).toBe("needsClarification");
  });

  it("does not reinterpret unknown style claims or implicit negation", () => {
    expect(parseEffectIntent("make it professional").status).toBe("unsupported");
    expect(parseEffectIntent("not brighter").status).toBe("unsupported");
  });

  it("asks for a goal when the request only contains preservation constraints", () => {
    expect(parseEffectIntent("keep the highs unchanged").status).toBe("needsClarification");
  });
});

describe("Effect Intent Engine — curated descriptors and planner", () => {
  it("adapts every rack ParamDef without implying that every parameter is intent-editable", () => {
    for (const typeName of Object.keys(EFFECT_DEFS)) {
      const type = typeName as EffectType;
      const definition = EFFECT_DEFS[type];
      const params = Object.fromEntries(definition.params.map((param) => [param.id, param.default]));
      const fx: EffectInstance = { id: `fx-${type}`, type, bypassed: false, params };
      const before = structuredClone(fx);
      const descriptors = effectParameterDescriptorCatalog(fx).filter((descriptor) => descriptor.source === "rack");

      expect(descriptors.map((descriptor) => descriptor.id)).toEqual(definition.params.map((param) => param.id));
      expect(descriptors.every((descriptor) => descriptor.currentIsValid)).toBe(true);
      expect(effectParameterDescriptorCatalog(fx).filter((descriptor) => descriptor.source === "rack")).toEqual(
        descriptors,
      );
      expect(fx).toEqual(before);
    }

    const { fx } = docWithEffect("delay");
    expect(effectParameterDescriptorCatalog(fx).length).toBeGreaterThan(0);
    expect(effectIntentParameterCatalog(fx)).toEqual([]);
  });

  it("reports malformed technical values without silently mutating or hiding them", () => {
    const { fx } = docWithEffect("eq");
    fx.params.hpFreq = 1_000_000;

    const descriptor = effectParameterDescriptorCatalog(fx).find((candidate) => candidate.id === "hpFreq");
    expect(descriptor?.current).toBe(1_000_000);
    expect(descriptor?.currentIsValid).toBe(false);
    expect(fx.params.hpFreq).toBe(1_000_000);
  });

  it("adapts FXEQ deep descriptors from the authoritative active-band schema", () => {
    const schemas = [2, 4, 6].map((bandCount) => {
      const { fx } = docWithEffect("fxeq", { bandCount, mix: 42 });
      const descriptors = effectParameterDescriptorCatalog(fx);
      const schema = buildFxEqSchema(bandCount);
      const rackIds = new Set(EFFECT_DEFS.fxeq.params.map((param) => param.id));
      const expectedDeepIds = schema.defs
        .filter((def) => !rackIds.has(def.id) && def.id !== "globalMix")
        .map((def) => def.id);
      const deepDescriptors = descriptors.filter((descriptor) => descriptor.source === "fxeq");

      expect(deepDescriptors.map((descriptor) => descriptor.id)).toEqual(expectedDeepIds);
      expect(deepDescriptors.every((descriptor) => descriptor.schemaId === deepDescriptors[0].schemaId)).toBe(true);
      expect(descriptors.filter((descriptor) => descriptor.id === "mix")).toHaveLength(1);
      expect(descriptors.some((descriptor) => descriptor.id === "globalMix")).toBe(false);
      expect(descriptors.some((descriptor) => descriptor.id === "band1.gainDb" && descriptor.automationSupported)).toBe(
        true,
      );
      expect(
        descriptors.some(
          (descriptor) =>
            descriptor.id === "band1.enabled" && descriptor.kind === "toggle" && !descriptor.automationSupported,
        ),
      ).toBe(true);
      expect(
        descriptors.some((descriptor) => descriptor.id === "band1.satEnabled" && descriptor.kind === "toggle"),
      ).toBe(true);
      expect(
        descriptors.some(
          (descriptor) =>
            descriptor.id === "band1.satMode" &&
            descriptor.kind === "unknown" &&
            descriptor.currentValidation === "rangeOnly",
        ),
      ).toBe(true);
      expect(descriptors.some((descriptor) => descriptor.id === "band2.gainDb")).toBe(true);
      expect(descriptors.some((descriptor) => descriptor.id === "band3.gainDb")).toBe(bandCount >= 3);
      return deepDescriptors[0].schemaId;
    });

    expect(new Set(schemas).size).toBe(3);
  });

  it("fingerprints the complete parameter surface and active device schema", () => {
    const { fx: eq } = docWithEffect("eq");
    const { fx: twoBandEq } = docWithEffect("fxeq", { bandCount: 2 });
    const { fx: fourBandEq } = docWithEffect("fxeq", { bandCount: 4 });

    expect(effectParameterSchemaFingerprint(eq)).toBe(effectParameterSchemaFingerprint(structuredClone(eq)));
    expect(effectParameterSchemaFingerprint(twoBandEq)).not.toBe(effectParameterSchemaFingerprint(fourBandEq));
  });

  it("adapts the full Ultina schema, including enum, toggle and automation metadata", () => {
    const { fx } = docWithEffect("ultina");
    const descriptors = effectParameterDescriptorCatalog(fx);
    const rackIds = new Set(EFFECT_DEFS.ultina.params.map((param) => param.id));
    const expectedIds = [
      ...EFFECT_DEFS.ultina.params.map((param) => param.id),
      ...ULTINA_PARAMS.filter((def) => !rackIds.has(def.id)).map((def) => def.id),
    ];
    const enumDef = ULTINA_PARAMS.find((def) => def.enumValues?.length);
    const toggleDef = ULTINA_PARAMS.find((def) => def.unit === "boolean");
    const enumDescriptor = descriptors.find((descriptor) => descriptor.id === enumDef?.id);
    const toggleDescriptor = descriptors.find((descriptor) => descriptor.id === toggleDef?.id);

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(expectedIds);
    expect(descriptors.every((descriptor) => descriptor.currentIsValid)).toBe(true);
    expect(new Set(descriptors.map((descriptor) => descriptor.schemaId)).size).toBe(1);
    expect(enumDescriptor).toMatchObject({
      kind: "enum",
      currentValidation: "complete",
      automationSupported: enumDef?.automatable,
    });
    expect(enumDescriptor?.options?.map((option) => option.label)).toEqual(enumDef?.enumValues);
    expect(toggleDescriptor).toMatchObject({
      kind: "toggle",
      currentValidation: "complete",
      automationSupported: toggleDef?.automatable,
    });
    expect(effectParameterDescriptorCatalog(fx)).toEqual(descriptors);
  });

  it("rejects invalid Ultina enum values without normalizing the descriptor", () => {
    const enumDef = ULTINA_PARAMS.find((def) => def.enumValues?.length)!;
    const invalidValue = enumDef.maxValue + 1;
    const { fx } = docWithEffect("ultina", { [enumDef.id]: invalidValue });
    const descriptor = effectParameterDescriptorCatalog(fx).find((candidate) => candidate.id === enumDef.id);

    expect(descriptor?.current).toBe(invalidValue);
    expect(descriptor?.currentIsValid).toBe(false);
  });

  it("adapts Ozvena's audio state tree and canonical enum indexes without exposing assistant state", () => {
    const { fx } = docWithEffect("ozvena");
    const descriptors = effectParameterDescriptorCatalog(fx);
    const ids = descriptors.map((descriptor) => descriptor.id);
    const convolutionMode = descriptors.find((descriptor) => descriptor.id === "convolution.mode");
    const predelay = descriptors.find((descriptor) => descriptor.id === "preDelay.ms");

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(effectTargetParamDefs(fx).map((descriptor) => descriptor.id)));
    expect(descriptors.find((descriptor) => descriptor.id === "engines.e1.enabled")).toMatchObject({
      kind: "toggle",
      currentValidation: "complete",
      currentIsValid: true,
    });
    expect(convolutionMode).toMatchObject({ kind: "enum", currentValidation: "complete", currentIsValid: true });
    expect(convolutionMode?.options?.map((option) => option.label)).toEqual(["algorithmic", "hybrid", "convolution"]);
    expect(predelay).toMatchObject({
      min: 0,
      max: 500,
      kind: "continuous",
      taper: "unknown",
      currentValidation: "rangeOnly",
    });
    expect(ids.some((id) => id.startsWith("assistant.") || id.startsWith("masking."))).toBe(false);
    expect(ids).not.toContain("convolution.irId");
    expect(effectParameterDescriptorCatalog(fx)).toEqual(descriptors);
  });

  it("rejects invalid Ozvena enum indexes without repairing the stored value", () => {
    const { fx } = docWithEffect("ozvena", { "convolution.mode": 1.5 });
    const descriptor = effectParameterDescriptorCatalog(fx).find((candidate) => candidate.id === "convolution.mode");

    expect(descriptor?.current).toBe(1.5);
    expect(descriptor?.currentIsValid).toBe(false);
  });

  it("marks invalid FXEQ enum and toggle values without normalizing them", () => {
    const { fx } = docWithEffect("fxeq", {
      bandCount: 4,
      crossoverOrder: 3,
      limiterEnabled: 0.5,
      "band1.satEnabled": 0.5,
    });
    const descriptors = effectParameterDescriptorCatalog(fx);

    expect(descriptors.find((descriptor) => descriptor.id === "crossoverOrder")?.currentIsValid).toBe(false);
    expect(descriptors.find((descriptor) => descriptor.id === "limiterEnabled")?.currentIsValid).toBe(false);
    expect(descriptors.find((descriptor) => descriptor.id === "band1.satEnabled")?.currentIsValid).toBe(false);
    expect(fx.params.crossoverOrder).toBe(3);
    expect(fx.params.limiterEnabled).toBe(0.5);
  });

  it("rejects an intent if a mapped parameter has invalid persisted state", () => {
    const { doc, trackId, fx } = docWithEffect("eq", { highShelfGain: 120 });
    const result = planEffectIntent(doc, { trackId, fxId: fx.id, effectType: fx.type }, readyIntent("brighter"));

    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") expect(result.diagnostics.join(" ")).toMatch(/aktuálna hodnota/i);
    expect(fx.params.highShelfGain).toBe(120);
  });

  it("marks fractional band counts invalid while deriving a safe schema shape", () => {
    const { fx } = docWithEffect("fxeq", { bandCount: 3.5 });
    const descriptors = effectParameterDescriptorCatalog(fx);
    const bandCount = descriptors.find((descriptor) => descriptor.id === "bandCount");

    expect(bandCount?.kind).toBe("discrete");
    expect(bandCount?.currentIsValid).toBe(false);
    expect(descriptors.some((descriptor) => descriptor.id === "band4.gainDb")).toBe(true);
    expect(descriptors.some((descriptor) => descriptor.id === "band5.gainDb")).toBe(false);
  });

  it("reads explicit rack toggle and enum kinds instead of treating every numeric range as a slider", () => {
    const { fx } = docWithEffect("kaskada", { pingPong: 0.5 });
    const descriptors = effectParameterDescriptorCatalog(fx);

    for (const id of ["pingPong", "reverse", "unmaskOn", "soloWet", "deltaListen"]) {
      expect(descriptors.find((descriptor) => descriptor.id === id)).toMatchObject({
        kind: "toggle",
        options: [
          { value: 0, label: "Off" },
          { value: 1, label: "On" },
        ],
      });
    }
    expect(descriptors.find((descriptor) => descriptor.id === "pingPong")?.currentIsValid).toBe(false);
    expect(descriptors.find((descriptor) => descriptor.id === "sync")?.kind).toBe("enum");
  });

  it("models Tape Stop's binary controls as a toggle and explicit DSP modes as enums", () => {
    const { fx } = docWithEffect("tapeStop", { engaged: 0.5, curve: 0.5, spin: 0.5 });
    const descriptors = effectParameterDescriptorCatalog(fx);

    expect(descriptors.find((descriptor) => descriptor.id === "engaged")).toMatchObject({
      kind: "toggle",
      currentIsValid: false,
      options: [
        { value: 0, label: "Armed" },
        { value: 1, label: "On" },
      ],
    });
    expect(descriptors.find((descriptor) => descriptor.id === "curve")).toMatchObject({
      kind: "enum",
      currentIsValid: false,
      options: [
        { value: 0, label: "Exponential" },
        { value: 1, label: "Linear" },
      ],
    });
    expect(descriptors.find((descriptor) => descriptor.id === "spin")).toMatchObject({
      kind: "enum",
      currentIsValid: false,
      options: [
        { value: 0, label: "Stop" },
        { value: 1, label: "Reverse" },
      ],
    });
  });

  it("declares known rack booleans as toggles across built-in and flagship effects", () => {
    const toggles: Array<[EffectType, string]> = [
      ["delay", "pingPong"],
      ["fxeq", "crossoverEqualize"],
      ["ultina", "comp.enabled"],
      ["ultina", "transient.enabled"],
      ["ultina", "exciter.enabled"],
      ["ultina", "unmask.enabled"],
      ["ozvena", "engines.e1.enabled"],
      ["ozvena", "engines.e2.enabled"],
      ["ozvena", "engines.e3.enabled"],
      ["utility", "phaseLeft"],
      ["utility", "phaseRight"],
      ["beatMangler", "trigger"],
    ];

    for (const [type, paramId] of toggles) {
      const parameter = EFFECT_DEFS[type].params.find((candidate) => candidate.id === paramId);
      const { fx } = docWithEffect(type);
      const descriptor = effectParameterDescriptorCatalog(fx).find((candidate) => candidate.id === paramId);

      expect(parameter?.kind, `${type}.${paramId} ParamDef`).toBe("toggle");
      expect(descriptor, `${type}.${paramId} descriptor`).toMatchObject({ kind: "toggle", currentIsValid: true });
      expect(descriptor?.options?.map((option) => option.value).sort()).toEqual([0, 1]);
    }
  });

  it("marks DSP-quantized rack controls as discrete and reports fractional persisted values", () => {
    const discrete: Array<[EffectType, string]> = [
      ["bitcrusher", "bits"],
      ["bitcrusher", "downsample"],
      ["multiTapDelay", "taps"],
      ["beatMangler", "repeatFill"],
      ["vocoder", "bands"],
    ];

    for (const [type, paramId] of discrete) {
      const parameter = EFFECT_DEFS[type].params.find((candidate) => candidate.id === paramId);
      const { fx } = docWithEffect(type);
      const descriptor = effectParameterDescriptorCatalog(fx).find((candidate) => candidate.id === paramId);

      expect(parameter, `${type}.${paramId} ParamDef`).toMatchObject({ kind: "discrete", step: 1 });
      expect(descriptor, `${type}.${paramId} descriptor`).toMatchObject({
        kind: "discrete",
        step: 1,
        currentIsValid: true,
      });
    }

    const malformed = docWithEffect("bitcrusher", { bits: 8.5 }).fx;
    expect(
      effectParameterDescriptorCatalog(malformed).find((descriptor) => descriptor.id === "bits")?.currentIsValid,
    ).toBe(false);
  });

  it("provides deterministic rack-schema and curated-intent coverage without stale mappings", () => {
    const report = effectIntentCatalogCoverageReport();
    expect(effectIntentCatalogCoverageReport()).toEqual(report);
    expect(report.effectTypeCount).toBe(Object.keys(EFFECT_DEFS).length);
    expect(report.rackParameterCount).toBe(
      Object.values(EFFECT_DEFS).reduce((total, definition) => total + definition.params.length, 0),
    );
    expect(report.technicalParameterCount).toBeGreaterThanOrEqual(report.rackParameterCount);
    expect(report.semanticallyMappedParameterCount).toBeGreaterThan(0);
    expect(report.semanticCoverage).toBe(report.semanticallyMappedParameterCount / report.rackParameterCount);
    expect(report.technicalSemanticCoverage).toBe(
      report.technicallyMappedParameterCount / report.technicalParameterCount,
    );
    expect(report.byEffect.every((effect) => effect.unmappedSemanticParameterIds.length === 0)).toBe(true);
    expect(
      report.byEffect.every(
        (effect) =>
          effect.technicalParameterCount === effect.rackParameterCount + effect.deepParameterCount &&
          Object.values(effect.parametersBySource).reduce((total, count) => total + (count ?? 0), 0) ===
            effect.technicalParameterCount,
      ),
    ).toBe(true);

    const byType = new Map(report.byEffect.map((effect) => [effect.effectType, effect]));
    expect(byType.get("eq")).toMatchObject({
      intentWriteAdapter: "rack-param-def",
      intentPreviewAdapter: "rack-param-def",
      intentWriteSupported: true,
    });
    expect(byType.get("reverb")).toMatchObject({
      intentWriteAdapter: "rack-param-def",
      intentPreviewAdapter: "rack-param-def",
      intentWriteSupported: true,
    });
    expect(byType.get("fxeq")).toMatchObject({
      intentWriteAdapter: "none",
      intentPreviewAdapter: "none",
      intentWriteSupported: false,
      parametersBySource: expect.objectContaining({ fxeq: expect.any(Number) }),
    });
    expect(byType.get("ultina")).toMatchObject({
      intentWriteAdapter: "none",
      intentPreviewAdapter: "none",
      intentWriteSupported: false,
      parametersBySource: expect.objectContaining({ ultina: expect.any(Number) }),
    });
    expect(byType.get("ozvena")).toMatchObject({
      intentWriteAdapter: "none",
      intentPreviewAdapter: "none",
      intentWriteSupported: false,
      parametersBySource: expect.objectContaining({ ozvena: expect.any(Number) }),
    });
  });

  it("keeps every curated semantic mapping bound to a valid technical parameter contract", () => {
    const seen = new Set<string>();

    for (const mapping of EFFECT_INTENT_MAPPINGS) {
      const key = `${mapping.effectType}:${mapping.paramId}:${mapping.goal}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);

      const params = Object.fromEntries(
        EFFECT_DEFS[mapping.effectType].params.map((param) => [param.id, param.default]),
      );
      const fx: EffectInstance = {
        id: `fx-${mapping.effectType}`,
        type: mapping.effectType,
        bypassed: false,
        params,
      };
      const descriptor = effectIntentParameterCatalog(fx).find((candidate) => candidate.id === mapping.paramId);

      expect(descriptor).toBeDefined();
      expect(descriptor?.kind).toBe("continuous");
      expect(descriptor?.intentMappings).toContainEqual(mapping);
      expect(descriptor?.intentGoals).toContain(mapping.goal);
      expect(mapping.safeMin).toBeGreaterThanOrEqual(descriptor?.min ?? Number.POSITIVE_INFINITY);
      expect(mapping.safeMax).toBeLessThanOrEqual(descriptor?.max ?? Number.NEGATIVE_INFINITY);
      expect(mapping.safeMin).toBeLessThan(mapping.safeMax);
      expect(mapping.positiveStep).not.toBe(0);
      expect(mapping.rationale.increase.length).toBeGreaterThan(0);
      expect(mapping.rationale.decrease.length).toBeGreaterThan(0);
      expect(["low", "elevated"]).toContain(mapping.risk);
      expect(["curated-unreviewed", "golden-reviewed"]).toContain(mapping.evidence);
    }
  });

  it("exposes only curated semantic controls while retaining technical EQ descriptors", () => {
    const { fx } = docWithEffect("eq");
    const descriptors = effectIntentParameterCatalog(fx);
    expect(
      descriptors.some(
        (descriptor) => descriptor.id === "highShelfGain" && descriptor.intentGoals.includes("brightness"),
      ),
    ).toBe(true);
    expect(descriptors.some((descriptor) => descriptor.id === "highFreq" && descriptor.intentGoals.length === 0)).toBe(
      false,
    );
    expect(descriptors.some((descriptor) => descriptor.id === "highGain")).toBe(false);
  });

  it("uses the low shelf for warmth when highs are protected", () => {
    const { doc, trackId, fx } = docWithEffect("eq");
    const proposal = readyProposal(doc, trackId, fx, "trochu teplejšie, ale nechaj výšky tak");
    expect(proposal.changes.map((change) => change.paramId)).toEqual(["lowShelfGain"]);
    expect(proposal.changes[0].after).toBeGreaterThan(proposal.changes[0].before);
    expect(proposal.warnings).toContain(
      "Pilotné zvukové mapovanie ešte neprešlo blind golden review; pred Apply si návrh vypočuj, ak je preview dostupné.",
    );
    expect(proposal.warnings.some((warning) => warning.includes("zachovaniu zvolených frekvenčných oblastí"))).toBe(
      true,
    );
  });

  it("rejects a brightness request that explicitly protects the only relevant band", () => {
    const { doc, trackId, fx } = docWithEffect("eq");
    const result = planEffectIntent(
      doc,
      { trackId, fxId: fx.id, effectType: fx.type },
      readyIntent("brighter, preserve highs"),
    );
    expect(result.status).toBe("unsupported");
  });

  it("asks for clarification when two goals require opposite movement of one parameter", () => {
    const { doc, trackId, fx } = docWithEffect("eq");
    const result = planEffectIntent(
      doc,
      { trackId, fxId: fx.id, effectType: fx.type },
      readyIntent("warmer and brighter"),
    );

    expect(result.status).toBe("needsClarification");
    if (result.status === "needsClarification")
      expect(result.diagnostics[0]).toMatch(/opačné zmeny parametra HIGH SHELF/i);
  });

  it("maps reverb space to wet amount and decay without touching unrelated parameters", () => {
    const { doc, trackId, fx } = docWithEffect("reverb", {
      mix: 0.3,
      decay: 1.8,
      tone: 6000,
      predelay: 20,
      diffusion: 0.5,
    });
    const proposal = readyProposal(doc, trackId, fx, "a little more space");
    expect(proposal.changes.map((change) => change.paramId)).toEqual(["mix", "decay"]);
    expect(proposal.changes.every((change) => change.after > change.before)).toBe(true);
    expect(proposal.changes.every((change) => change.afterText.length > 0 && change.rationale.length > 0)).toBe(true);
  });

  it("honors protected highs by adjusting only reverb decay", () => {
    const { doc, trackId, fx } = docWithEffect("reverb", { mix: 0.3, decay: 1.8, tone: 6000 });
    const proposal = readyProposal(doc, trackId, fx, "more space, keep the highs");
    expect(proposal.changes.map((change) => change.paramId)).toEqual(["decay"]);
    expect(proposal.warnings).toContain(
      "Pilotné zvukové mapovanie ešte neprešlo blind golden review; pred Apply si návrh vypočuj, ak je preview dostupné.",
    );
    expect(proposal.warnings.some((warning) => warning.includes("zachovaniu zvolených frekvenčných oblastí"))).toBe(
      true,
    );
  });

  it("does not offer unreviewed effects or accept forged intent ranges", () => {
    const { doc, trackId } = docWithEffect("delay");
    const fx = doc.tracks.flatMap((track) => track.effects).find((effect) => effect.type === "delay")!;
    const parsed = readyIntent("warmer");
    expect(planEffectIntent(doc, { trackId, fxId: fx.id, effectType: fx.type }, parsed).status).toBe("unsupported");
    expect(
      planEffectIntent(
        doc,
        { trackId, fxId: fx.id, effectType: fx.type },
        { ...parsed, goals: [{ ...parsed.goals[0], amount: 100 }] },
      ).status,
    ).toBe("unsupported");
  });

  it("returns unsupported instead of throwing for malformed runtime intent payloads", () => {
    const { doc, trackId, fx } = docWithEffect("eq");
    const valid = readyIntent("warmer");
    const target = { trackId, fxId: fx.id, effectType: fx.type };
    const malformed: unknown[] = [
      null,
      [],
      { ...valid, goals: [null] },
      { ...valid, goals: [{}] },
      { ...valid, goals: [{ ...valid.goals[0], amount: Number.NaN }] },
      { ...valid, goals: [valid.goals[0], valid.goals[0]] },
      { ...valid, preserve: [null] },
    ];

    for (const intent of malformed) {
      expect(() => planEffectIntent(doc, target, intent as unknown as typeof valid)).not.toThrow();
      expect(planEffectIntent(doc, target, intent as unknown as typeof valid).status).toBe("unsupported");
    }
  });

  it("keeps generated proposals deterministic and schema-valid across boundary intensities", () => {
    const scenarios = [
      { type: "eq" as const, phrases: ["warmer", "cooler"] },
      { type: "eq" as const, phrases: ["brighter", "darker"] },
      { type: "reverb" as const, phrases: ["more space", "less space"] },
    ];
    const amounts = [0, 0.001, 0.3, 0.6, 0.99, 1];

    for (const scenario of scenarios) {
      const { doc, trackId, fx } = docWithEffect(scenario.type);
      const descriptors = new Map(effectIntentParameterCatalog(fx).map((descriptor) => [descriptor.id, descriptor]));
      for (const phrase of scenario.phrases) {
        const parsedIntent = readyIntent(phrase);
        for (const amount of amounts) {
          const intent = { ...parsedIntent, goals: parsedIntent.goals.map((goal) => ({ ...goal, amount })) };
          const target = { trackId, fxId: fx.id, effectType: fx.type };
          const first = planEffectIntent(doc, target, intent);
          const second = planEffectIntent(doc, target, intent);
          expect(second).toEqual(first);

          if (first.status !== "ready") {
            expect(first.status).toBe("noChange");
            continue;
          }
          if (second.status !== "ready") throw new Error("Repeated planning returned a different result status");
          expect(canonicalEffectIntentJson(first.proposal)).toBe(canonicalEffectIntentJson(second.proposal));
          for (const change of first.proposal.changes) {
            const descriptor = descriptors.get(change.paramId);
            const param = EFFECT_DEFS[fx.type].params.find((candidate) => candidate.id === change.paramId);
            expect(descriptor?.intentGoals).toContain(intent.goals[0].goal);
            expect(param).toBeDefined();
            expect(Number.isFinite(change.after)).toBe(true);
            expect(clampEffectParam(fx.type, change.paramId, change.after)).toBe(change.after);
            if (param?.options) expect(param.options.some((option) => option.value === change.after)).toBe(true);
          }
        }
      }
    }
  });
});

describe("Effect Intent Engine — atomic apply and stale guards", () => {
  it("applies, undoes, and redoes one multi-parameter reverb proposal exactly", () => {
    const { doc, trackId, fx } = docWithEffect("reverb", {
      mix: 0.3,
      decay: 1.8,
      tone: 6000,
      predelay: 20,
      diffusion: 0.5,
    });
    const original = structuredClone(doc);
    const proposal = readyProposal(doc, trackId, fx, "more space");
    expect(doc).toEqual(original);
    const command = applyEffectIntentProposal(doc, proposal);
    const applied = command.execute(doc);
    const afterFx = applied.tracks.flatMap((track) => track.effects).find((effect) => effect.id === fx.id)!;
    expect(afterFx.params.mix).toBeGreaterThan(
      original.tracks.flatMap((track) => track.effects).find((effect) => effect.id === fx.id)!.params.mix,
    );
    expect(command.undo(applied)).toEqual(original);
    expect(command.execute(command.undo(applied))).toEqual(applied);
    expect(applied.tracks.find((track) => track.id !== trackId)).toEqual(
      original.tracks.find((track) => track.id !== trackId),
    );
    expect(command.type).toBe("applyEffectIntentProposal");
  });

  it("applies only explicitly selected proposal parameters and undoes that subset exactly", () => {
    const { doc, trackId, fx } = docWithEffect("reverb", { mix: 0.3, decay: 1.8, tone: 6000 });
    const proposal = readyProposal(doc, trackId, fx, "more space");
    const command = applyEffectIntentProposal(doc, proposal, ["decay"]);
    const applied = command.execute(doc);
    const updated = applied.tracks.flatMap((track) => track.effects).find((effect) => effect.id === fx.id)!;

    expect(updated.params.decay).toBeGreaterThan(fx.params.decay);
    expect(updated.params.mix).toBe(fx.params.mix);
    expect(updated.params.tone).toBe(fx.params.tone);
    expect(command.undo(applied)).toEqual(doc);
  });

  it("rejects a second execution of an already-applied proposal instead of repeating its delta", () => {
    const { doc, trackId, fx } = docWithEffect("eq", { lowShelfGain: 0, highShelfGain: 0 });
    const proposal = readyProposal(doc, trackId, fx, "brighter");
    const command = applyEffectIntentProposal(doc, proposal);
    const applied = command.execute(doc);

    expect(() => command.execute(applied)).toThrow(/stale/i);
    expect(command.execute(doc)).toEqual(applied);
  });

  it("rejects empty or non-proposed parameter selections", () => {
    const { doc, trackId, fx } = docWithEffect("reverb", { mix: 0.3, decay: 1.8, tone: 6000 });
    const proposal = readyProposal(doc, trackId, fx, "more space");

    expect(() => applyEffectIntentProposal(doc, proposal, [])).toThrow(/at least one selected parameter/i);
    expect(() => applyEffectIntentProposal(doc, proposal, ["tone"])).toThrow(/unsupported parameter selection/i);
    expect(() => applyEffectIntentProposal(doc, proposal, ["decay", "decay"])).toThrow(
      /duplicate parameter selection/i,
    );
  });

  it("rejects a proposal if the target changes before execute", () => {
    const { doc, trackId, fx } = docWithEffect("eq", { highShelfGain: 0 });
    const proposal = readyProposal(doc, trackId, fx, "brighter");
    const command = applyEffectIntentProposal(doc, proposal);
    const changed = structuredClone(doc);
    changed.tracks.find((track) => track.id === trackId)!.effects[0].params.highShelfGain = 2;
    expect(() => command.execute(changed)).toThrow(/stale/i);
  });

  it("rejects a forged parameter delta instead of trusting proposal numbers", () => {
    const { doc, trackId, fx } = docWithEffect("eq", { highShelfGain: 0 });
    const proposal = readyProposal(doc, trackId, fx, "brighter");
    const forged = {
      ...proposal,
      changes: [{ ...proposal.changes[0], paramId: "hpFreq", before: 20, after: 500 }],
    };
    expect(() => applyEffectIntentProposal(doc, forged)).toThrow(/deterministic plan/i);
  });

  it("detects target removal and parameter changes using the proposal fingerprint", () => {
    const { doc, trackId, fx } = docWithEffect("reverb");
    const proposal = readyProposal(doc, trackId, fx, "more space");
    expect(isEffectIntentProposalCurrent(doc, proposal)).toBe(true);
    const changed = structuredClone(doc);
    changed.tracks.find((track) => track.id === trackId)!.effects[0].params.mix = 0.9;
    expect(isEffectIntentProposalCurrent(changed, proposal)).toBe(false);
  });

  it("rejects a proposal bound to a different parameter schema before writing", () => {
    const { doc, trackId, fx } = docWithEffect("eq");
    const proposal = readyProposal(doc, trackId, fx, "brighter");
    const staleSchema = { ...proposal, targetSchemaId: `${proposal.targetSchemaId}-old` };

    expect(isEffectIntentProposalCurrent(doc, staleSchema)).toBe(false);
    expect(() => applyEffectIntentProposal(doc, staleSchema)).toThrow(/target schema is stale/i);
  });
});
