import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { parseProductionIntent, planProductionActions, resolveProductionTargets } from "../src/intent/production";
import { applyProductionIntentCommand } from "../src/commands/commands";
import type { ProjectDocument, InstrumentTrack } from "../src/project-model/types";

/**
 * Production Intent layer (master doc §4.3 + §19 + §21 Phase 1-2):
 * "make the bass deeper" compiles into deterministic effect operations on the
 * bass track — ONE undoable command group, params clamped to effect metadata,
 * generation intents ("dark techno") untouched.
 */

const doc = () => createProjectFromTemplate("house");

const bassTrackOf = (d: ProjectDocument): InstrumentTrack =>
  d.tracks.find(
    (t): t is InstrumentTrack =>
      t.kind === "instrument" &&
      (["bass", "808", "logdrum"].includes(t.instrument) || /\b(bass|808|sub)\b/i.test(t.name)),
  )!;

describe("parseProductionIntent", () => {
  it("parses 'make the bass deeper' → target bass, goal deeper", () => {
    const intent = parseProductionIntent("make the bass deeper");
    expect(intent).not.toBeNull();
    expect(intent!.targets).toContain("bass");
    expect(intent!.goals).toEqual([{ concept: "deeper", amount: 0.7 }]);
  });

  it("amount modifiers: 'much punchier drums' → 0.9, 'slightly darker' → 0.45", () => {
    const much = parseProductionIntent("make the drums much punchier");
    expect(much!.goals[0]).toEqual({ concept: "punchier", amount: 0.9 });
    expect(much!.targets).toContain("drums");
    const slight = parseProductionIntent("slightly darker");
    expect(slight!.goals[0]).toEqual({ concept: "darker", amount: 0.45 });
  });

  it("multi-goal: 'make the bass warmer and drums punchier'", () => {
    const intent = parseProductionIntent("make the bass warmer and drums punchier");
    expect(intent!.targets.sort()).toEqual(["bass", "drums"]);
    const concepts = intent!.goals.map((g) => g.concept).sort();
    expect(concepts).toEqual(["punchier", "warmer"]);
  });

  it("SK detection: 'hlbšiu a teplejšiu basu' (comparative accusatives)", () => {
    const intent = parseProductionIntent("urob hlbšiu a teplejšiu basu");
    expect(intent).not.toBeNull();
    expect(intent!.targets).toContain("bass");
    const concepts = intent!.goals.map((g) => g.concept).sort();
    expect(concepts).toContain("deeper");
    expect(concepts).toContain("warmer");
  });

  it("generation intents stay null — 'dark techno at 140'", () => {
    expect(parseProductionIntent("dark rolling techno at 140")).toBeNull();
    expect(parseProductionIntent("deep house with organic hats")).toBeNull();
  });

  it("FX-expansion vocabulary: wobbly / robotic / metallic route to the new effects", () => {
    const wobbly = parseProductionIntent("make the drums wobbly")!;
    expect(wobbly.goals[0].concept).toBe("wobbly");
    expect(wobbly.targets).toContain("drums");

    const robotic = parseProductionIntent("make the lead robotic")!;
    expect(robotic.goals[0].concept).toBe("robotic");
    expect(robotic.targets).toContain("lead");

    const metallic = parseProductionIntent("metallic hats")!;
    expect(metallic.goals[0].concept).toBe("metallic");

    const sk = parseProductionIntent("houpavý zvuk")!;
    expect(sk.goals[0].concept).toBe("wobbly");
  });
});

describe("planner", () => {
  it("resolves the bass target to the bass instrument track", () => {
    const d = doc();
    const ids = resolveProductionTargets(d, ["bass"]);
    expect(ids).toHaveLength(1);
    const track = d.tracks.find((t) => t.id === ids[0])! as InstrumentTrack;
    expect(track.kind).toBe("instrument");
  });

  it("throws clearly when the target has no track", () => {
    const d = createProjectFromTemplate("empty");
    expect(() => planProductionActions(d, parseProductionIntent("make the bass deeper")!)).toThrow(/No matching track/);
  });

  it("deeper → pitchShift with amount-scaled semitones, clamped to metadata", async () => {
    const d = doc();
    const { actions } = planProductionActions(d, parseProductionIntent("make the bass deeper")!);
    const shift = actions.find((a) => a.type === "pitchShift")!;
    expect(shift).toBeDefined();
    const registry = await import("../src/effects/registry");
    const def = registry.EFFECT_DEFS.pitchShift.params.find((pd) => pd.id === "semitones")!;
    expect(shift.params.semitones).toBeLessThan(0);
    expect(shift.params.semitones).toBeGreaterThanOrEqual(def.min);
    expect(shift.params.semitones).toBeLessThanOrEqual(def.max);
  });

  it("planning is deterministic", () => {
    const d = doc();
    const intent = parseProductionIntent("make the drums punchier and wider")!;
    const a = planProductionActions(d, intent);
    const b = planProductionActions(d, intent);
    expect(a.actions).toEqual(b.actions);
    expect(a.plan.label).toBe(b.plan.label);
  });
});

