import { describe, expect, it } from "vitest";
import {
  calibrateFaderFactor,
  calibrateKnobScale,
  calibrateParamFraction,
  degreeToEffectAmount,
  degreeToFaderAmount,
  parseDegree,
  type DegreeLevel,
} from "../src/intent/degree";
import { applyFaderIntent, parseFaderIntent } from "../src/intent/conversation";
import { effectKnobDelta, parseEffectIntent } from "../src/intent/mix";
import { parseParamIntent } from "../src/intent/param-intent";
import { parseProductionIntent } from "../src/intent/production";
import { routeIntentText } from "../src/intent/route";
import {
  clearAdjustmentLedger,
  recordEffectAdjustment,
  recordFaderAdjustment,
} from "../src/intent/adjustment-recording";
import { lastAdjustment, type FaderRecord } from "../src/intent/adjustment-ledger";
import { resolvePriorAdjustment } from "../src/intent/prior-adjustment";
import { CANONICAL_DEGREE_WORDS } from "../src/intent/semantics/degree-contract";
import { parseQuantity, formatQuantity } from "../src/intent/semantics/quantity";
import { testDoc } from "./fixtures/doc";

/**
 * GRADUATED DEGREE — audit 2026-10-18.
 *
 * These tests exist because the engine used to carry four independent ladders
 * (production.ts / conversation.ts / mix.ts / param-intent.ts) that disagreed
 * about the SAME words. The properties below are the contract the shared
 * taxonomy (src/intent/degree.ts) has to keep:
 *
 *   1. every level resolves, in both directions;
 *   2. ordering is monotonic in all three calibration domains;
 *   3. every word resolves to the CANONICAL level (2026-10-21 alignment:
 *      much 6→5, noticeably/quite 5→4; documented behavior change);
 *   4. the cross-domain defects the audit found are actually gone.
 */

const LEVELS: ReadonlyArray<readonly [DegreeLevel, readonly string[]]> = [
  [1, ["barely", "almost imperceptibly", "hardly", "the tiniest bit"]],
  [2, ["a touch", "a hair", "tiny bit", "a tiny bit", "just a tiny bit", "a tad"]],
  [3, ["slightly", "a little", "a bit", "trochu", "subtle"]],
  [4, ["somewhat", "moderately", "fairly", "noticeably", "quite"]],
  [5, ["considerably", "significantly", "much"]],
  [6, ["a lot", "dramatically", "huge", "really", "way"]],
  [7, ["fully", "completely", "maximal", "as much as possible", "úplne"]],
];

const levelValue = (level: DegreeLevel): number => {
  const found = LEVELS.find(([value]) => value === level);
  if (!found) throw new Error(`no words registered for level ${level}`);
  // Every word of a band must resolve to that band AND to that band's value,
  // so read the value off one of them.
  const degree = parseDegree(found[1][0] as string);
  if (!degree) throw new Error(`level ${level} sample "${found[1][0]}" did not parse`);
  return degree.value;
};

