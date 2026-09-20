import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { EffectInstance, EffectType, ProjectDocument } from "../src/project-model/types";
import { clampEffectParam, EFFECT_DEFS } from "../src/effects/registry";
import {
  applyEffectIntentProposal,
  effectIntentParameterCatalog,
  isEffectIntentProposalCurrent,
  parseEffectIntent,
  planEffectIntent,
} from "../src/effect-intent";
import { canonicalEffectIntentJson } from "../src/effect-intent/canonical";

function docWithEffect(type: EffectType, params: Record<string, number> = {}): { doc: ProjectDocument; trackId: string; fx: EffectInstance } {
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
    if (first.status === "ready") expect(first.intent.goals[0]).toMatchObject({ goal: "brightness", direction: "increase", amount: 0.3 });
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
  it("exposes only curated semantic controls while retaining technical EQ descriptors", () => {
    const { fx } = docWithEffect("eq");
    const descriptors = effectIntentParameterCatalog(fx);
    expect(descriptors.some((descriptor) => descriptor.id === "highShelfGain" && descriptor.intentGoals.includes("brightness"))).toBe(true);
    expect(descriptors.some((descriptor) => descriptor.id === "highFreq" && descriptor.intentGoals.length === 0)).toBe(false);
    expect(descriptors.some((descriptor) => descriptor.id === "highGain")).toBe(false);
  });

  it("uses the low shelf for warmth when highs are protected", () => {
    const { doc, trackId, fx } = docWithEffect("eq");
    const proposal = readyProposal(doc, trackId, fx, "trochu teplejšie, ale nechaj výšky tak");
    expect(proposal.changes.map((change) => change.paramId)).toEqual(["lowShelfGain"]);
    expect(proposal.changes[0].after).toBeGreaterThan(proposal.changes[0].before);
    expect(proposal.warnings).toHaveLength(1);
  });

  it("rejects a brightness request that explicitly protects the only relevant band", () => {
    const { doc, trackId, fx } = docWithEffect("eq");
    const result = planEffectIntent(doc, { trackId, fxId: fx.id, effectType: fx.type }, readyIntent("brighter, preserve highs"));
    expect(result.status).toBe("unsupported");
  });

  it("asks for clarification when two goals require opposite movement of one parameter", () => {
    const { doc, trackId, fx } = docWithEffect("eq");
    const result = planEffectIntent(doc, { trackId, fxId: fx.id, effectType: fx.type }, readyIntent("warmer and brighter"));

    expect(result.status).toBe("needsClarification");
    if (result.status === "needsClarification") expect(result.diagnostics[0]).toMatch(/opačné zmeny parametra HIGH SHELF/i);
  });

  it("maps reverb space to wet amount and decay without touching unrelated parameters", () => {
    const { doc, trackId, fx } = docWithEffect("reverb", { mix: 0.3, decay: 1.8, tone: 6000, predelay: 20, diffusion: 0.5 });
    const proposal = readyProposal(doc, trackId, fx, "a little more space");
    expect(proposal.changes.map((change) => change.paramId)).toEqual(["mix", "decay"]);
    expect(proposal.changes.every((change) => change.after > change.before)).toBe(true);
    expect(proposal.changes.every((change) => change.afterText.length > 0 && change.rationale.length > 0)).toBe(true);
  });

  it("honors protected highs by adjusting only reverb decay", () => {
    const { doc, trackId, fx } = docWithEffect("reverb", { mix: 0.3, decay: 1.8, tone: 6000 });
    const proposal = readyProposal(doc, trackId, fx, "more space, keep the highs");
    expect(proposal.changes.map((change) => change.paramId)).toEqual(["decay"]);
    expect(proposal.warnings).toHaveLength(1);
  });

  it("does not offer unreviewed effects or accept forged intent ranges", () => {
    const { doc, trackId } = docWithEffect("delay");
    const fx = doc.tracks.flatMap((track) => track.effects).find((effect) => effect.type === "delay")!;
    const parsed = readyIntent("warmer");
    expect(planEffectIntent(doc, { trackId, fxId: fx.id, effectType: fx.type }, parsed).status).toBe("unsupported");
    expect(planEffectIntent(doc, { trackId, fxId: fx.id, effectType: fx.type }, { ...parsed, goals: [{ ...parsed.goals[0], amount: 100 }] }).status).toBe("unsupported");
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
    const { doc, trackId, fx } = docWithEffect("reverb", { mix: 0.3, decay: 1.8, tone: 6000, predelay: 20, diffusion: 0.5 });
    const original = structuredClone(doc);
    const proposal = readyProposal(doc, trackId, fx, "more space");
    expect(doc).toEqual(original);
    const command = applyEffectIntentProposal(doc, proposal);
    const applied = command.execute(doc);
    const afterFx = applied.tracks.flatMap((track) => track.effects).find((effect) => effect.id === fx.id)!;
    expect(afterFx.params.mix).toBeGreaterThan(original.tracks.flatMap((track) => track.effects).find((effect) => effect.id === fx.id)!.params.mix);
    expect(command.undo(applied)).toEqual(original);
    expect(command.execute(command.undo(applied))).toEqual(applied);
    expect(applied.tracks.find((track) => track.id !== trackId)).toEqual(original.tracks.find((track) => track.id !== trackId));
    expect(command.type).toBe("applyEffectIntentProposal");
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
});