describe("applyProductionIntentCommand", () => {
  beforeEach(() => {
    localStorage.removeItem("pf:intent-ranker");
  });
  afterEach(() => {
    localStorage.removeItem("pf:intent-ranker");
  });

  it("adds the planned effect to the target track in ONE undo step", () => {
    const d = doc();
    const intent = parseProductionIntent("make the bass deeper")!;
    const next = applyProductionIntentCommand(d, intent).execute(d);
    const bass = bassTrackOf(next);
    const added = bass.effects.filter((fx) => fx.type === "pitchShift");
    expect(added).toHaveLength(1);
    expect(added[0].params.semitones).toBeLessThan(0);
    // No other track gained effects.
    const others = next.tracks.filter((t) => t.id !== bass.id);
    for (const t of others) {
      if (t.kind !== "drum" && t.kind !== "group" && "effects" in t) {
        expect((t as InstrumentTrack).effects.filter((fx) => fx.type === "pitchShift")).toHaveLength(0);
      }
    }
  });

  it("second apply adjusts the SAME instance instead of duplicating", () => {
    const d = doc();
    const intent = parseProductionIntent("make the bass deeper")!;
    const once = applyProductionIntentCommand(d, intent).execute(d);
    const twice = applyProductionIntentCommand(once, intent).execute(once);
    const bass = bassTrackOf(twice);
    expect(bass.effects.filter((fx) => fx.type === "pitchShift")).toHaveLength(1);
  });

  it("undo restores the exact previous chain", () => {
    const d = doc();
    const intent = parseProductionIntent("make the bass warmer")!;
    const cmd = applyProductionIntentCommand(d, intent);
    const after = cmd.execute(d);
    const restored = cmd.undo(after);
    const bassBefore = bassTrackOf(d).effects.map((fx) => fx.type);
    const bassAfter = bassTrackOf(restored).effects.map((fx) => fx.type);
    expect(bassAfter).toEqual(bassBefore);
  });

  it("different concepts coexist on one track (deeper + warmer = 2 effects)", () => {
    const d = doc();
    const deeper = parseProductionIntent("make the bass deeper")!;
    const warmer = parseProductionIntent("make the bass warmer")!;
    let next = applyProductionIntentCommand(d, deeper).execute(d);
    next = applyProductionIntentCommand(next, warmer).execute(next);
    const bass = bassTrackOf(next);
    const types = bass.effects.map((fx) => fx.type);
    expect(types).toContain("pitchShift");
    expect(types).toContain("tapeSat");
  });

  it("wobbly plants beatMangler with a 16-step envelope on the drums track", () => {
    const d = doc();
    const next = applyProductionIntentCommand(d, parseProductionIntent("make the drums wobbly")!).execute(d);
    const drumTrack = next.tracks.find((t) => t.kind === "drum");
    const fx = drumTrack && "effects" in drumTrack ? drumTrack.effects.find((f) => f.type === "beatMangler") : undefined;
    expect(fx).toBeDefined();
    expect(fx!.volumeSteps).toHaveLength(16);
    expect(fx!.pitchSteps).toHaveLength(16);
    expect(fx!.pitchSteps!.some((s) => s !== 0)).toBe(true);
  });

  it("robotic adds ringMod on the named track, metallic adds freqShifter on the drums", () => {
    const d = doc();
    // House template has no lead — name the 808 directly (robotic's default
    // home is lead, but the named target wins).
    let next = applyProductionIntentCommand(d, parseProductionIntent("make the 808 robotic")!).execute(d);
    next = applyProductionIntentCommand(next, parseProductionIntent("metallic drums")!).execute(next);
    const bass = bassTrackOf(next);
    const drums = next.tracks.find((t) => t.kind === "drum");
    expect(bass.effects.some((f) => f.type === "ringMod")).toBe(true);
    expect(drums && "effects" in drums ? drums.effects.some((f) => f.type === "freqShifter") : false).toBe(true);
  });
});
