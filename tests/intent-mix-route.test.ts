import { describe, it, expect } from "vitest";
import { testDoc, deterministicTestDoc } from "./fixtures/doc";
import { planMixProfile, applyMixIntent } from "../src/intent/mix";
import { isMixIntentText, parseMixIntent, routeIntentText } from "../src/intent/route";
import { normalizeIntent } from "../src/intent/normalize";
import { createScene } from "../src/commands/commands";
import type { ProjectDocument } from "../src/project-model/types";

const DARK_TECHNO = normalizeIntent({ genre: "techno", mood: "dark", energy: 0.8, seed: "mix" });

describe("mix profile planner (D1)", () => {
  it("is deterministic", () => {
    expect(planMixProfile(DARK_TECHNO)).toEqual(planMixProfile(DARK_TECHNO));
  });

  it("dark techno: tone tilt + punch + dry space + pump", () => {
    const profile = planMixProfile(DARK_TECHNO);
    const summary = profile.summary.join(" | ");
    expect(summary).toContain("tone: dark");
    expect(summary).toContain("punch");
    expect(summary).toContain("pump");
    // techno is a dry genre — reverb decisions REDUCE space
    expect(profile.summary.join(" ")).toContain("drier");
    // bass tone tilt is deeper than the generic dark tilt
    const bassEq = profile.decisions.find((d) => d.target === "bass" && d.effectType === "eq");
    expect(bassEq?.params.lowShelfGain).toBe(3);
  });

  it("ambient chill gets lush space and no pump", () => {
    const profile = planMixProfile(normalizeIntent({ genre: "ambient", mood: "chill", energy: 0.3 }));
    const reverb = profile.decisions.find((d) => d.effectType === "reverb");
    expect(reverb?.params.mix).toBeGreaterThanOrEqual(0.4);
    expect(reverb?.params.decay).toBeGreaterThanOrEqual(2.8);
    expect(profile.decisions.some((d) => d.effectType === "pump")).toBe(false);
  });

  it("is conservative: a neutral intent without overrides touches nothing", () => {
    const profile = planMixProfile(normalizeIntent({ genre: "house", seed: "x" }));
    expect(profile.decisions.filter((d) => d.effectType === "eq")).toEqual([]);
  });

  it("overrides steer the profile (huge reverb, pump off)", () => {
    const profile = planMixProfile(normalizeIntent({ genre: "house", seed: "x" }), {
      reverb: "huge",
      pump: "off",
      punch: "more",
    });
    const reverb = profile.decisions.find((d) => d.effectType === "reverb");
    expect(reverb?.params.mix).toBeGreaterThan(0.4);
    expect(reverb?.params.decay).toBeGreaterThan(2.5);
    expect(profile.decisions.some((d) => d.effectType === "pump")).toBe(false);
    expect(profile.decisions.some((d) => d.effectType === "compressor")).toBe(true);
  });
});

describe("applyMixIntent (D1)", () => {
  it("adds effects, clamps params and wires sidechain as ONE undo step", () => {
    const doc = deterministicTestDoc();
    const profile = planMixProfile(DARK_TECHNO);
    const command = applyMixIntent(doc, profile);
    const next = command.execute(doc);

    const drumTrack = next.tracks.find((t) => t.kind === "drum")!;
    const drums = drumTrack.effects;
    expect(drums.some((fx) => fx.type === "compressor")).toBe(true);
    expect(drums.some((fx) => fx.type === "saturation")).toBe(true);

    // instrument tracks: eq on every role-resolved track + pump sidechained to drums
    const instruments = next.tracks.filter((t) => t.kind === "instrument");
    expect(instruments.length).toBeGreaterThanOrEqual(2);
    let pumpCount = 0;
    for (const track of instruments) {
      const eq = track.effects.find((fx) => fx.type === "eq");
      expect(eq).toBeDefined();
      // dark tilt values are clamped/valid within the eq defs
      expect(eq!.params.lowShelfGain).toBeLessThanOrEqual(15);
      const pump = track.effects.find((fx) => fx.type === "pump");
      if (pump) {
        pumpCount += 1;
        expect(pump.sidechainTrackId).toBe(drumTrack.id);
        expect(pump.params.amount).toBeGreaterThan(0);
        expect(pump.params.amount).toBeLessThanOrEqual(1);
      }
    }
    expect(pumpCount).toBeGreaterThanOrEqual(1);
    // drum tracks never get the pump
    expect(drums.some((fx) => fx.type === "pump")).toBe(false);

    // ONE undo restores the pristine doc
    const undone = command.undo(next);
    expect(undone.tracks.every((t) => t.effects.length === 0)).toBe(true);
  }, 30_000);

  it("is idempotent — applying twice throws 'changed nothing'", () => {
    const doc = testDoc();
    const profile = planMixProfile(DARK_TECHNO);
    const once = applyMixIntent(doc, profile).execute(doc);
    expect(() => applyMixIntent(once, profile)).toThrow(/changed nothing/);
  });
});

