import { describe, expect, it } from "vitest";
import { buildIntentProjectContext } from "../src/intent/model-context";
import { VOCAB } from "../src/intent/model-schema";
import { EFFECT_META } from "../src/effects/definitions";
import { addEffectToTracks } from "../src/commands/commands";
import { createDefaultProject } from "../src/project-model/schema";
import type { EffectType, ProjectDocument } from "../src/project-model/types";

/**
 * F-09 — the model context may only offer roles the model's own grammar can
 * emit. actionContract.parameterRoles is VOCAB.paramRole, but the PRIMARY
 * knob control bypassed the supportedRoles gate and fell back to the literal
 * role "primary" when a knob had no capability row (compressor.ratio,
 * pump.amount, bitcrusher.mix) — a control marked supported whose every
 * paramIntent the grammar rejects. The context now offers only expressible
 * roles; an effect with none reports modelActionSupported: false honestly.
 */

const ROLES: readonly string[] = VOCAB.paramRole;

function docWithEffect(type: EffectType): { doc: ProjectDocument; trackName: string } {
  const doc = createDefaultProject();
  const track = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
  return { doc: addEffectToTracks(doc, [track.id], type).execute(doc), trackName: track.name };
}

function contextEffectFor(type: EffectType) {
  const { doc, trackName } = docWithEffect(type);
  const context = buildIntentProjectContext(doc, `adjust the ${type} on ${trackName}`);
  if (!context) return null;
  const track = context.tracks.find((candidate) => candidate.name === trackName);
  return track?.effects.find((effect) => effect.type === type) ?? null;
}

describe("the intent model context offers only expressible roles", () => {
  it("census: every offered intent control role is in VOCAB.paramRole", () => {
    const types = Object.keys(EFFECT_META) as EffectType[];
    const noContext: EffectType[] = [];
    for (const type of types) {
      const fx = contextEffectFor(type);
      if (!fx) {
        noContext.push(type);
        continue;
      }
      for (const control of fx.intentControls) {
        expect(ROLES, `${type} offers role "${control.role}" the grammar cannot emit`).toContain(control.role);
      }
    }
    // The census must actually see the effects, not silently skip them all.
    expect(noContext.length).toBeLessThan(types.length / 2);
  });

  it("the known offenders no longer offer the inexpressible fallback", () => {
    for (const type of ["compressor", "pump", "bitcrusher"] as EffectType[]) {
      const fx = contextEffectFor(type);
      if (!fx) continue;
      expect(
        fx.intentControls.map((control) => control.role),
        `${type} roles`,
      ).not.toContain("primary");
    }
  });

  it("a supported primary control still ships — reverb keeps role mix", () => {
    const fx = contextEffectFor("reverb");
    expect(fx).not.toBeNull();
    expect(fx!.modelActionSupported).toBe(true);
    expect(fx!.intentControls).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "mix", paramId: "mix" })]),
    );
  });
});
