import { describe, expect, it } from "vitest";
import {
  parseParamIntent,
  applyParamIntent,
  paramMovePreview,
  paramPlanLines,
  paramReadback,
  type ParamIntent,
} from "../src/intent/param-intent";
import { routeIntentText } from "../src/intent/route";
import { buildCapabilityMatrix, capabilityIssues } from "../src/intent/semantics/param-registry";
import { EFFECT_META } from "../src/effects/definitions";
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

/**
 * P1 — a fully-resolved PARAMETER with no track must ask for the track, not
 * fall through to pattern generation (which replaces the song).
 */
describe("param ask with no track — target clarification", () => {
  it("offers executable track-completed sentences", () => {
    const doc = testDoc();
    const route = routeIntentText("make the reverb tail a little longer", doc);
    expect(route.kind).toBe("clarify");
    if (route.kind !== "clarify") return;
    expect(route.reason).toBe("param-target");
    expect(route.suggestions.length).toBeGreaterThan(0);
    for (const suggestion of route.suggestions) {
      const parsed = parseParamIntent(suggestion);
      expect(parsed, suggestion).not.toBeNull();
      expect(parsed!.degree?.level, suggestion).toBe(3);
      expect(parsed!.targets.length, suggestion).toBeGreaterThan(0);
    }
  });

  it("the same ask WITH a track still parses normally", () => {
    expect(parseParamIntent("make the reverb tail a little longer on the lead")).not.toBeNull();
    expect(routeIntentText("make the reverb tail a little longer on the lead", testDoc()).kind).toBe("paramIntent");
  });
});

/**
 * P2 — CALIBRATION ACROSS THE SEVEN LEVELS × PARAMETER FAMILIES.
 *
 * The same spoken degree must not produce a different order on a dB threshold,
 * a log-tapered attack, a linear Q or a stereo width. Every row also asserts
 * the DIRECTION the role names (faster attack = shorter, lower cutoff =
 * darker, wider = more width) and that the stronger word never lands weaker.
 * Destination clamping is allowed and is reported by `paramPlan` — saturation
 * at the bounds is explicit, not hidden.
 */
