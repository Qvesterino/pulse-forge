import { describe, expect, it } from "vitest";
import {
  parseParamIntent,
  applyParamIntent,
  paramMovePreview,
  paramReadback,
  type ParamIntent,
} from "../src/intent/param-intent";
import { routeIntentText } from "../src/intent/route";
import { testDoc } from "./fixtures/doc";

/**
 * PARAM-LEVEL INTENT (param wave P1) — the producer names a KNOB. Every case
 * here was a namesForeignKnob DECLINE before this wave: the engine could not
 * address any parameter except each effect's single primary knob.
 */

const mustParse = (text: string): ParamIntent => {
  const parsed = parseParamIntent(text);
  expect(parsed, text).not.toBeNull();
  return parsed as ParamIntent;
};

describe("parseParamIntent — grammar", () => {
  it("set with a unit lands in the param's OWN raw unit", () => {
    // delay.time is ms; reverb.decay is s — the same "375 ms" ask must land
    // at 375 on delay and 0.375 on a (hypothetical) s-space param.
    const delay = mustParse("set delay time to 375 ms on the 808");
    expect(delay).toMatchObject({ effectType: "delay", role: "time", paramId: "time", mode: "set", value: 375 });
    const decay = mustParse("nastav reverb decay na 2.5 s na leade");
    expect(decay).toMatchObject({ effectType: "reverb", role: "time", paramId: "decay", mode: "set", value: 2.5 });
  });

  it("kHz converts into Hz params; out-of-range clamps", () => {
    const tone = mustParse("set delay tone to 5 khz na leade");
    expect(tone.value).toBe(5000);
    const wild = mustParse("set reverb tone to 999999 hz na leade");
    expect(wild.value).toBeLessThanOrEqual(18000);
  });

  it("relative asks with the vibe ladder and explicit percent", () => {
    const tail = mustParse("dlhsi chvost na reverbe na leade");
    expect(tail).toMatchObject({ role: "time", mode: "more", amount: "medium" });
    const bit = mustParse("trochu dlhsi chvost na reverbe na leade");
    expect(bit.amount).toBe("subtle");
    const shorter = mustParse("kratsi chvost na reverbe na leade");
    expect(shorter.mode).toBe("less");
    const pct = mustParse("delay time o 20 % vyssie na leade");
    expect(pct.percent).toBe(20);
  });

  it("SK role words: suchší saturation → mix (non-primary), tmavší → tone", () => {
    // reverb.mix is the PRIMARY knob — that ask stays with effectIntent.
    expect(parseParamIntent("suchsi dozvuk na leade")).toBeNull();
    // saturation's primary knob is DRIVE, so its mix is a param-role ask.
    const dry = mustParse("suchsia saturacia na leade");
    expect(dry.role).toBe("mix");
    // suchší = DRIER — the direction must say LESS (the default ladder would
    // invert the ask into MORE wet; the measured readback caught it live).
    expect(dry.mode).toBe("less");
    expect(mustParse("dry saturation on the lead").mode).toBe("less");
    expect(mustParse("mokrejsia saturacia na leade").mode).toBe("more");
    expect(mustParse("tmavsi ton reverbu na leade").role).toBe("tone");
  });

  it("primary knobs belong to the effectIntent layer — param never steals them", () => {
    expect(parseParamIntent("viac drivu na saturacii na leade")).toBeNull(); // drive IS primary
    expect(routeIntentText("viac drivu na saturacii na leade", testDoc()).kind).toBe("effectIntent");
  });

  it("bare width asks (no effect noun) stay OUT of the param layer", () => {
    // "wider hats" is owned by the TWIST semantic-move layer (skrutka),
    // "širší stereo" by production — never a bare haasWidener add.
    expect(parseParamIntent("siroksi stereo na leade")).toBeNull();
    expect(parseParamIntent("wider hats")).toBeNull();
    expect(["effectIntent", "production"]).toContain(routeIntentText("wider hats", testDoc()).kind);
  });

  it("scene roles expand targets; no target word ⇒ null (mix layer owns it)", () => {
    const drop = mustParse("dlhsi chvost na reverbe v drope");
    expect(drop.targets).toContain("lead");
    expect(drop.targets).toContain("drums");
    expect(parseParamIntent("dlhsi chvost na reverbe")).toBeNull();
  });

  it("an effect WITHOUT the role never parses (no guessing)", () => {
    // reverb has no drive param — "viac drivu na reverbe" is the generic
    // effect layer's business (its primary knob), not a param intent.
    expect(parseParamIntent("viac drivu na reverbe na leade")).toBeNull();
  });
});

