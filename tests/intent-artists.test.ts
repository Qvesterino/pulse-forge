import { describe, it, expect } from "vitest";
import { matchArtistPreset } from "../src/intent/artists";
import { parseIntentText } from "../src/intent/text-parser";
import { normalizeIntent } from "../src/intent/normalize";
import { parseReviseIntent, routeIntentText, REVISE_DELTA } from "../src/intent/route";
import { testDoc } from "./fixtures/doc";
import { generateAsyncResult } from "../src/intent/pipeline";

describe("artist type-beat presets (C1)", () => {
  it("travis scott type beat → trap/rolling/dark with researched BPM", () => {
    const parsed = parseIntentText("travis scott type beat");
    expect(parsed.input.genre).toBe("trap");
    expect(parsed.input.style).toBe("rolling");
    expect(parsed.input.mood).toBe("dark");
    expect(parsed.input.bpmRange).toEqual([130, 140]);
    expect(parsed.input.energy).toBe(0.7);
    expect(parsed.detected).toContain("♪ travis scott");
  });

  it("works without the 'type beat' phrase and with SK filler", () => {
    expect(parseIntentText("travis scott beat").input.genre).toBe("trap");
    expect(parseIntentText("nieco ako metro boomin prosim").input.mood).toBe("dark");
  });

  it("explicit text words override the preset base", () => {
    const parsed = parseIntentText("travis scott type beat bright");
    // bright → mood energetic + energy trait 0.95 beat the preset's dark/0.7
    expect(parsed.input.mood).toBe("energetic");
    expect(parsed.input.energy).toBe(0.95);
    // genre/style from the preset survive (text added no genre word)
    expect(parsed.input.genre).toBe("trap");
  });

  it("covers rage, boom bap and drill references", () => {
    expect(parseIntentText("rage beat").input.mood).toBe("aggressive");
    expect(parseIntentText("rage beat").input.bpmRange).toEqual([150, 165]);
    expect(parseIntentText("southstar type beat").input.style).toBe("bouncy");
    expect(parseIntentText("kanye type beat").input.style).toBe("classic");
    expect(parseIntentText("kanye type beat").input.bpmRange).toEqual([86, 92]);
  });

  it("drill resolves to the drill genre (first-class since the sound-quality pass)", () => {
    // History: drill→techno was a tempo-proximity bug, fixed to trap family;
    // now drill has its own grooves/kit, so it stays drill.
    expect(parseIntentText("uk drill beat").input.genre).toBe("drill");
    expect(parseIntentText("central cee type beat").input.genre).toBe("drill");
  });

  it("no artist → no chip, parsing unchanged", () => {
    const parsed = parseIntentText("dark rolling techno at 140");
    expect(parsed.detected.some((d) => d.startsWith("♪"))).toBe(false);
    expect(parsed.input.genre).toBe("techno");
    expect(matchArtistPreset(" dark rolling techno at 140 ")).toBeNull();
  });

  it("matcher is deterministic", () => {
    expect(matchArtistPreset(" travis scott type beat ")).toEqual(matchArtistPreset("travis scott"));
  });
});

describe("revise intent (C2)", () => {
  it("parses the user's exact phrasings EN and SK", () => {
    expect(parseReviseIntent("more energetic")).toEqual({
      attribute: "energy",
      direction: "more",
      detected: [],
      targetRole: null,
    });
    expect(parseReviseIntent("more energic")?.attribute).toBe("energy");
    expect(parseReviseIntent("menej husty")).toEqual({
      attribute: "density",
      direction: "less",
      detected: [],
      targetRole: null,
    });
    expect(parseReviseIntent("busier drums")?.attribute).toBe("density");
    expect(parseReviseIntent("calmer")).toEqual({
      attribute: "energy",
      direction: "less",
      detected: [],
      targetRole: null,
    });
  });

  it("non-revise text returns null", () => {
    expect(parseReviseIntent("dark rolling techno at 140")).toBeNull();
    expect(parseReviseIntent("travis scott type beat")).toBeNull();
  });

  it("router priorities: punch stays MIX, energy comparatives become REVISE, plain adjectives stay PATTERN", () => {
    const doc = testDoc();
    expect(routeIntentText("more punch", doc).kind).toBe("mix");
    expect(routeIntentText("darker", doc).kind).toBe("mix");
    expect(routeIntentText("more energetic", doc).kind).toBe("revise");
    expect(routeIntentText("dark techno", doc).kind).toBe("pattern");
    const revise = routeIntentText("viac energie", doc);
    expect(revise.kind).toBe("revise");
    if (revise.kind === "revise") {
      expect(revise.attribute).toBe("energy");
      expect(revise.direction).toBe("more");
    }
  });
});