describe("seven-level calibration across parameter families", () => {
  const LEVELS: ReadonlyArray<readonly [number, string]> = [
    [1, "barely"],
    [2, "a touch"],
    [3, "slightly"],
    [4, "somewhat"],
    [5, "quite"],
    [6, "much"],
    [7, "as much as possible"],
  ];

  interface Family {
    name: string;
    make: (degree: string) => string;
    effectType: string;
    paramId: string;
    direction: "more" | "less";
    domain: "log" | "linear";
    current: number;
  }

  const FAMILIES: ReadonlyArray<Family> = [
    {
      name: "saturation mix",
      make: (d) => `${d} more saturation mix on the 808`,
      effectType: "saturation",
      paramId: "mix",
      direction: "more",
      domain: "linear",
      current: 0.4,
    },
    {
      name: "saturation tone",
      make: (d) => `${d} brighter saturation tone on the 808`,
      effectType: "saturation",
      paramId: "tone",
      direction: "more",
      domain: "log",
      current: 6000,
    },
    {
      name: "reverb decay",
      make: (d) => `${d} longer reverb decay on the 808`,
      effectType: "reverb",
      paramId: "decay",
      direction: "more",
      domain: "linear",
      current: 1.8,
    },
    {
      name: "compressor threshold",
      make: (d) => `${d} lower compressor threshold on the drums`,
      effectType: "compressor",
      paramId: "threshold",
      direction: "less",
      domain: "linear",
      current: -18,
    },
    {
      name: "compressor attack",
      make: (d) => `${d} faster compressor attack on the drums`,
      effectType: "compressor",
      paramId: "attack",
      direction: "less",
      domain: "log",
      current: 0.01,
    },
    {
      name: "compressor release",
      make: (d) => `${d} longer compressor release on the drums`,
      effectType: "compressor",
      paramId: "release",
      direction: "more",
      domain: "log",
      current: 0.2,
    },
    {
      name: "filter cutoff",
      make: (d) => `${d} lower filter cutoff on the 808`,
      effectType: "svFilter",
      paramId: "cutoff",
      direction: "less",
      domain: "log",
      current: 2000,
    },
    {
      name: "filter Q",
      make: (d) => `${d} higher filter Q on the 808`,
      effectType: "svFilter",
      paramId: "resonance",
      direction: "more",
      domain: "linear",
      current: 0.3,
    },
    {
      name: "widener width",
      make: (d) => `${d} wider widener width on the chords`,
      effectType: "haasWidener",
      paramId: "width",
      direction: "more",
      domain: "linear",
      current: 0.7,
    },
  ];

  for (const family of FAMILIES) {
    it(`${family.name}: levels are ordered and the direction is ${family.direction}`, () => {
      let previousFraction = -1;
      for (const [level, word] of LEVELS) {
        const text = family.make(word);
        const intent = parseParamIntent(text);
        expect(intent, text).not.toBeNull();
        if (!intent) continue;
        expect(intent.effectType, text).toBe(family.effectType);
        expect(intent.paramId, text).toBe(family.paramId);
        expect(intent.mode, text).toBe(family.direction);
        expect(intent.degree?.level, text).toBe(level);
        const preview = paramMovePreview(intent, family.current);
        expect(preview, text).not.toBeNull();
        if (!preview) continue;
        expect(preview.domain, text).toBe(family.domain);
        expect(preview.fraction, text).not.toBeNull();
        expect(preview.fraction!, text).toBeGreaterThanOrEqual(previousFraction - 1e-9);
        previousFraction = preview.fraction!;
        if (family.direction === "more") {
          expect(preview.next, text).toBeGreaterThanOrEqual(family.current - 1e-9);
        } else {
          expect(preview.next, text).toBeLessThanOrEqual(family.current + 1e-9);
        }
      }
    });
  }

  it("precision: exact units win, bounds clamp, and the request is preserved", () => {
    const threshold = mustParse("set the compressor threshold to -20 dB on the drums");
    expect(threshold.mode).toBe("set");
    expect(threshold.value).toBe(-20);
    expect(threshold.requestedValue).toBe(-20);

    const outOfBounds = mustParse("set the compressor threshold to -200 dB on the drums");
    expect(outOfBounds.value).toBe(-60);
    expect(outOfBounds.requestedValue).toBe(-200);

    const attack = mustParse("set compressor attack to 5 ms on the drums");
    expect(attack.value).toBeCloseTo(0.005, 9);

    const cutoff = mustParse("set filter cutoff to 12 kHz on the 808");
    expect(cutoff.value).toBe(12000);

    const width = mustParse("set widener width to 50% on the chords");
    expect(width.value).toBe(0.5);

    const q = mustParse("set filter Q to 0.5 on the 808");
    expect(q.value).toBe(0.5);

    // A unit wins over a qualifier: the exact number is not nudged.
    const exactWins = mustParse("slightly lower the compressor threshold to -20 dB on the drums");
    expect(exactWins.value).toBe(-20);

    // "set … lower" names no value — decline instead of applying a default step.
    expect(parseParamIntent("set the compressor threshold lower on the drums")).toBeNull();
  });

  it("a clamped set is visible BEFORE execution and shows the requested value", () => {
    const q = mustParse("set filter Q to 2.5 on the 808");
    expect(q.requestedValue).toBe(2.5);
    expect(q.value).toBe(1);
    const plan = paramPlanLines(q, testDoc()).join(" ");
    expect(plan).toContain("svFilter.resonance");
    expect(plan).toContain("clamped to");
    expect(plan).toContain("100%");
  });

  it("paramPlan exposes the inferred delta in the param's own domain", () => {
    const plan = paramPlanLines(mustParse("slightly longer reverb decay on the 808"), testDoc());
    const line = plan.join(" ");
    expect(line).toContain("808: reverb.decay");
    expect(line).toContain("1.80 s");
    expect(line).toContain("3.39 s");
    expect(line).toContain("8% linear");
    expect(line).toContain("(add)");
    expect(paramPlanLines(mustParse("slightly longer reverb decay on the lead"), testDoc())).toEqual([
      "lead: no matching track",
    ]);
  });
});