describe("parseParamIntent — domain-true interpolation", () => {
  it("percent of a log-tapered Hz knob interpolates geometrically", () => {
    // delay.time 30..2000 ms log: 50% must be the geometric middle (~245),
    // NOT the linear middle (1015).
    const half = mustParse("set delay time to 50 % na leade");
    expect(half.value).toBeGreaterThan(200);
    expect(half.value).toBeLessThan(300);
  });

  it("a relative degree is a constant RATIO on a log knob", () => {
    const intent = mustParse("slightly longer delay time on the lead");
    const quiet = paramMovePreview(intent, 100)!;
    const loud = paramMovePreview(intent, 1000)!;
    expect(quiet.domain).toBe("log");
    expect(quiet.fraction).toBeCloseTo(0.08, 6);
    // Same fraction, same ratio — no matter where the knob currently sits.
    expect(quiet.next / 100).toBeCloseTo(loud.next / 1000, 6);
    expect(quiet.next).toBeGreaterThan(100);
  });

  it("a relative degree is a constant ADDITIVE step on a linear knob", () => {
    const intent = mustParse("slightly longer reverb decay on the lead");
    const low = paramMovePreview(intent, 1)!;
    const high = paramMovePreview(intent, 10)!;
    expect(low.domain).toBe("linear");
    expect(low.next - 1).toBeCloseTo(high.next - 10, 6);
    expect(high.next).toBeLessThanOrEqual(20);
  });

  it("the inferred fraction is monotone in the spoken degree", () => {
    const fraction = (text: string): number => paramMovePreview(mustParse(text), 1.8)!.fraction as number;
    const barely = fraction("barely longer reverb decay on the lead");
    const little = fraction("a little longer reverb decay on the lead");
    const much = fraction("much longer reverb decay on the lead");
    expect(little).toBeGreaterThan(barely);
    expect(much).toBeGreaterThan(little);
  });

  it("an absolute set reports the destination and the clamp, not a fraction", () => {
    const intent = mustParse("set reverb decay na 19 s na 808");
    const preview = paramMovePreview(intent, 1.8)!;
    expect(preview.mode).toBe("set");
    expect(preview.fraction).toBeNull();
    expect(preview.proposed).toBe(19);
    expect(preview.next).toBe(19);
  });

  it("'as little reverb as possible' is the minimal param fraction", () => {
    // reverb.mix is the PRIMARY knob, so the param layer declines that exact
    // ask; the same phrase on a non-primary knob (saturation mix) is a param.
    const intent = mustParse("as little dry saturation as possible on the lead");
    expect(intent.mode).toBe("less");
    expect(intent.degree?.level).toBe(1);
  });
});

describe("router priority", () => {
  it("a named knob routes paramIntent BEFORE effectIntent", () => {
    const doc = testDoc();
    expect(routeIntentText("set delay time to 375 ms on the lead", doc).kind).toBe("paramIntent");
    expect(routeIntentText("dlhsi chvost na reverbe na leade", doc).kind).toBe("paramIntent");
  });

  it("the generic effect ask keeps its old route", () => {
    const doc = testDoc();
    expect(routeIntentText("more delay on the lead", doc).kind).toBe("effectIntent");
    expect(routeIntentText("viac kompresie", doc).kind).toBe("mix");
  });
});

describe("applyParamIntent", () => {
  it("adds the effect when missing, sets the param, one undo restores", () => {
    const doc = testDoc();
    const intent = mustParse("set delay time to 375 ms on the 808");
    const command = applyParamIntent(doc, intent);
    const after = command.execute(doc);
    const lead = after.tracks.find((track) => track.kind === "instrument" && /808|bas/i.test(track.name));
    expect(lead && "effects" in lead).toBe(true);
    const delay = lead && "effects" in lead ? lead.effects.find((effect) => effect.type === "delay") : undefined;
    expect(delay?.params.time).toBe(375);
    expect(command.undo(doc)).toBe(doc);
  });

  it("relative moves from the CURRENT value and clamp at the ceiling", () => {
    const doc = testDoc();
    const first = applyParamIntent(doc, mustParse("set reverb decay na 19 s na 808")).execute(doc);
    const second = applyParamIntent(first, mustParse("o vela dlhsi chvost na reverbe na 808"));
    const after = second.execute(first);
    const lead = after.tracks.find((track) => track.kind === "instrument" && /808|bas/i.test(track.name));
    const reverb = lead && "effects" in lead ? lead.effects.find((effect) => effect.type === "reverb") : undefined;
    // huge ≈ +32 % of range from 19 s must clamp at 20, never exceed.
    expect(reverb?.params.decay).toBeLessThanOrEqual(20);
  });

  it("idempotent re-apply throws the mix layer's honest 'changed nothing'", () => {
    const doc = testDoc();
    const intent = mustParse("set delay time to 375 ms on the 808");
    const after = applyParamIntent(doc, intent).execute(doc);
    expect(() => applyParamIntent(after, intent).execute(after)).toThrow(/changed nothing/i);
  });

  it("paramReadback reports the value move in the param's unit", () => {
    const doc = testDoc();
    const intent = mustParse("dlhsi chvost na reverbe na 808");
    const after = applyParamIntent(doc, intent).execute(doc);
    const readback = paramReadback(doc, after, intent);
    expect(readback).toMatch(/decay/);
    expect(readback).toMatch(/s/);
  });
});
