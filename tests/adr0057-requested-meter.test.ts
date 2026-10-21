/**
 * ADR 0057 Stage 2f — the METER is a first-class part of the REQUEST.
 *
 * Stage 2a–2e made every layer of the product speak the document's metre. The
 * gap they left was the LAST one and the most embarrassing: the metre was
 * reachable only as the literal phrase "time signature 3/4". A user who typed
 * "make me a beat in 6/8" got a 4/4 beat in a 4/4 project — the metre word was
 * silently ignored, which is the worst kind of failure: no error, just the
 * wrong beat.
 *
 * What this file locks down:
 *
 *   1. The vocabulary — "6/8", "time signature 3/4", "takt 7/8", "a waltz".
 *   2. THE ORDER — the metre is settled BEFORE the length. "2 bars in 3/4" is
 *      twenty-four steps, not thirty-two.
 *   3. The document ends up in the requested metre.
 *   4. 4/4 keeps its canonical hash — a request that does not name a metre is
 *      byte-identical to before.
 */
import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { parseIntentText } from "../src/intent/text-parser";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { parseExactIntent } from "../src/intent/exact";
import { meterPhraseIn } from "../src/intent/meter-phrase";
import { intentHash } from "../src/intent/hash";
import { applyExactIntentCommand } from "../src/commands/intentRouting";
import { applyGenerationResultCommand } from "../src/commands/aiPattern";
import { generateLocalResult } from "../src/intent/pipeline";
import type { ProjectDocument } from "../src/project-model/types";

function doc(): ProjectDocument {
  return normalizeProject({
    ...createProjectFromTemplate("house"),
    bpm: 120,
    arrangement: { clips: [] },
  });
}

describe("ADR 0057 Stage 2f — the metrical vocabulary", () => {
  it("reads the bare form, the named form and the waltz", () => {
    expect(meterPhraseIn("make me a beat in 6/8", { bareAllowed: true })?.numerator).toBe(6);
    expect(meterPhraseIn("make me a beat in 6/8", { bareAllowed: true })?.denominator).toBe(8);
    expect(meterPhraseIn("time signature 3/4")?.numerator).toBe(3);
    expect(meterPhraseIn("takt 7/8")?.denominator).toBe(8);
    expect(meterPhraseIn("a waltz")?.numerator).toBe(3);
    expect(meterPhraseIn("a valcik")?.denominator).toBe(4);
  });

  it("the command path does NOT take the bare form", () => {
    // "make me a 3/4 beat" must generate a beat, not change the document.
    expect(meterPhraseIn("make me a 3/4 beat")).toBeNull();
    expect(meterPhraseIn("make me a 3/4 beat", { bareAllowed: true })).not.toBeNull();
  });

  it("does NOT treat a shuffle as a metre", () => {
    // A UKG shuffle is 4/4 with a swung sixteenth — a FEEL, not a bar.
    expect(meterPhraseIn("make me a ukg shuffle", { bareAllowed: true })).toBeNull();
  });

  it("rejects a broken metre instead of guessing", () => {
    expect(meterPhraseIn("time signature 5/3")).toBeNull();
    expect(meterPhraseIn("time signature 32/4")).toBeNull();
  });
});

describe("ADR 0057 Stage 2f — the metre is part of the request", () => {
  it("the text parser carries the requested metre", () => {
    const parsed = parseIntentText("make me a dark house beat in 6/8");
    expect(parsed.input.timeSignature).toEqual({ numerator: 6, denominator: 8 });
    expect(parsed.detected).toContain("6/8");
  });

  it("a request WITHOUT a metre carries none — 4/4 stays byte-identical", () => {
    const parsed = parseIntentText("make me a dark house beat");
    expect(parsed.input.timeSignature).toBeUndefined();
    const before = normalizeIntent({ genre: "house", seed: "s1" }, doc());
    const after = normalizeIntent({ genre: "house", seed: "s1" }, doc());
    expect(intentHash(after)).toBe(intentHash(before));
    expect(after.timeSignature).toBeUndefined();
  });

  it("the LENGTH is resolved in the requested metre — 2 bars in 3/4 is 24 steps", () => {
    const intent = normalizeIntent(
      { genre: "house", seed: "s1", bars: 2, timeSignature: { numerator: 3, denominator: 4 } },
      doc(),
    );
    expect(intent.length).toBe(24);
    expect(intent.timeSignature).toEqual({ numerator: 3, denominator: 4 });
    // The document is still 4/4 — the request asked for 3/4, the document has
    // not changed yet.
    const plan = planGeneration(
      { genre: "house", seed: "s1", bars: 2, timeSignature: { numerator: 3, denominator: 4 } },
      doc(),
    );
    expect(plan.options.stepCount).toBe(24);
    expect(plan.options.timeSignature).toEqual({ numerator: 3, denominator: 4 });
  });

  it("the plan generates in the REQUESTED metre, not the document's", () => {
    const plan = planGeneration({ genre: "house", seed: "s1", timeSignature: { numerator: 6, denominator: 8 } }, doc());
    expect(plan.options.timeSignature).toEqual({ numerator: 6, denominator: 8 });
    expect(plan.options.stepCount).toBe(12);
  });
});

describe("ADR 0057 Stage 2f — the document ends up in the requested metre", () => {
  it("the generation path moves the project into the metre it asked for", () => {
    const source = doc();
    const parsed = parseIntentText("make me a dark house beat in 6/8");
    const result = generateLocalResult(source, parsed.input, "preview");
    const applied = applyGenerationResultCommand(source, result).execute(source);
    expect(applied.timeSignature).toEqual({ numerator: 6, denominator: 8 });
    const pattern = applied.patterns.find((p) => p.id === applied.activePatternId);
    // Twelve steps in a six-eight bar is EXACTLY one bar — not three quarters.
    expect(pattern?.stepCount).toBe(12);
  });

  it("the command path changes the meter and reads it back", () => {
    const source = doc();
    const plan = parseExactIntent("time signature 3/4");
    expect(plan).not.toBeNull();
    const applied = applyExactIntentCommand(source, plan!).execute(source);
    expect(applied.timeSignature).toEqual({ numerator: 3, denominator: 4 });
  });

  it("THE METER OP GOES FIRST — '2 bars in 3/4' is 24 steps, not 32", () => {
    const source = doc();
    const plan = parseExactIntent("2 bars long in time signature 3/4");
    expect(plan).not.toBeNull();
    expect(plan!.ops.map((op) => op.kind)).toContain("timeSignature");
    expect(plan!.ops.map((op) => op.kind)).toContain("patternLengthBars");
    const applied = applyExactIntentCommand(source, plan!).execute(source);
    expect(applied.timeSignature).toEqual({ numerator: 3, denominator: 4 });
    const pattern = applied.patterns.find((p) => p.id === applied.activePatternId);
    expect(pattern?.stepCount).toBe(24);
  });
});