describe("revise execution — same seed identity (C2)", () => {
  it("same seed + shifted slider = same beat family, different content", async () => {
    const doc = testDoc();
    const base = normalizeIntent({ genre: "trap", seed: "revise-me", energy: 0.5, length: 16 });
    const shifted = normalizeIntent({
      genre: "trap",
      seed: "revise-me",
      energy: Math.max(0, Math.min(1, 0.5 + REVISE_DELTA)),
      length: 16,
    });
    const resultA = await generateAsyncResult(doc, base, { mode: "apply" });
    const resultB = await generateAsyncResult(doc, shifted, { mode: "apply" });
    if (!resultA.proposal || !resultB.proposal) {
      throw new Error("both deterministic intent generations must produce a proposal");
    }
    // identity: the SAME generation seed
    expect(resultB.plan.intent.seed).toBe(resultA.plan.intent.seed);
    // character: the slider actually moved, content changed
    expect(resultB.plan.intent.energy).toBeCloseTo(0.65, 5);
    expect(resultA.proposal.pattern.generation?.outputContentHash).not.toBe(
      resultB.proposal.pattern.generation?.outputContentHash,
    );
    // determinism: same inputs reproduce the same hashes
    const resultB2 = await generateAsyncResult(doc, shifted, { mode: "apply" });
    expect(resultB2.proposal!.pattern.generation?.outputContentHash).toBe(
      resultB.proposal!.pattern.generation?.outputContentHash,
    );
  });
});

describe("targeted section revise (C3)", () => {
  it("role words make the revise TARGETED", () => {
    expect(parseReviseIntent("make bridge more energic")).toEqual({
      attribute: "energy",
      direction: "more",
      detected: ["bridge §"],
      targetRole: "bridge",
    });
    expect(parseReviseIntent("sprav most menej husty")?.targetRole).toBe("bridge");
    expect(parseReviseIntent("chorus busier")?.targetRole).toBe("chorus");
    // global revise stays global
    expect(parseReviseIntent("more energetic")?.targetRole).toBeNull();
    // plain role word without comparative is NOT a revise
    expect(parseReviseIntent("bridge")).toBeNull();
  });

  it("router keeps the role through routing", () => {
    const doc = testDoc();
    const route = routeIntentText("make bridge more energic", doc);
    expect(route.kind).toBe("revise");
    if (route.kind === "revise") {
      expect(route.targetRole).toBe("bridge");
      expect(route.attribute).toBe("energy");
    }
  });
});

describe("expanded artist roster (vocabulary wave)", () => {
  it("maps techno references to peak-time/hard variants", () => {
    const charlotte = parseIntentText("charlotte de witte type beat");
    expect(charlotte.input.genre).toBe("techno");
    expect(charlotte.input.style).toBe("driving");
    expect(charlotte.input.mood).toBe("aggressive");
    expect(charlotte.input.bpmRange).toEqual([145, 152]);
    expect(parseIntentText("ben klock type beat").input.style).toBe("minimal");
    expect(parseIntentText("sara landry type beat").input.bpmRange).toEqual([148, 155]);
    expect(parseIntentText("boris brejcha type beat").input.bpmRange).toEqual([120, 126]);
  });

  it("maps trap references including the opium rage cluster", () => {
    expect(parseIntentText("future type beat").input.style).toBe("rolling");
    expect(parseIntentText("gunna type beat").input.mood).toBe("chill");
    const ken = parseIntentText("ken carson type beat");
    expect(ken.input.genre).toBe("trap");
    expect(ken.input.mood).toBe("aggressive");
    expect(ken.input.bpmRange).toEqual([150, 165]);
    expect(parseIntentText("zaytoven type beat").input.style).toBe("classic");
    expect(parseIntentText("chief keef type beat").input.genre).toBe("drill");
  });

  it("maps phonk, dnb, ambient and house references", () => {
    const kordhell = parseIntentText("kordhell type beat");
    expect(kordhell.input.genre).toBe("phonk");
    expect(kordhell.input.style).toBe("drift");
    expect(kordhell.input.bpmRange).toEqual([150, 165]);
    expect(parseIntentText("dj smokey type beat").input.style).toBe("memphis");
    expect(parseIntentText("sub focus type beat").input.genre).toBe("dnb");
    expect(parseIntentText("hedex type beat").input.style).toBe("jumpup");
    const eno = parseIntentText("brian eno type beat");
    expect(eno.input.genre).toBe("ambient");
    expect(eno.input.bpmRange).toEqual([60, 80]);
    expect(parseIntentText("aphex twin type beat").input.style).toBe("glitch");
    expect(parseIntentText("keinemusik type beat").input.style).toBe("afro");
    expect(parseIntentText("dom dolla type beat").input.bpmRange).toEqual([124, 127]);
    expect(parseIntentText("trance type beat").input.genre).toBe("techno");
  });

  it("explicit words still override the expanded presets", () => {
    const bright = parseIntentText("charlotte de witte type beat chill");
    expect(bright.input.mood).toBe("chill");
    expect(bright.input.genre).toBe("techno");
  });
});
