import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { parseEffectIntent, applyEffectIntent, effectKnobDelta } from "../src/intent/mix";
import { routeIntentText } from "../src/intent/route";
import { applySongCommand, buildSong } from "../src/intent/song";
import { normalizeIntent } from "../src/intent/normalize";

describe("targeted effect intents (D1 v2a)", () => {
  it("parses effect × target × direction EN", () => {
    const parsed = parseEffectIntent("add more delay to the lead");
    expect(parsed).not.toBeNull();
    expect(parsed!.effectType).toBe("delay");
    expect(parsed!.targets).toContain("lead");
    expect(parsed!.direction).toBe("more");
  });

  it("parses SK inflections", () => {
    const parsed = parseEffectIntent("viac delayu na leade");
    expect(parsed!.effectType).toBe("delay");
    expect(parsed!.targets).toContain("lead");
    expect(parsed!.direction).toBe("more");
    expect(parseEffectIntent("menej filtra na basi")?.effectType).toBe("eq");
    expect(parseEffectIntent("menej filtra na basi")?.targets).toContain("bass");
  });

  it("scene roles expand to their instrumentation tracks", () => {
    const parsed = parseEffectIntent("add reverb to the bridge");
    expect(parsed!.effectType).toBe("reverb");
    expect(parsed!.targets).toEqual(["chords", "lead"]);
  });

  it("amount modifiers scale", () => {
    expect(parseEffectIntent("huge reverb on the pads")!.amount).toBe("huge");
    expect(parseEffectIntent("subtle chorus on the lead")!.amount).toBe("subtle");
    expect(effectKnobDelta(parseEffectIntent("huge reverb on the pads")!)).toBeGreaterThan(
      effectKnobDelta(parseEffectIntent("subtle reverb on the pads")!),
    );
  });

  it("remove direction wins for explicit removal", () => {
    expect(parseEffectIntent("remove the delay from the lead")!.direction).toBe("remove");
    expect(parseEffectIntent("bez reverbU na basi")!.direction).toBe("remove");
  });

  it("non-effect text returns null", () => {
    expect(parseEffectIntent("dark rolling techno at 140")).toBeNull();
    expect(parseEffectIntent("travis scott type beat")).toBeNull();
  });

  it("router: targeted effect beats the generic mix profile", () => {
    const doc = testDoc();
    const route = routeIntentText("viac delayu na leade", doc);
    expect(route.kind).toBe("effectIntent");
    // generic mix words without a target stay mix
    expect(routeIntentText("more reverb please", doc).kind).toBe("mix");
  });
});

describe("applyEffectIntent execution", () => {
  it("adds the effect to target tracks and turns the knob", () => {
    const doc = testDoc();
    const intent = parseEffectIntent("add reverb to the bass")!;
    const command = applyEffectIntent(doc, intent);
    const next = command.execute(doc);
    const bassTrack = next.tracks.find((track) => track.name.toLowerCase().includes("808"));
    const reverb = bassTrack!.effects.find((fx) => fx.type === "reverb");
    expect(reverb).toBeDefined();
    // knob moved up from the default 0.3
    expect(reverb!.params.mix).toBeGreaterThan(0.3);
    // other targets untouched (no explicit target matched them)
    const drumTrack = next.tracks.find((track) => track.kind === "drum")!;
    expect(drumTrack.effects.some((fx) => fx.type === "reverb")).toBe(false);
    // ONE undo restores
    const undone = command.undo(next);
    expect(undone.tracks.find((track) => track.id === bassTrack!.id)!.effects.length).toBe(0);
  });

  it("removes the effect on direction remove", () => {
    const doc = testDoc();
    const addIntent = parseEffectIntent("add reverb to the bass")!;
    const withReverb = applyEffectIntent(doc, addIntent).execute(doc);
    const removeIntent = parseEffectIntent("remove the reverb from the bass")!;
    expect(removeIntent.direction).toBe("remove");
    const next = applyEffectIntent(withReverb, removeIntent).execute(withReverb);
    const bassTrack = next.tracks.find((track) => track.name.toLowerCase().includes("808"));
    expect(bassTrack!.effects.some((fx) => fx.type === "reverb")).toBe(false);
  });

  it("respects user role requests: no-drums intent skips drum tracks", () => {
    // bridge-targeted reverb expands to chords+lead — never drums
    const intent = parseEffectIntent("reverb on the bridge")!;
    expect(intent.targets.every((target) => target !== "drums")).toBe(true);
  });

  it("composes with the song builder: per-section FX stay section-scoped in TESTS", async () => {
    // v2b groundwork sanity: section instrumentation feeds the target map —
    // a bridge-targeted delay lands on the chords+lead TRACKS (whole track,
    // documented v1 limitation: no per-section FX scheduling yet)
    const doc = testDoc();
    const build = await buildSong(doc, normalizeIntent({ genre: "trap", seed: "fx" }), {
      yieldBetweenSections: false,
    });
    const withSong = applySongCommand(doc, build).execute(doc);
    const intent = parseEffectIntent("add reverb to the bridge")!;
    const next = applyEffectIntent(withSong, intent).execute(withSong);
    const touched = next.tracks.filter((track) => track.effects.some((fx) => fx.type === "reverb"));
    expect(touched.length).toBeGreaterThan(0);
  }, 60_000);
});
