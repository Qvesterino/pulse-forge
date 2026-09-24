import { describe, it, expect, beforeEach } from "vitest";
import { analyzeVoiceIdea } from "../src/intent/voice-idea";
import {
  bumpGenerationCount,
  hasProducerSession,
  planVariantIntents,
  producerSessionState,
  producerSessionSummary,
  recordDecision,
  recordIntentDecisions,
  resetProducerSession,
  resolveProducerFollowUp,
} from "../src/intent/producer-session";
import { normalizeIntent } from "../src/intent/normalize";

beforeEach(() => {
  resetProducerSession();
});

describe("producer session decisions", () => {
  it("records intent decisions into the session state", () => {
    const intent = normalizeIntent({
      genre: "techno",
      seed: "s",
      key: "E Natural Minor",
      energy: 0.8,
      bpmRange: [130, 134],
    });
    recordIntentDecisions(intent, "dark techno at 132");
    const state = producerSessionState();
    expect(state.decisions.genre?.value).toBe("techno");
    expect(state.decisions.bpm?.value).toBe("132");
    expect(state.decisions.key?.value).toBe("E Natural Minor");
    expect(state.generations).toBe(0);
  });

  it("summary is the HUD line; empty session = null", () => {
    expect(producerSessionSummary()).toBeNull();
    recordDecision("genre", "house", "test");
    recordDecision("bpm", "124", "test");
    expect(producerSessionSummary()).toContain("house");
    expect(producerSessionSummary()).toContain("124 BPM");
    expect(hasProducerSession()).toBe(true);
    resetProducerSession();
    expect(hasProducerSession()).toBe(false);
  });
});

describe("resolveProducerFollowUp", () => {
  const base = normalizeIntent({ genre: "techno", seed: "s", bpmRange: [130, 134], energy: 0.7 });

  it("ten istý → reroll with no patch", () => {
    const result = resolveProducerFollowUp("ten istý ešte raz", { ...base });
    expect(result).not.toBeNull();
    expect(result?.reroll).toBe(true);
    expect(Object.keys(result?.patch ?? {}).length === 0 || result?.patch.mood === undefined).toBe(true);
  });

  it("len pomalšie shifts the decided bpmRange down a step", () => {
    const result = resolveProducerFollowUp("ten istý, len pomalšie", { ...base });
    expect(result?.reroll).toBe(false);
    expect(result?.patch.bpmRange?.[1]).toBe((base.bpmRange as [number, number])[1] - 6);
  });

  it("ale tvrdší nudges energy up + aggressive mood", () => {
    const result = resolveProducerFollowUp("ten istý ale tvrdší", { ...base });
    expect(result?.patch.energy).toBeCloseTo(0.85, 2);
    expect(result?.patch.mood).toBe("aggressive");
  });

  it("no session phrase → null (the text parser owns it)", () => {
    expect(resolveProducerFollowUp("dark techno at 138", { ...base })).toBeNull();
  });
});

describe("planVariantIntents", () => {
  it("B darker / C energetic off the current energy", () => {
    const intent = normalizeIntent({ genre: "house", seed: "s", energy: 0.7, density: 0.5 });
    const variants = planVariantIntents(intent);
    expect(variants).toHaveLength(2);
    expect(variants[0].patch.mood).toBe("dark");
    expect(variants[0].patch.energy).toBeLessThan(0.7);
    expect(variants[1].patch.mood).toBe("energetic");
    expect(variants[1].patch.energy).toBeGreaterThan(0.7);
  });

  it("clamps energy into the valid range", () => {
    const quiet = planVariantIntents(normalizeIntent({ genre: "ambient", seed: "s", energy: 0.2 }));
    expect(quiet[0].patch.energy).toBeGreaterThanOrEqual(0.15);
    const loud = planVariantIntents(normalizeIntent({ genre: "trap", seed: "s", energy: 0.95 }));
    expect(loud[1].patch.energy).toBeLessThanOrEqual(0.95);
  });
});

describe("voice idea + session", () => {
  it("analyzeVoiceIdea still works with the session present", async () => {
    recordDecision("genre", "house", "test");
    bumpGenerationCount();
    resetProducerSession();
    const result = await analyzeVoiceIdea(new Float32Array(16000 * 3), 16000, {
      bpm: 124,
      track: async () => [{ timeSec: 0.1, midi: 60, clarity: 0.9, rms: 0.2 }],
    });
    expect(result?.patch.bpmRange).toEqual([122, 126]);
  });
});