describe("degree taxonomy — the seven ordered levels", () => {
  it("resolves every band, in both directions, for every synonym", () => {
    for (const [level, words] of LEVELS) {
      for (const word of words) {
        for (const text of [`make it ${word} quieter`, `make it ${word} louder`]) {
          const degree = parseDegree(text);
          expect(degree, `"${text}" must name a degree`).not.toBeNull();
          expect(degree!.level, `"${text}" level`).toBe(level);
          expect(degree!.matched.trim().length, `"${text}" must report what it matched`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("band values strictly increase with level", () => {
    const values = LEVELS.map(([level]) => levelValue(level));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1] as number);
    }
  });

  it("an unqualified ask names NO degree, so the documented default survives", () => {
    // The most important negative: a silent default here would change every
    // unqualified ask in the DAW.
    for (const text of ["make the drums quieter", "turn down the bass", "more reverb on the pads"]) {
      expect(parseDegree(text), `"${text}"`).toBeNull();
    }
  });

  it("an exact numeric ask is not read as a qualitative degree", () => {
    expect(parseDegree("set the bass to 50%")).toBeNull();
    expect(parseDegree("lower the drums by 2 dB")).toBeNull();
  });

  it("'barely' is a level, not an absence of one", () => {
    // The audit's headline defect: outside production.ts this word had no rung
    // at all and silently fell through to the medium default.
    const degree = parseDegree("make it barely quieter");
    expect(degree).not.toBeNull();
    expect(degree!.level).toBe(1);
    expect(degree!.value).toBeLessThan(parseDegree("make it slightly quieter")!.value);
  });

  it("keeps 'a tiny bit' at the very-small level when scoped to its target", () => {
    const text = "make the reverb a tiny bit quieter";
    expect(parseDegree(text, text.indexOf("quieter"))!.level).toBe(2);
  });

  it("a softener in front of 'too much' is one phrase, not two competing tokens", () => {
    // "much" sits closer/stronger; without the phrase guard the attenuation
    // is lost and a polite ask reads as a hard one.
    expect(parseDegree("make it a bit too much punchier")!.level).toBe(3);
    expect(parseDegree("make it barely too much punchier")!.level).toBe(1);
    expect(parseDegree("make it way too much punchier")!.level).toBe(6);
  });

  it("the qualifier nearest the anchor wins (clause scoping)", () => {
    // Anchor at the SECOND concept: the leading "much" must not bleed onto it.
    const text = "slightly punchier drums, much deeper bass";
    const secondConcept = text.indexOf("deeper");
    expect(parseDegree(text, secondConcept)!.level).toBe(5);
    const firstConcept = text.indexOf("punchier");
    expect(parseDegree(text, firstConcept)!.level).toBe(3);
  });
});

describe("degree calibration — monotone in every domain", () => {
  const values = LEVELS.map(([level]) => levelValue(level));

  it("gain factors are monotone and sit on the correct side of unity", () => {
    for (let i = 1; i < values.length; i++) {
      const weaker = values[i - 1] as number;
      const stronger = values[i] as number;
      // METAMORPHIC: a stronger modifier may never produce a weaker step.
      expect(calibrateFaderFactor(stronger, "down")).toBeLessThanOrEqual(calibrateFaderFactor(weaker, "down"));
      expect(calibrateFaderFactor(stronger, "up")).toBeGreaterThanOrEqual(calibrateFaderFactor(weaker, "up"));
    }
    for (const value of values) {
      expect(calibrateFaderFactor(value, "down")).toBeLessThan(1);
      expect(calibrateFaderFactor(value, "up")).toBeGreaterThan(1);
    }
  });

  it("knob scale and param fraction are monotone", () => {
    for (let i = 1; i < values.length; i++) {
      const weaker = values[i - 1] as number;
      const stronger = values[i] as number;
      expect(calibrateKnobScale(stronger)).toBeGreaterThanOrEqual(calibrateKnobScale(weaker));
      expect(calibrateParamFraction(stronger)).toBeGreaterThanOrEqual(calibrateParamFraction(weaker));
    }
  });

  it("SATURATION is explicit, not accidental: knob and param cap at 'huge'", () => {
    // Both legacy ladders topped out at `huge`; the maximum band calibrates to
    // the same number by design, so this is documented rather than discovered.
    const max = levelValue(7);
    expect(calibrateKnobScale(max)).toBe(calibrateKnobScale(levelValue(6)));
    expect(calibrateParamFraction(max)).toBe(calibrateParamFraction(levelValue(6)));
    // The gain curve has a `full` rung, so it does NOT saturate there.
    expect(calibrateFaderFactor(max, "down")).toBeLessThan(calibrateFaderFactor(levelValue(6), "down"));
  });
});

describe("calibration anchors — the canonical curve in every domain", () => {
  it("the gain anchors follow the canonical ladder", () => {
    expect(calibrateFaderFactor(0.35, "down")).toBe(0.92); // small
    expect(calibrateFaderFactor(0.35, "up")).toBe(1.08);
    expect(calibrateFaderFactor(0.7, "down")).toBe(0.75); // much (L5)
    expect(calibrateFaderFactor(0.7, "up")).toBe(1.33);
    // The unqualified "normal" default sits at L4 (0.55).
    expect(calibrateFaderFactor(0.55, "down")).toBe(0.82);
    expect(calibrateFaderFactor(0.55, "up")).toBe(1.22);
    expect(calibrateFaderFactor(0.85, "down")).toBe(0.7); // a lot (L6)
    expect(calibrateFaderFactor(0.85, "up")).toBe(1.35);
    expect(calibrateFaderFactor(0.95, "down")).toBe(0.5); // full
    expect(calibrateFaderFactor(0.95, "up")).toBe(1.6);
  });

  it("the knob anchors follow the canonical physical scale", () => {
    expect(calibrateKnobScale(0.35)).toBe(0.5); // small
    expect(calibrateKnobScale(0.7)).toBe(1.25); // much (L5)
    expect(calibrateKnobScale(0.85)).toBe(1.75); // a lot (L6)
  });

  it("the param anchors reproduce AMOUNT_FRACTION exactly", () => {
    expect(calibrateParamFraction(0.35)).toBe(0.08); // subtle
    expect(calibrateParamFraction(0.7)).toBe(0.18); // medium
    expect(calibrateParamFraction(0.85)).toBe(0.32); // huge
  });

  it("the legacy fader buckets are unchanged (tests/conversation-intents.test.ts:330-336)", () => {
    expect(parseFaderIntent("zníž basu trochu")?.amount).toBe("subtle");
    expect(parseFaderIntent("zníž basu o dosť")?.amount).toBe("big");
    expect(parseFaderIntent("zníž basu úplne")?.amount).toBe("full");
    expect(parseFaderIntent("hlasnejšie bicie")?.amount).toBe("normal");
    expect(parseFaderIntent("turn down the drums a bit")?.amount).toBe("subtle");
    expect(parseFaderIntent("raise the bass a lot")?.amount).toBe("big");
  });

  it("the legacy effect buckets are unchanged (tests/intent-effect-targets.test.ts:33-36)", () => {
    expect(parseEffectIntent("huge reverb on the pads")!.amount).toBe("huge");
    expect(parseEffectIntent("subtle chorus on the lead")!.amount).toBe("subtle");
    // Ordering across the effect ladder must still hold.
    expect(effectKnobDelta(parseEffectIntent("huge reverb on the pads")!)).toBeGreaterThan(
      effectKnobDelta(parseEffectIntent("subtle reverb on the pads")!),
    );
  });

  it("the legacy param buckets are unchanged (tests/param-intent.test.ts:37-39)", () => {
    expect(parseParamIntent("trochu dlhsi chvost na reverbe na leade")).toMatchObject({ amount: "subtle" });
    expect(parseParamIntent("dlhsi chvost na reverbe na leade")).toMatchObject({ amount: "medium" });
  });

  it("the enum projection matches the canonical levels", () => {
    expect(degreeToFaderAmount(3)).toBe("subtle");
    expect(degreeToFaderAmount(4)).toBe("normal");
    expect(degreeToFaderAmount(5)).toBe("big");
    expect(degreeToFaderAmount(6)).toBe("big");
    expect(degreeToFaderAmount(7)).toBe("full");
    expect(degreeToEffectAmount(3)).toBe("subtle");
    expect(degreeToEffectAmount(4)).toBe("medium");
    expect(degreeToEffectAmount(5)).toBe("huge");
    expect(degreeToEffectAmount(6)).toBe("huge");
  });
});

describe("the audit's cross-domain defects are gone", () => {
  it("'slightly' means the same thing on the primary knob and on the param", () => {
    // Was: mix.ts called it `subtle` (0.5), param-intent.ts called it `medium`
    // (0.18). Same English sentence, two magnitudes.
    const viaEffect = parseEffectIntent("slightly more reverb on the pads")!;
    const viaParam = parseParamIntent("slightly longer reverb tail on the lead");
    expect(viaEffect.amount).toBe("subtle");
    expect(viaParam?.amount).toBe("subtle");
    expect(viaEffect.degree?.level).toBe(3);
    expect(viaParam?.degree?.level).toBe(3);
  });

  it("'much' outranks the medium default and sits below 'a lot'", () => {
    const much = parseEffectIntent("much more reverb on the pads")!;
    const lot = parseEffectIntent("a lot more reverb on the pads")!;
    expect(much.amount).toBe("huge");
    expect(lot.amount).toBe("huge");
    // Canonical order: much (L5) < a lot (L6).
    expect(effectKnobDelta(lot)).toBeGreaterThan(effectKnobDelta(much));
  });

  it("'barely' moves less than 'a little', which moves less than 'a lot'", () => {
    const barely = parseEffectIntent("barely more reverb on the pads")!;
    const little = parseEffectIntent("a little more reverb on the pads")!;
    const lot = parseEffectIntent("a lot more reverb on the pads")!;
    expect(barely.amount).toBe("subtle");
    expect(effectKnobDelta(lot)).toBeGreaterThan(effectKnobDelta(little));
    expect(effectKnobDelta(little)).toBeGreaterThan(effectKnobDelta(barely));
  });
});

describe("execution — verified state, not parsed intention", () => {
  const doc = testDoc();
  const before = doc.master?.masterGain ?? 1;

  const gainAfter = (text: string): number => {
    const intent = parseFaderIntent(text);
    expect(intent, `"${text}" must parse as a fader intent`).not.toBeNull();
    const command = applyFaderIntent(doc, intent!);
    expect(command, `"${text}" must produce a command`).not.toBeNull();
    return command!.execute(doc).master?.masterGain ?? Number.NaN;
  };

  it("direction is correct: quieter lowers gain, louder raises it", () => {
    expect(gainAfter("make the master a little quieter")).toBeLessThan(before);
    expect(gainAfter("make the master a little louder")).toBeGreaterThan(before);
  });

  it("magnitude is ordered end to end, through the real command", () => {
    const barely = gainAfter("turn down the master barely");
    const little = gainAfter("turn down the master a little");
    const lot = gainAfter("turn down the master a lot");
    expect(barely).toBeGreaterThan(little);
    expect(little).toBeGreaterThan(lot);
    expect(lot).toBeLessThan(before);
  });

  it("the maximum ask stays inside the parameter bounds", () => {
    let current = before;
    for (let i = 0; i < 40; i++) {
      const next = gainAfter("turn down the master completely");
      expect(next).toBeGreaterThanOrEqual(0);
      current = next;
    }
    // Saturation, not runaway: repeated maximum steps settle, never go NaN.
    expect(Number.isFinite(current)).toBe(true);
  });

  it("an explicit number beats a qualitative word (exact stays exact)", () => {
    // "a bit" would be ×0.92; the named 10 % must win instead.
    const intent = parseFaderIntent("turn down the master by 10%")!;
    expect(intent.percent).toBe(10);
    const command = applyFaderIntent(doc, intent)!;
    expect(command.execute(doc).master?.masterGain).toBeCloseTo(Math.min(1.5, before * 0.9) * 1, 5);
  });
});

describe("context and reference resolution — comparative follow-ups", () => {
  it("'even less' is a further relative step, not an absent direction", () => {
    // Was: FADER_DOWN required a mix noun after "less", so a bare "even less"
    // named no direction at all and fell through to generation.
    const intent = parseFaderIntent("make it even less on the bass");
    expect(intent).not.toBeNull();
    expect(intent!.direction).toBe("down");
  });

  it("'still more' resolves upward", () => {
    const intent = parseFaderIntent("make it still more on the bass");
    expect(intent).not.toBeNull();
  });

  it("a target-less comparative still declines rather than guessing", () => {
    // The fader must never invent a target: no noun, no mutation.
    expect(parseFaderIntent("make it even less")).toBeNull();
    expect(parseFaderIntent("make it a little less again")).toBeNull();
  });

  it("'a little less again' repeats the same step the phrase already names", () => {
    // A repeat is a phrasing of the same intent, not a memory lookup: the
    // degree says how much, the direction says which way.
    const again = parseFaderIntent("make it a little less again on the bass");
    expect(again).not.toBeNull();
    expect(again!.direction).toBe("down");
    expect(again!.degree?.level).toBe(3);
    // "again" must not stack a SECOND step on top of the degree — the factor
    // is exactly the level-3 one (measured 0.92), not 0.92².
    expect(calibrateFaderFactor(again!.degree!.value, "down")).toBe(0.92);
  });
});

/**
 * FALSE-POSITIVE GUARD (P1, audit 2026-10-18).
 *
 * Sharing one vocabulary across the fader, effect and param layers is what
 * fixes "much more reverb" — and it is also the way a descriptive sentence
 * could silently become a mutation. The words that carry the most risk are the
 * ones a producer uses when merely COMMENTING: "really muddy", "way too wet",
 * "pretty loud", "significantly buried", "barely audible".
 *
 * This block locks the answer measured on 2026-10-18: none of them parse as a
 * command. If a future synonym addition makes one of these resolve, this test
 * fails — which is the point. A degree word is not a licence to mutate.
 */
describe("false-positive guard — descriptive sentences stay descriptive", () => {
  const DESCRIPTIVE: ReadonlyArray<string> = [
    "the bass is really muddy",
    "the reverb is way too wet",
    "the kick is pretty loud in the low end",
    "this mix is considerably more dynamic than the last one",
    "the pad is barely audible",
    "the vocal is significantly buried",
    "the master is massively loud",
    "the lead is markedly sharper than the reference",
    "the drums are way too dry",
    "the bass sounds a touch boomy",
    "the top end is a hair harsh",
    "the room is as much as possible",
    "the hi-hats are not very present",
    "the kick is a little bit clicky but that is fine",
    "this is very slightly brighter",
    "the mix is somewhat louder than the reference",
    "the bass is as quiet as possible",
    "the bass is much less loud than the lead",
  ];

  it("none of them resolve to a mutating intent", () => {
    for (const text of DESCRIPTIVE) {
      expect(parseFaderIntent(text), `fader must decline: "${text}"`).toBeNull();
      expect(parseEffectIntent(text), `effect must decline: "${text}"`).toBeNull();
      expect(parseParamIntent(text), `param must decline: "${text}"`).toBeNull();
    }
  });

  it("a qualified imperative still DOES resolve (the guard is not a blanket refusal)", () => {
    // Guards that pass by declining everything are worthless. Same words, now
    // as a command, must still produce a real, ordered intent.
    expect(parseFaderIntent("turn down the master considerably")?.degree?.level).toBe(5);
    expect(parseFaderIntent("turn down the master barely")?.degree?.level).toBe(1);
    expect(parseEffectIntent("slightly more reverb on the pads")?.degree?.level).toBe(3);
    expect(parseEffectIntent("much more reverb on the pads")?.degree?.level).toBe(5);
  });

  it("a negated command does not mutate, even when the verb is 'make'", () => {
    // The fence's mutation-verb allowlist did not contain "make", so
    // "don't make the bass quieter" was invisible to it and the fader moved.
    for (const text of [
      "don't make the bass quieter",
      "do not make the master louder",
      "never make the kick quieter",
    ]) {
      const route = routeIntentText(text, testDoc());
      expect(route.kind, text).toBe("clarify");
    }
  });
});

/**
 * COMPOSITION — audit 2026-10-20 (semantic precision).
 *
 * "Very slightly" is weaker than "slightly", and "extremely slightly" weaker
 * still. The band scan alone compared distances, so an intensifier sitting
 * near the concept could win outright: measured "really slightly quieter" →
 * level 6 (×0.70 fader) and "extremely slightly quieter" → level 7 (×0.50),
 * i.e. a polite ask became a maximum one. The shared composition rule fixes
 * the direction of composition without renumbering any single word.
 */
describe("composition — an intensifier in front of a diminisher attenuates", () => {
  it("very/really/extremely slightly are all weaker than slightly", () => {
    const slightly = parseDegree("make it slightly quieter")!;
    const very = parseDegree("make it very slightly quieter")!;
    const really = parseDegree("make it really slightly quieter")!;
    const extremely = parseDegree("make it extremely slightly quieter")!;
    expect(very.level).toBe(2);
    expect(really.level).toBe(2);
    expect(extremely.level).toBe(1);
    expect(very.value).toBeLessThan(slightly.value);
    expect(really.value).toBeLessThan(slightly.value);
    expect(extremely.value).toBeLessThan(very.value);
    expect(really.composition).toBe("intensifiedDiminisher");
    expect(really.matched).toContain("really slightly");
  });

  it("the composed phrase is ordered through the real fader command", () => {
    const doc = testDoc();
    const gainFor = (text: string): number => {
      const intent = parseFaderIntent(text);
      expect(intent, text).not.toBeNull();
      return applyFaderIntent(doc, intent!)!.execute(doc).master?.masterGain ?? Number.NaN;
    };
    const slightly = gainFor("turn down the master slightly");
    const verySlightly = gainFor("turn down the master very slightly");
    const extremelySlightly = gainFor("turn down the master extremely slightly");
    // Less reduction = a higher remaining gain.
    expect(verySlightly).toBeGreaterThan(slightly);
    expect(extremelySlightly).toBeGreaterThan(verySlightly);
  });

  it("production.ts resolves the same composed phrases to the same rung", () => {
    const amount = (text: string): number | undefined =>
      parseProductionIntent(text)?.goals.find((goal) => goal.concept === "deeper")?.amount;
    expect(amount("make the bass slightly deeper")).toBe(0.35);
    expect(amount("make the bass very slightly deeper")).toBe(0.27);
    expect(amount("make the bass really slightly deeper")).toBe(0.27);
    expect(amount("make the bass extremely slightly deeper")).toBe(0.2);
    // A touch is the same level-2 rung in every layer, not a level-3 one.
    expect(amount("make the bass a touch deeper")).toBe(0.27);
  });

  it("'quite a bit' is an idiom for MORE, not an attenuated 'a bit'", () => {
    expect(parseDegree("make the bass quite a bit quieter")!.level).toBe(5);
    const amount = parseProductionIntent("make the bass quite a bit deeper")!.goals.find(
      (goal) => goal.concept === "deeper",
    )!.amount;
    expect(amount).toBe(0.7);
  });
});

/**
 * OUTCOME AND MAGNITUDE PHRASES — audit 2026-10-20.
 *
 * "As little as possible" names the SMALLEST magnitude, so it is level 1 even
 * when the direction is up ("turn it up as little as possible"). "As quiet as
 * possible" names a maximum move toward quiet, so it is level 7 AND a down
 * direction. Conflating the two is how a "barely up" ask became an up step.
 */
describe("outcome and magnitude phrases", () => {
  it("'as little as possible' is the minimal magnitude in either direction", () => {
    const up = parseFaderIntent("turn the bass up as little as possible")!;
    expect(up.direction).toBe("up");
    expect(up.degree?.level).toBe(1);
    const little = parseEffectIntent("use as little reverb as possible on the pads")!;
    expect(little.direction).toBe("less");
    expect(little.degree?.level).toBe(1);
    // Ordered against the neighbouring rung: minimal < a little.
    expect(Math.abs(effectKnobDelta(little))).toBeLessThan(
      Math.abs(effectKnobDelta(parseEffectIntent("a little less reverb on the pads")!)),
    );
  });

  it("'as quiet/completely quiet as possible' is a maximum DOWN move", () => {
    for (const text of [
      "make the bass as quiet as possible",
      "make the bass as quiet as you can",
      "make the bass completely quiet",
    ]) {
      const intent = parseFaderIntent(text);
      expect(intent, text).not.toBeNull();
      expect(intent!.direction, text).toBe("down");
      expect(intent!.degree?.level, text).toBe(7);
    }
  });
});

/**
 * COMPARATIVE AND LESS-MAGNITUDE COVERAGE — audit 2026-10-20.
 *
 * "much less bass" matched no direction stem and fell through to generation;
 * "even less reverb on the bass" matched the FADER comparative and moved the
 * bass fader instead of the reverb (the fader parser ran first and had no
 * effect-noun guard). Both are fixed at the parser, with negative controls for
 * the descriptive forms.
 */
describe("comparative and less-magnitude phrases", () => {
  const doc = testDoc();
  const gainAfter = (text: string): number => {
    const intent = parseFaderIntent(text);
    expect(intent, text).not.toBeNull();
    return applyFaderIntent(doc, intent!)!.execute(doc).master?.masterGain ?? Number.NaN;
  };

  it("much/way/a little less resolve DOWN with the named magnitude", () => {
    expect(parseFaderIntent("make the bass much less loud")?.direction).toBe("down");
    expect(parseFaderIntent("make the bass much less loud")?.degree?.level).toBe(5);
    expect(parseFaderIntent("make the bass way less")?.direction).toBe("down");
    expect(parseFaderIntent("make the bass a little less")?.degree?.level).toBe(3);
    expect(parseFaderIntent("less bass")?.direction).toBe("down");
  });

  it("the magnitude is ordered end to end through the command", () => {
    const plain = gainAfter("turn down the master less loud");
    const much = gainAfter("turn down the master much less loud");
    expect(plain).toBeGreaterThan(much);
  });

  it("an effect noun after 'less' belongs to the effect layer, not the fader", () => {
    const doc2 = testDoc();
    for (const text of [
      "even less reverb on the bass",
      "much less reverb on the bass",
      "a little less delay on the bass",
    ]) {
      expect(parseFaderIntent(text), `fader must decline: "${text}"`).toBeNull();
      const effect = parseEffectIntent(text);
      expect(effect, `effect must claim: "${text}"`).not.toBeNull();
      expect(effect!.direction, text).toBe("less");
      expect(routeIntentText(text, doc2).kind, text).toBe("effectIntent");
    }
  });

  it("descriptive comparisons do not mutate", () => {
    expect(parseFaderIntent("the bass is less loud than the lead")).toBeNull();
    expect(parseFaderIntent("the bass is much less loud than the lead")).toBeNull();
  });
});

/**
 * PRIOR-DELTA REFERENCES — audit 2026-10-20.
 *
 * The engine has no durable adjustment ledger. These asks therefore get a
 * focused clarification; the one thing they may never do is apply the phrase's
 * own step as if it were the remembered delta, or fall through to generation
 * (which replaces the song). A repeat ("a little less again") is a phrasing of
 * the same intent and still applies.
 */
describe("prior-delta references are declined, never guessed", () => {
  it("'a little less than last time' does not silently apply a level-3 step", () => {
    const text = "turn the bass down a little less than last time";
    expect(parseFaderIntent(text)).toBeNull();
    const route = routeIntentText(text, testDoc());
    expect(route.kind).toBe("clarify");
    if (route.kind !== "clarify") return;
    expect(route.reason).toBe("last-adjustment-reference");
    // The offered chip is the producer's own sentence minus the reference, and
    // it must be executable — never a guess.
    expect(route.suggestions.length).toBeGreaterThan(0);
    for (const suggestion of route.suggestions) expect(parseFaderIntent(suggestion)).not.toBeNull();
  });

  it("correction and reuse forms clarify instead of generating a new beat", () => {
    for (const text of ["no, half that adjustment", "do the same on track two"]) {
      const route = routeIntentText(text, testDoc());
      expect(route.kind, text).toBe("clarify");
      if (route.kind === "clarify") expect(route.reason, text).toBe("last-adjustment-reference");
    }
  });

  it("a plain repeat is still a repeat, not a memory lookup", () => {
    const again = parseFaderIntent("make it a little less again on the bass");
    expect(again).not.toBeNull();
    expect(again!.direction).toBe("down");
    expect(again!.degree?.level).toBe(3);
  });
});

/**
 * P0 — DESCRIPTIVE STATEMENTS ARE NOT COMMANDS (audit 2026-10-20, follow-up).
 *
 * Direction words alone are not an instruction. "the bass is quieter than the
 * lead" moved the bass fader, "the pads have too much reverb" added MORE
 * reverb, and "the mix is significantly louder than the reference" started a
 * loudness action. The router now declines these before any mutation parser,
 * and the fader/effect/param parsers enforce the same guard for direct callers.
 */
describe("descriptive statements are not commands", () => {
  const DESCRIPTIONS: ReadonlyArray<string> = [
    "the bass is quieter than the lead",
    "the bass is much less loud than the lead",
    "the pads have too much reverb",
    "the reverb is too wet",
    "the mix is significantly louder than the reference",
    "the lead is markedly sharper than the reference",
    "the top end is a hair harsh",
    "this is very slightly brighter",
    "the mix is somewhat louder than the reference",
    "there is less reverb on the pads",
    "the bass is as quiet as possible",
    "the kick is barely audible",
  ];

  it("the router declines and no mutation parser claims them", () => {
    for (const text of DESCRIPTIONS) {
      const route = routeIntentText(text, testDoc());
      expect(route.kind, text).toBe("clarify");
      if (route.kind === "clarify") expect(route.reason, text).toBe("descriptive-not-a-command");
      expect(parseFaderIntent(text), `fader: ${text}`).toBeNull();
      expect(parseEffectIntent(text), `effect: ${text}`).toBeNull();
      expect(parseParamIntent(text), `param: ${text}`).toBeNull();
    }
  });

  it("an imperative anywhere keeps the command valid", () => {
    // A description plus an instruction is still an instruction.
    expect(routeIntentText("the bass is too loud, turn it down", testDoc()).kind).toBe("fader");
    expect(parseFaderIntent("the bass is too loud, turn it down")?.direction).toBe("down");
    expect(routeIntentText("the bass is muddy, make it warmer", testDoc()).kind).toBe("complaintIntent");
  });

  it("a creative prompt that merely contains a description still generates", () => {
    // The guard must not swallow generation prompts: no mix subject and/or an
    // imperative verb keeps the pattern route.
    expect(routeIntentText("a beat that is dark and warm", testDoc()).kind).toBe("pattern");
    expect(routeIntentText("make a beat that is dark and warm", testDoc()).kind).toBe("pattern");
  });
});

/**
 * P1 — PRIOR-ADJUSTMENT LEDGER (audit 2026-10-20, follow-up).
 *
 * The session ledger remembers the measured last RELATIVE FADER move. These
 * tests enter through the real appliers, record what actually landed, resolve
 * the reference, and verify the SECOND move against the state it produced.
 * Effect/param changes deliberately invalidate the fader-only record.
 */
describe("prior-adjustment ledger", () => {
  const gainOf = (doc: ReturnType<typeof testDoc>, name: string): number => {
    const track = doc.tracks.find((candidate) => candidate.name === name);
    if (!track) throw new Error(`no track ${name}`);
    return track.gain;
  };
  const db = (after: number, before: number): number => 20 * Math.log10(after / before);

  const recorded = () => {
    clearAdjustmentLedger();
    const doc = testDoc();
    const first = parseFaderIntent("turn the bass down a little")!;
    const after1 = applyFaderIntent(doc, first)!.execute(doc);
    recordFaderAdjustment(doc.id, first, doc, after1);
    return { doc, after1 };
  };

  it("'half that adjustment' halves the dB move that actually landed", () => {
    const { doc, after1 } = recorded();
    const entry = lastAdjustment(doc.id) as FaderRecord;
    expect(entry.factor).toBeLessThan(1);
    const half = resolvePriorAdjustment("no, half that adjustment", after1);
    expect(half?.kind).toBe("fader");
    if (half?.kind !== "fader") return;
    expect(half.intent.factor).toBeCloseTo(Math.sqrt(entry.factor), 6);
    const after2 = applyFaderIntent(after1, half.intent)!.execute(after1);
    const firstDb = db(gainOf(after1, "808"), gainOf(doc, "808"));
    const halfDb = db(gainOf(after2, "808"), gainOf(after1, "808"));
    expect(halfDb).toBeLessThan(0);
    expect(Math.abs(halfDb)).toBeLessThan(Math.abs(firstDb));
    // 2-decimal gain rounding in the applier: within ~0.1 dB is exact enough.
    expect(Math.abs(Math.abs(halfDb) - Math.abs(firstDb) / 2)).toBeLessThan(0.15);
  });

  it("'a little less than last time' is ONE rung weaker, not a fresh nominal step", () => {
    const { doc, after1 } = recorded();
    const less = resolvePriorAdjustment("a little less than last time", after1);
    expect(less?.kind).toBe("fader");
    if (less?.kind !== "fader") return;
    // The original ask was level 3 ("a little"); one rung weaker is level 2.
    expect(less.intent.degree?.level).toBe(2);
    const after2 = applyFaderIntent(after1, less.intent)!.execute(after1);
    const firstDelta = gainOf(doc, "808") - gainOf(after1, "808");
    const secondDelta = gainOf(after1, "808") - gainOf(after2, "808");
    expect(secondDelta).toBeGreaterThan(0);
    expect(secondDelta).toBeLessThan(firstDelta);
  });

  it("'much less than last time' is TWO rungs weaker and saturates at level 1", () => {
    const { after1 } = recorded();
    const less = resolvePriorAdjustment("much less than last time", after1);
    expect(less?.kind).toBe("fader");
    if (less?.kind !== "fader") return;
    expect(less.intent.degree?.level).toBe(1);
    expect(less.intent.amount).toBe("subtle");
  });

  it("'do the same on track three' reuses the factor on the NEW track", () => {
    const { doc, after1 } = recorded();
    const entry = lastAdjustment(doc.id) as FaderRecord;
    const chords = doc.tracks.find((track) => track.name === "Chords")!;
    const same = resolvePriorAdjustment("do the same on track three", after1);
    expect(same?.kind).toBe("fader");
    if (same?.kind !== "fader") return;
    expect(same.intent.trackIds).toEqual([chords.id]);
    expect(same.intent.targets).toEqual([]);
    expect(same.intent.factor).toBeCloseTo(entry.factor, 6);
    const after2 = applyFaderIntent(after1, same.intent)!.execute(after1);
    expect(gainOf(after2, "Chords")).toBeLessThan(gainOf(after1, "Chords"));
    expect(gainOf(after2, "808")).toBeCloseTo(gainOf(after1, "808"), 6);
  });

  it("'do the same on track two' resolves the second non-group track", () => {
    const { doc, after1 } = recorded();
    const second = doc.tracks.filter((track) => track.kind !== "group")[1]!;
    const same = resolvePriorAdjustment("do the same on track two", after1);
    expect(same?.kind).toBe("fader");
    if (same?.kind !== "fader") return;
    expect(same.intent.trackIds).toEqual([second.id]);
  });

  it("does not remember one factor when a multi-target move hits different bounds", () => {
    clearAdjustmentLedger();
    const doc = testDoc();
    const bass = doc.tracks.find((track) => track.name === "808")!;
    const drums = doc.tracks.find((track) => track.kind === "drum")!;
    const before = {
      ...doc,
      tracks: doc.tracks.map((track) =>
        track.id === bass.id ? { ...track, gain: 1.49 } : track.id === drums.id ? { ...track, gain: 0.7 } : track,
      ),
    };
    const intent = parseFaderIntent("turn the bass and drums up a little")!;
    const after = applyFaderIntent(before, intent)!.execute(before);

    recordFaderAdjustment(before.id, intent, before, after);

    expect(lastAdjustment(before.id)).toBeNull();
    expect(resolvePriorAdjustment("half that adjustment", after)).toEqual({
      kind: "clarify",
      reason: "last-adjustment-reference",
    });
  });

  it("remembers a multi-target move when every target landed at the same factor", () => {
    clearAdjustmentLedger();
    const doc = testDoc();
    const bass = doc.tracks.find((track) => track.name === "808")!;
    const drums = doc.tracks.find((track) => track.kind === "drum")!;
    const before = {
      ...doc,
      tracks: doc.tracks.map((track) =>
        track.id === bass.id || track.id === drums.id ? { ...track, gain: 0.8 } : track,
      ),
    };
    const intent = parseFaderIntent("turn the bass and drums down a little")!;
    const after = applyFaderIntent(before, intent)!.execute(before);

    recordFaderAdjustment(before.id, intent, before, after);

    expect((lastAdjustment(before.id) as FaderRecord).factor).toBeGreaterThan(0);
    expect(lastAdjustment(before.id)?.targets).toEqual(["bass", "drums"]);
  });

  it("the ROUTER returns the executable fader route, not a guess or a pattern", () => {
    const { after1 } = recorded();
    const route = routeIntentText("no, half that adjustment", after1);
    expect(route.kind).toBe("fader");
    if (route.kind === "fader") expect(route.intent.factor).toBeLessThan(1);
  });

  it("project switch, undo/clear and effect/param changes invalidate the reference", () => {
    const { doc, after1 } = recorded();
    expect(resolvePriorAdjustment("no, half that adjustment", { ...after1, id: "other-project" })).toEqual({
      kind: "clarify",
      reason: "last-adjustment-reference",
    });
    clearAdjustmentLedger();
    expect(resolvePriorAdjustment("no, half that adjustment", after1)).toEqual({
      kind: "clarify",
      reason: "last-adjustment-reference",
    });
    // Re-record, then a different kind of change supersedes it.
    const first = parseFaderIntent("turn the bass down a little")!;
    recordFaderAdjustment(doc.id, first, doc, after1);
    recordEffectAdjustment(doc.id, parseEffectIntent("more reverb on the pads")!, after1, after1);
    expect(resolvePriorAdjustment("no, half that adjustment", after1)).toEqual({
      kind: "clarify",
      reason: "last-adjustment-reference",
    });
  });

  it("a deleted target asks for a track instead of throwing", () => {
    const { doc, after1 } = recorded();
    const withoutBass = { ...after1, tracks: after1.tracks.filter((track) => track.name !== "808") };
    const result = resolvePriorAdjustment("no, half that adjustment", withoutBass);
    expect(result).toEqual({ kind: "clarify", reason: "prior-adjustment-target" });
    expect(doc.id).toBe(after1.id);
  });
});

/**
 * CANONICAL CONTRACT (2026-10-21).
 *
 * The same word must resolve to the same level in KYX and VocalForge. The
 * contract table marks KYX-only extensions (quite/pretty/really) explicitly;
 * every shared word must match its canonical level. The cross-engine parity
 * script (scripts/check-intent-degree-parity.mjs) compares the same table to
 * the VocalForge checkout when it is present.
 */
describe("canonical degree contract", () => {
  it("every contract word resolves to its canonical level", () => {
    for (const entry of CANONICAL_DEGREE_WORDS) {
      const degree = parseDegree(entry.word);
      expect(degree, entry.word).not.toBeNull();
      expect(degree!.level, entry.word).toBe(entry.level);
    }
  });

  it("the three divergent words are resolved", () => {
    expect(parseDegree("much")!.level).toBe(5);
    expect(parseDegree("noticeably")!.level).toBe(4);
    expect(parseDegree("quite")!.level).toBe(4);
    expect(parseDegree("a lot")!.level).toBe(6);
  });
});

describe("quantity parser — explicit numbers are not degrees", () => {
  it("distinguishes a destination from a movement", () => {
    expect(parseQuantity("set the bass to -9 dB")).toEqual({ kind: "db", value: -9, absolute: true });
    expect(parseQuantity("lower the bass by 2.5 db")).toEqual({ kind: "db", value: 2.5, absolute: false });
    expect(parseQuantity("+3 dB on the lead")).toEqual({ kind: "db", value: 3, absolute: false });
  });

  it("reads percent destinations and movements", () => {
    expect(parseQuantity("set width to 50%")).toEqual({ kind: "percent", value: 50, absolute: true });
    expect(parseQuantity("by 10 %")).toEqual({ kind: "percent", value: 10, absolute: false });
  });

  it("reads scaling and step counts", () => {
    expect(parseQuantity("half that adjustment")).toEqual({ kind: "factor", value: 0.5 });
    expect(parseQuantity("twice as much")).toEqual({ kind: "factor", value: 2 });
    expect(parseQuantity("one step further")).toEqual({ kind: "steps", count: 1 });
    expect(parseQuantity("two notches back")).toEqual({ kind: "steps", count: 2 });
  });

  it("does not invent a unit for a bare number", () => {
    expect(parseQuantity("make it 3")).toBeNull();
    expect(parseQuantity("track 2")).toBeNull();
  });

  it("formats the same shape the resolver stores", () => {
    expect(formatQuantity({ kind: "db", value: -9, absolute: true })).toBe("to -9 dB");
    expect(formatQuantity({ kind: "factor", value: 0.5 })).toBe("×0.5");
    expect(formatQuantity({ kind: "steps", count: 2 })).toBe("2 steps");
  });
});