describe("mix intent parser (D1)", () => {
  it("detects EN mix words", () => {
    expect(isMixIntentText("make it punchier")).toBe(true);
    const parsed = parseMixIntent("more reverb, punchier drums");
    expect(parsed.overrides.reverb).toBe("more");
    expect(parsed.overrides.punch).toBe("more");
  });

  it("detects SK mix words", () => {
    expect(isMixIntentText("daj viac dozvuku a nechaj to suché")).toBe(true);
    const parsed = parseMixIntent("viac dozvuku, bez pumpy");
    expect(parsed.overrides.reverb).toBe("more");
    expect(parsed.overrides.pump).toBe("off");
    expect(parseMixIntent("tmavší zvuk").overrides.tone).toBe("dark");
  });

  it("comparatives route to mix, plain adjectives do not", () => {
    expect(isMixIntentText("darker")).toBe(true);
    expect(isMixIntentText("dark techno")).toBe(false);
    expect(isMixIntentText("warm")).toBe(false);
  });
});

describe("unified router (D3)", () => {
  const docWithScenes = (): ProjectDocument => {
    let doc = testDoc();
    doc = createScene(doc, "Intro").execute(doc);
    doc = createScene(doc, "Drop A").execute(doc);
    return doc;
  };

  it("routes arrange text (doc has scenes) to the arrange executor", () => {
    const route = routeIntentText("shorten the intro to 4 bars", docWithScenes());
    expect(route.kind).toBe("arrange");
    if (route.kind === "arrange") {
      expect(route.ops.length).toBeGreaterThan(0);
    }
  });

  it("routes mix vocabulary to the mix executor", () => {
    const route = routeIntentText("more reverb please", docWithScenes());
    expect(route.kind).toBe("mix");
  });

  it("routes everything else to pattern generation", () => {
    const route = routeIntentText("dark rolling techno at 140", docWithScenes());
    expect(route.kind).toBe("pattern");
    if (route.kind === "pattern") {
      expect(route.input.genre).toBe("techno");
      expect(route.input.bpmRange).toEqual([140, 140]);
    }
    // even with NO scenes, pattern still wins over nothing
    expect(routeIntentText("trap beat", testDoc()).kind).toBe("pattern");
  });

  it("pattern text that merely contains scene roles does not hijack arrangement", () => {
    // "intro" as a section word alone doesn't parse into arrange ops
    const route = routeIntentText("ambient intro at 90", docWithScenes());
    expect(route.kind).toBe("pattern");
  });

  it("production concept + explicit target beats the mix profile (GOAL 03 regression)", () => {
    // "make the drums darker" used to fall to the MIX branch (global master
    // tilt) because the comparative fired before anything read "drums" — the
    // user's target was silently broadened to the whole mix.
    const route = routeIntentText("make the drums darker", docWithScenes());
    expect(route.kind).toBe("production");
    if (route.kind === "production") {
      expect(route.intent.targets).toContain("drums");
      expect(route.intent.goals.map((g) => g.concept)).toContain("darker");
    }
    expect(routeIntentText("make the bass deeper", docWithScenes()).kind).toBe("production");
    expect(routeIntentText("warmer 808 please", docWithScenes()).kind).toBe("production");
  });

  it("tone comparatives WITHOUT a target still route to the mix profile", () => {
    expect(routeIntentText("darker", docWithScenes()).kind).toBe("mix");
    expect(routeIntentText("make the mix warmer", docWithScenes()).kind).toBe("mix");
  });

  it("genre signal flips production words back into generation-time FX", () => {
    // "wobbly drill" generates WITH the mangler — it must not re-tune the
    // existing drums track (same rule as the GENERATE path).
    const route = routeIntentText("wobbly drill", docWithScenes());
    expect(route.kind).toBe("pattern");
  });

  it("targeted effect intents still outrank production concepts", () => {
    // an effect NOUN × target is more specific than a concept adjective
    expect(routeIntentText("remove reverb from the bass", docWithScenes()).kind).toBe("effectIntent");
  });
});
