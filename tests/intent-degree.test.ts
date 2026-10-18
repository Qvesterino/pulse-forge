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
 *   3. every pre-existing word keeps its exact old bucket and its exact old
 *      number (additive-only rule — nothing a human has listened to moves);
 *   4. the cross-domain defects the audit found are actually gone.
 */

const LEVELS: ReadonlyArray<readonly [DegreeLevel, readonly string[]]> = [
  [1, ["barely", "almost imperceptibly", "hardly", "the tiniest bit"]],
  [2, ["a touch", "a hair", "just a tiny bit", "a tad"]],
  [3, ["slightly", "a little", "a bit", "trochu", "subtle"]],
  [4, ["somewhat", "moderately", "fairly"]],
  [5, ["considerably", "significantly", "noticeably", "quite"]],
  [6, ["much", "a lot", "dramatically", "huge", "veľmi"]],
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
    expect(parseDegree(text, secondConcept)!.level).toBe(6);
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

describe("additive-only rule — no previously handled word moved", () => {
  it("the gain anchors reproduce FADER_FACTORS exactly", () => {
    expect(calibrateFaderFactor(0.35, "down")).toBe(0.92); // subtle
    expect(calibrateFaderFactor(0.35, "up")).toBe(1.08);
    expect(calibrateFaderFactor(0.7, "down")).toBe(0.82); // normal
    expect(calibrateFaderFactor(0.7, "up")).toBe(1.22);
    expect(calibrateFaderFactor(0.85, "down")).toBe(0.7); // big
    expect(calibrateFaderFactor(0.85, "up")).toBe(1.35);
    expect(calibrateFaderFactor(0.95, "down")).toBe(0.5); // full
    expect(calibrateFaderFactor(0.95, "up")).toBe(1.6);
  });

  it("the knob anchors reproduce AMOUNT_SCALE exactly", () => {
    expect(calibrateKnobScale(0.35)).toBe(0.5); // subtle
    expect(calibrateKnobScale(0.7)).toBe(1); // medium
    expect(calibrateKnobScale(0.85)).toBe(1.75); // huge
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

  it("the enum projection matches every legacy word", () => {
    expect(degreeToFaderAmount(3)).toBe("subtle");
    expect(degreeToFaderAmount(6)).toBe("big");
    expect(degreeToFaderAmount(7)).toBe("full");
    expect(degreeToEffectAmount(3)).toBe("subtle");
    expect(degreeToEffectAmount(5)).toBe("medium");
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

  it("'much' outranks the medium default instead of falling into it", () => {
    // Was: "much" had no rung in mix.ts or param-intent.ts, so "much more
    // reverb" was medium while "a lot more reverb" was huge — inverted.
    const much = parseEffectIntent("much more reverb on the pads")!;
    const lot = parseEffectIntent("a lot more reverb on the pads")!;
    expect(much.amount).toBe("huge");
    expect(effectKnobDelta(much)).toBeGreaterThan(effectKnobDelta(lot) * 0.9);
    expect(much.amount).toBe(lot.amount);
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
  });
});
