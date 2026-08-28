import { describe, expect, it } from "vitest";
import { generatePattern } from "../src/ai/generator";
import { canonicalizePattern, contentHash } from "../src/ai/evaluation";
import { inspectPatternInvariants } from "../src/ai/invariants";
import { generateLocalResult } from "../src/intent/pipeline";
import { normalizeIntent } from "../src/intent/normalize";
import { createDefaultProject } from "../src/project-model/schema";
import { AI_BASELINE_CASES, BASELINE_STEP_COUNTS, baselineOptions } from "./fixtures/ai-baseline";

describe("Intent Engine quality gates", () => {
  it("accepts every frozen golden pattern through strict invariants", () => {
    for (const testCase of AI_BASELINE_CASES) {
      for (const stepCount of BASELINE_STEP_COUNTS) {
        const doc = createDefaultProject();
        const pattern = generatePattern(doc, baselineOptions(testCase, stepCount));
        const report = inspectPatternInvariants(doc, pattern);
        expect(
          report.issues,
          `${testCase.id}/${stepCount}: ${report.issues.map((item) => item.message).join("; ")}`,
        ).toEqual([]);
        expect(pattern.generation?.outputContentHash).toBe(contentHash(canonicalizePattern(doc, pattern)));
      }
    }
  });

  it("holds deterministic content and shape invariants over a seed matrix", () => {
    const seeds = ["", "property-a", "property-b", "emoji-🎛️", "x".repeat(128)];
    for (const [caseIndex, testCase] of AI_BASELINE_CASES.entries()) {
      for (const [lengthIndex, stepCount] of BASELINE_STEP_COUNTS.entries()) {
        for (const seed of seeds) {
          const options = { ...baselineOptions(testCase, stepCount), seed: `${seed}-${caseIndex}-${lengthIndex}` };
          const firstDoc = createDefaultProject();
          const secondDoc = createDefaultProject();
          const first = generatePattern(firstDoc, options);
          const second = generatePattern(secondDoc, options);
          expect(contentHash(canonicalizePattern(firstDoc, first))).toBe(
            contentHash(canonicalizePattern(secondDoc, second)),
          );
          expect(inspectPatternInvariants(firstDoc, first).ok).toBe(true);
        }
      }
    }
  });

  it("keeps generated melodic notes inside an explicit project scale", () => {
    const doc = { ...createDefaultProject(), key: "C Major" as const };
    const pattern = generatePattern(doc, baselineOptions(AI_BASELINE_CASES[0], 64));
    const report = inspectPatternInvariants(doc, pattern, { checkScale: true });
    expect(report.issues.filter((item) => item.code === "note-scale")).toEqual([]);
  });

  it("detects broken rows, notes, metadata and hashes instead of repairing silently", () => {
    const doc = createDefaultProject();
    const source = generatePattern(doc, baselineOptions(AI_BASELINE_CASES[0], 16));
    const padId = Object.keys(source.rows)[0];
    const instrumentId = doc.tracks.find((track) => track.kind === "instrument")!.id;
    const broken = {
      ...source,
      rows: { ...source.rows, [padId]: source.rows[padId].slice(1) },
      notes: { ...source.notes, [instrumentId]: [{ id: "bad", pitch: 200, start: -1, duration: 99999, velocity: 2 }] },
      stepMeta: { ...(source.stepMeta ?? {}), [padId]: { ...(source.stepMeta?.[padId] ?? {}), 15: { ratchet: 99 } } },
    };
    const report = inspectPatternInvariants(doc, broken);
    expect(new Set(report.issues.map((item) => item.code))).toEqual(
      new Set([
        "row-length",
        "note-pitch",
        "note-start",
        "note-duration",
        "note-velocity",
        "metadata-inactive-hit",
        "metadata-value",
        "content-hash",
      ]),
    );
  });

  it("normalizes malformed intents and still produces an accepted offline fallback", () => {
    const intent = normalizeIntent({
      genre: "not-a-genre",
      energy: Number.NaN,
      length: 37,
      seed: "z".repeat(300),
      roles: ["drums", "not-a-role"],
      controls: { temperature: 999 },
    });
    expect(intent.length).toBe(32);
    expect(intent.seed).toHaveLength(128);
    expect(intent.controls.temperature).toBe(2);
    const result = generateLocalResult(createDefaultProject(), intent);
    expect(result.status).toBe("accepted");
    expect(result.proposal?.pattern).toBeDefined();
  });
});