/**
 * STEP 3 (2026-10-21) — THE REGISTRY IS THE INVENTORY.
 *
 * The role table, the capability matrix, the corpus and the readback metric
 * now all derive from `src/intent/semantics/param-registry.ts`. These tests
 * keep the registry honest: every capability must point at a real ParamDef,
 * the matrix must state its owner and evidence, and the 7-level corpus runs
 * FROM the matrix instead of a second hand-written family list.
 */
describe("param registry & capability matrix", () => {
  const LEVELS: ReadonlyArray<readonly [number, string]> = [
    [1, "barely"],
    [2, "a touch"],
    [3, "slightly"],
    [4, "somewhat"],
    [5, "quite"],
    [6, "much"],
    [7, "as much as possible"],
  ];

  it("no capability lies about a ParamDef or an example template", () => {
    expect(capabilityIssues()).toEqual([]);
  });

  it("the matrix states bounds, domain, owner and evidence for every row", () => {
    const rows = buildCapabilityMatrix();
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      const def = EFFECT_META[row.effectType].params.find((param) => param.id === row.paramId);
      expect(def, `${row.role}:${row.effectType}.${row.paramId}`).toBeDefined();
      expect(row.min).toBe(def!.min);
      expect(row.max).toBe(def!.max);
      expect(row.default).toBe(def!.default);
      expect(row.domain).toBe(def!.taper === "log" ? "log" : "linear");
      expect(row.exposedBy).toBe(row.primary ? "effect" : "param");
      expect(row.examples.more).toContain("${degree}");
      expect(row.examples.less).toContain("${degree}");
      expect(["pending", "done", "not-applicable"]).toContain(row.listening);
      if (row.metric != null) expect(["rms", "centroid", "crest", "width"]).toContain(row.metric);
    }
  });

  it("the P2 param-exposed families are all present", () => {
    const exposed = buildCapabilityMatrix()
      .filter((row) => row.exposedBy === "param")
      .map((row) => `${row.role}:${row.effectType}.${row.paramId}`);
    expect(exposed).toEqual(
      expect.arrayContaining([
        "mix:saturation.mix",
        "tone:saturation.tone",
        "time:reverb.decay",
        "time:delay.time",
        "threshold:compressor.threshold",
        "attack:compressor.attack",
        "release:compressor.release",
        "cutoff:svFilter.cutoff",
        "q:svFilter.resonance",
        "width:haasWidener.width",
      ]),
    );
  });

  it("the 7-level corpus runs FROM the registry, in both directions", () => {
    const rows = buildCapabilityMatrix().filter((row) => row.exposedBy === "param");
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      const label = `${row.role}:${row.effectType}.${row.paramId}`;
      for (const direction of ["more", "less"] as const) {
        const current = row.min + (row.max - row.min) * (direction === "more" ? 0.25 : 0.75);
        let previousFraction = -1;
        for (const [level, word] of LEVELS) {
          const text = row.examples[direction].replace("${degree}", word);
          const intent = parseParamIntent(text);
          expect(intent, `${label} ${direction} ${word}: "${text}"`).not.toBeNull();
          if (!intent) continue;
          expect(intent.effectType, text).toBe(row.effectType);
          expect(intent.paramId, text).toBe(row.paramId);
          expect(intent.mode, text).toBe(direction);
          expect(intent.degree?.level, text).toBe(level);
          const preview = paramMovePreview(intent, current);
          expect(preview, text).not.toBeNull();
          if (!preview) continue;
          expect(preview.domain, text).toBe(row.domain);
          expect(preview.fraction, text).not.toBeNull();
          expect(preview.fraction!, text).toBeGreaterThanOrEqual(previousFraction - 1e-9);
          previousFraction = preview.fraction!;
          if (direction === "more") expect(preview.next, text).toBeGreaterThanOrEqual(current - 1e-9);
          else expect(preview.next, text).toBeLessThanOrEqual(current + 1e-9);
        }
      }
    }
  });
});
