import { describe, expect, it } from "vitest";
import {
  DICE_FX_CARDS,
  DICE_FX_PREFIX,
  applyDiceFxToDoc,
  clearDiceFx,
  diceFxInstanceId,
  pickDiceFx,
  type DiceFxCard,
} from "../src/intent/dice";
import { createProjectFromTemplate } from "../src/project-model/templates";

/**
 * Dice FX character cards (FX expansion): deterministic per-seed picking,
 * locks.fx suppression, replace-on-apply with stable dice-fx-* ids, and
 * user-added effects surviving the replace.
 */

const session = (): import("../src/intent/dice").DiceLocks => ({ fx: false }) as never;

describe("pickDiceFx", () => {
  it("is deterministic per seed", () => {
    const a = pickDiceFx("roll-1", session());
    const b = pickDiceFx("roll-1", session());
    expect(a?.key).toBe(b?.key);
  });

  it("spreads across the palette (not a single card for every seed)", () => {
    const keys = new Set<string>();
    let none = 0;
    for (let i = 0; i < 200; i++) {
      const card = pickDiceFx(`spread-seed-${i}`, session());
      if (card) keys.add(card.key);
      else none += 1;
    }
    expect(keys.size).toBeGreaterThan(3);
    expect(none).toBeGreaterThan(0); // no-FX rolls stay in the mix
    expect(none).toBeLessThan(120); // but not dominant
  });

  it("locks.fx suppresses the pick entirely", () => {
    for (let i = 0; i < 20; i++) {
      expect(pickDiceFx(`locked-${i}`, { fx: true } as import("../src/intent/dice").DiceLocks)).toBeNull();
    }
  });

  it("every card has a valid registered effect type and preset-shaped params", async () => {
    const registry = await import("../src/effects/registry");
    for (const card of DICE_FX_CARDS) {
      expect(registry.EFFECT_DEFS[card.type], `${card.key} type`).toBeDefined();
      for (const [paramId, value] of Object.entries(card.params)) {
        const def = registry.EFFECT_DEFS[card.type].params.find((pd) => pd.id === paramId);
        expect(def, `${card.key}.${paramId} is a real param`).toBeDefined();
        expect(value).toBeGreaterThanOrEqual(def!.min);
        expect(value).toBeLessThanOrEqual(def!.max);
      }
    }
  });
});

describe("applyDiceFxToDoc / clearDiceFx", () => {
  const doc = () => {
    const base = createProjectFromTemplate("house");
    const drums = base.tracks.find((t) => t.kind === "drum")!;
    // A user-owned effect that must survive dice rolls.
    (drums as { effects: unknown[] }).effects = [
      {
        id: "user-comp",
        type: "compressor",
        bypassed: false,
        params: { threshold: -20, ratio: 3, attack: 0.01, release: 0.2, knee: 6, makeup: 1, mix: 1 },
      },
    ];
    return base;
  };

  it("installs the card on the drum track with the stable dice-fx id", () => {
    const card: DiceFxCard = DICE_FX_CARDS.find((c) => c.key === "chop-neg3")!;
    const next = applyDiceFxToDoc(doc(), card);
    const drums = next.tracks.find((t) => t.kind === "drum")!;
    const effects = (drums as { effects: { id: string; type: string }[] }).effects;
    expect(effects.some((fx) => fx.id === `${DICE_FX_PREFIX}chop-neg3`)).toBe(true);
    expect(effects.some((fx) => fx.id === "user-comp")).toBe(true); // user FX survive
  });

  it("replaces a previous dice card but never duplicates the slot", () => {
    const first = applyDiceFxToDoc(doc(), DICE_FX_CARDS[0]);
    const second = applyDiceFxToDoc(first, DICE_FX_CARDS[1]);
    const drums = second.tracks.find((t) => t.kind === "drum")!;
    const diceFx = (drums as { effects: { id: string }[] }).effects.filter((fx) => fx.id.startsWith(DICE_FX_PREFIX));
    expect(diceFx).toHaveLength(1);
  });

  it("beatMangler cards carry their bar envelopes", () => {
    const mangler = DICE_FX_CARDS.find((c) => c.type === "beatMangler");
    expect(mangler).toBeDefined();
    expect(mangler!.volumeSteps?.length).toBe(16);
    expect(mangler!.pitchSteps?.length).toBe(16);
    const next = applyDiceFxToDoc(doc(), mangler!);
    const drums = next.tracks.find((t) => t.kind === "drum")!;
    const diceFx = (drums as { effects: { id: string; volumeSteps?: number[] }[] }).effects.find((fx) =>
      fx.id.startsWith(DICE_FX_PREFIX),
    );
    expect(diceFx?.volumeSteps).toHaveLength(16);
  });

  it("clearDiceFx strips only dice-owned slots", () => {
    const withCard = applyDiceFxToDoc(doc(), DICE_FX_CARDS[0]);
    const cleared = clearDiceFx(withCard);
    const drums = cleared.tracks.find((t) => t.kind === "drum")!;
    const effects = (drums as { effects: { id: string }[] }).effects;
    expect(effects.some((fx) => fx.id.startsWith(DICE_FX_PREFIX))).toBe(false);
    expect(effects.some((fx) => fx.id === "user-comp")).toBe(true);
  });

  it("cards carry ids derived from their key (stable slot)", () => {
    const card = DICE_FX_CARDS[0];
    expect(diceFxInstanceId(card)).toBe(`${DICE_FX_PREFIX}${card.key}`);
  });
});
