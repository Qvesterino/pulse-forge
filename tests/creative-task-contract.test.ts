import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { compileBriefContract } from "../src/intent/brief-contract";
import {
  createCreativeTaskRequestV1,
  MAX_CREATIVE_TASK_OUTPUT_LENGTH,
  MAX_CREATIVE_TASK_PROMPT_LENGTH,
  parseCreativeTaskOutputJson,
  resolveApprovedCreativeTaskOutput,
  validateCreativeTaskOutput,
} from "../src/intent/creative-task-contract";
import { evaluateCreativeTaskPredictions, type CreativeTaskGoldenCaseV1 } from "../src/intent/creative-task-evaluation";
import { parseIntentText } from "../src/intent/text-parser";

const CREATIVE_GOLDEN_PATH = path.join(process.cwd(), "scripts", "data", "creative-task-v1-golden.jsonl");
const ACTION_GOLDEN_PATH = path.join(process.cwd(), "scripts", "data", "intent-sft", "golden.jsonl");

function readCreativeGolden(): CreativeTaskGoldenCaseV1[] {
  return readFileSync(CREATIVE_GOLDEN_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CreativeTaskGoldenCaseV1);
}

describe("creative task contract v1", () => {
  it("locks a held-out SK/EN interpretation set separate from command-action goldens", () => {
    const golden = readCreativeGolden();
    const actionGoldens = readFileSync(ACTION_GOLDEN_PATH, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { instruction: string });
    const prompts = new Set<string>();
    const ids = new Set<string>();
    const languages = { en: 0, sk: 0 };
    const statuses = new Set<string>();
    for (const row of golden) {
      expect(row.version).toBe(1);
      expect(row.split).toBe("held-out");
      expect(row.id.length).toBeGreaterThan(0);
      expect(ids.has(row.id)).toBe(false);
      ids.add(row.id);
      expect(prompts.has(row.prompt.toLocaleLowerCase())).toBe(false);
      prompts.add(row.prompt.toLocaleLowerCase());
      languages[row.language] += 1;
      statuses.add(row.expected.status);
      expect(validateCreativeTaskOutput(row.expected)).toMatchObject({ ok: true });
      expect(
        actionGoldens.some((item) => item.instruction.toLocaleLowerCase() === row.prompt.toLocaleLowerCase()),
      ).toBe(false);
    }
    expect(golden.length).toBeGreaterThanOrEqual(20);
    expect(languages.en).toBeGreaterThanOrEqual(8);
    expect(languages.sk).toBeGreaterThanOrEqual(8);
    expect(statuses).toEqual(new Set(["proposal", "clarify", "abstain"]));
  });

  it("reports action-independent hard, preference, uncertainty and language metrics", () => {
    const golden = readCreativeGolden();
    const report = evaluateCreativeTaskPredictions(
      golden,
      golden.map(({ id, expected }) => ({ id, output: expected })),
    );

    expect(report).toMatchObject({
      evaluatorVersion: 1,
      cases: golden.length,
      validPredictions: golden.length,
      invalidPredictions: 0,
      missingPredictions: 0,
      unexpectedPredictions: 0,
      duplicatePredictionIds: 0,
      decisionAccuracy: 1,
      hardFieldExactRate: 1,
      protectionFieldExactRate: 1,
      preferenceFieldExactRate: 1,
      roleSafetyFailures: 0,
      byLanguage: {
        en: { decisionAccuracy: 1, hardFieldExactRate: 1 },
        sk: { decisionAccuracy: 1, hardFieldExactRate: 1 },
      },
    });
    expect(report.criticalUnknownFields.f1).toBe(1);
    expect(report.taskBoundary).toContain("not musical-quality evaluation");
  });

  it("keeps preserve/avoid compliance visible as its own safety metric", () => {
    const golden = readCreativeGolden();
    const protectedCase = golden.find((entry) => entry.expected.suggestions.preserveRoles?.length);
    expect(protectedCase).toBeDefined();
    if (!protectedCase) return;
    const predictions = golden.map(({ id, expected }) => ({
      id,
      output:
        id === protectedCase.id
          ? {
              ...expected,
              suggestions: Object.fromEntries(
                Object.entries(expected.suggestions).filter(([field]) => field !== "preserveRoles"),
              ),
            }
          : expected,
    }));
    const report = evaluateCreativeTaskPredictions(golden, predictions);
    expect(report.protectionFieldExactRate).toBeLessThan(1);
    expect(report.protectionFields.falseNegative).toBe(1);
    expect(report.preferenceFieldExactRate).toBe(1);
  });

  it("counts missing, invalid, duplicate and unexpected predictions instead of hiding them", () => {
    const [first, second, third, fourth] = readCreativeGolden();
    expect(first && second && third && fourth).toBeDefined();
    if (!first || !second || !third || !fourth) return;
    const report = evaluateCreativeTaskPredictions(
      [first, second, third, fourth],
      [
        { id: first.id, output: first.expected },
        { id: second.id, output: { version: 99 } },
        { id: second.id, output: second.expected },
        { id: third.id, output: { version: 99 } },
        { id: "not-in-golden", output: first.expected },
      ],
    );
    expect(report).toMatchObject({
      cases: 4,
      predictions: 5,
      missingPredictions: 1,
      unexpectedPredictions: 1,
      duplicatePredictionIds: 1,
      validPredictions: 1,
      invalidPredictions: 1,
      decisionAccuracy: 0.25,
    });
  });

  it("builds a compact, structured request without leaking project or track IDs", () => {
    const project = createProjectFromTemplate("house");
    const parsed = parseIntentText("dark trap at 142 bpm in C minor, 8 bars, leave my bass, no chords");
    const contract = compileBriefContract(parsed, { project, defaultRoles: ["drums", "bass"] });
    const result = createCreativeTaskRequestV1({
      operation: "generate",
      prompt: "dark trap at 142 bpm in C minor, 8 bars, leave my bass, no chords",
      intent: { ...parsed.input, roles: ["drums", "bass", "lead"], preserve: ["bass"] },
      contract,
      project,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { request } = result;
    expect(request.version).toBe(1);
    expect(request.requirements).toMatchObject({
      bpmRange: [142, 142],
      key: "C Natural Minor",
      lengthSteps: 128,
      targetRoles: ["drums", "lead"],
    });
    expect(request.preserveRoles).toContain("bass");
    expect(request.prohibitedRoles).toContain("chords");
    expect(request.projectContext).toMatchObject({
      tempo: project.bpm,
      hasActivePattern: true,
      availableRoles: expect.arrayContaining(["drums", "bass", "chords", "lead"]),
    });
    expect(request.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: "hard", origin: "prompt", confidence: "parsed" }),
        expect.objectContaining({ section: "preserve", role: "bass" }),
      ]),
    );

    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain(project.id);
    expect(serialized).not.toContain(project.name);
    expect(project.tracks.every((track) => !serialized.includes(track.id))).toBe(true);
    expect(project.patterns.every((pattern) => !serialized.includes(pattern.id))).toBe(true);
  });

  it("reports unknown fields and conflicts as typed facts, not UI labels", () => {
    const parsed = parseIntentText("no bass, keep my bass");
    const contract = compileBriefContract(parsed);
    const result = createCreativeTaskRequestV1({
      operation: "revise",
      prompt: "no bass, keep my bass",
      intent: parsed.input,
      contract,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.operation).toBe("revise");
    expect(result.request.conflicts).toContainEqual({ role: "bass", kind: "prohibition-vs-preserve" });
    expect(result.request.unknownFields).toEqual(expect.arrayContaining(["bpmRange", "key", "length"]));
    expect(JSON.stringify(result.request)).not.toContain("KYX túto rolu vie zamknúť");
  });

  it("does not silently truncate oversized prompts for model interpretation", () => {
    const result = createCreativeTaskRequestV1({
      operation: "generate",
      prompt: "x".repeat(MAX_CREATIVE_TASK_PROMPT_LENGTH + 1),
      intent: {},
      contract: { statements: [], conflicts: [] },
    });

    expect(result).toEqual({ ok: false, reason: "prompt-too-long" });
  });

  it("accepts only bounded, versioned proposals with allowlisted fields", () => {
    const result = validateCreativeTaskOutput({
      version: 1,
      status: "proposal",
      suggestions: {
        genre: "trap",
        mood: "dark but hopeful",
        bpmRange: [140, 144],
        lengthSteps: 128,
        targetRoles: ["drums", "lead"],
      },
      unknownFields: ["key"],
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        status: "proposal",
        suggestions: { genre: "trap", bpmRange: [140, 144], lengthSteps: 128 },
        unknownFields: ["key"],
      },
    });
  });

  it.each([
    [{ version: 2, status: "proposal", suggestions: { genre: "trap" }, unknownFields: [] }, "unsupported-version"],
    [
      { version: 1, status: "proposal", suggestions: { projectId: "private" }, unknownFields: [] },
      "invalid-suggestion",
    ],
    [{ version: 1, status: "proposal", suggestions: { bpmRange: [20, 400] }, unknownFields: [] }, "invalid-suggestion"],
    [{ version: 1, status: "proposal", suggestions: { lengthSteps: 512 }, unknownFields: [] }, "invalid-suggestion"],
    [
      { version: 1, status: "proposal", suggestions: { targetRoles: ["bass", "bass"] }, unknownFields: [] },
      "invalid-suggestion",
    ],
    [
      { version: 1, status: "proposal", suggestions: { genre: "unknown-genre" }, unknownFields: [] },
      "invalid-suggestion",
    ],
    [{ version: 1, status: "proposal", suggestions: {}, unknownFields: ["privateField"] }, "invalid-unknown-field"],
    [
      { version: 1, status: "proposal", suggestions: { mood: "dark" }, unknownFields: [], question: "Which mood?" },
      "invalid-clarification",
    ],
  ] as const)("rejects malformed or out-of-contract output", (value, error) => {
    expect(validateCreativeTaskOutput(value)).toEqual({ ok: false, error });
  });

  it("requires clarification for contradictory role suggestions", () => {
    const contradiction = {
      version: 1,
      status: "proposal",
      suggestions: { targetRoles: ["bass"], preserveRoles: ["bass"] },
      unknownFields: [],
    };
    expect(validateCreativeTaskOutput(contradiction)).toEqual({ ok: false, error: "contradictory-suggestion" });
    expect(
      validateCreativeTaskOutput({ ...contradiction, status: "clarify", question: "Should I change the bass?" }),
    ).toMatchObject({ ok: true, output: { status: "clarify" } });
  });

  it("applies only user-approved suggestions and never replaces explicit facts", () => {
    const validated = validateCreativeTaskOutput({
      version: 1,
      status: "proposal",
      suggestions: {
        genre: "trap",
        mood: "hopeful",
        bpmRange: [140, 144],
        targetRoles: ["drums", "lead"],
        prohibitedRoles: ["chords"],
      },
      unknownFields: [],
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const result = resolveApprovedCreativeTaskOutput({
      output: validated.output,
      intent: { genre: "trap", bpmRange: [142, 142], preserve: ["bass"] },
      availableRoles: ["drums", "bass", "chords", "lead"],
      existingProhibitedRoles: [],
      approvedFields: ["mood", "roles"],
    });

    expect(result).toMatchObject({
      ok: true,
      intent: {
        genre: "trap",
        bpmRange: [142, 142],
        mood: "hopeful",
        roles: ["drums", "lead"],
        preserve: ["bass"],
      },
      prohibitedRoles: [],
      appliedFields: ["mood", "roles"],
    });
  });

  it("fails atomically when a model suggestion conflicts with an explicit fact", () => {
    const validated = validateCreativeTaskOutput({
      version: 1,
      status: "proposal",
      suggestions: { bpmRange: [140, 144], mood: "hopeful" },
      unknownFields: [],
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(
      resolveApprovedCreativeTaskOutput({
        output: validated.output,
        intent: { bpmRange: [142, 142] },
        availableRoles: [],
        approvedFields: ["bpmRange", "mood"],
      }),
    ).toEqual({ ok: false, reason: "conflicts-with-explicit-intent", field: "bpmRange" });
  });

  it("cannot target a role that the current project cannot route", () => {
    const validated = validateCreativeTaskOutput({
      version: 1,
      status: "proposal",
      suggestions: { targetRoles: ["lead"] },
      unknownFields: [],
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(
      resolveApprovedCreativeTaskOutput({
        output: validated.output,
        intent: {},
        availableRoles: ["drums"],
        approvedFields: ["roles"],
      }),
    ).toEqual({ ok: false, reason: "target-role-unavailable", field: "roles" });
  });

  it("does not approve a model prohibition that contradicts a protected project role", () => {
    const validated = validateCreativeTaskOutput({
      version: 1,
      status: "proposal",
      suggestions: { prohibitedRoles: ["bass"] },
      unknownFields: [],
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(
      resolveApprovedCreativeTaskOutput({
        output: validated.output,
        intent: { preserve: ["bass"] },
        availableRoles: [],
        approvedFields: ["prohibitedRoles"],
      }),
    ).toEqual({ ok: false, reason: "conflicts-with-explicit-intent", field: "preserve" });
  });

  it("does not apply unapproved role restrictions or allow clarification output to execute", () => {
    const validated = validateCreativeTaskOutput({
      version: 1,
      status: "proposal",
      suggestions: { mood: "hopeful", prohibitedRoles: ["bass"] },
      unknownFields: [],
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(
      resolveApprovedCreativeTaskOutput({
        output: validated.output,
        intent: {},
        availableRoles: [],
        approvedFields: ["mood"],
      }),
    ).toMatchObject({ ok: true, prohibitedRoles: [], intent: { mood: "hopeful" } });

    const clarification = validateCreativeTaskOutput({
      version: 1,
      status: "clarify",
      suggestions: { mood: "hopeful" },
      unknownFields: ["bpmRange"],
      question: "What tempo should I use?",
    });
    expect(clarification.ok).toBe(true);
    if (!clarification.ok) return;
    expect(
      resolveApprovedCreativeTaskOutput({
        output: clarification.output,
        intent: {},
        availableRoles: [],
        approvedFields: ["mood"],
      }),
    ).toEqual({ ok: false, reason: "clarification-required" });
  });

  it("contains malformed, oversized and invalid JSON responses without throwing", () => {
    expect(parseCreativeTaskOutputJson("not json")).toEqual({ ok: false, error: "invalid-json" });
    expect(parseCreativeTaskOutputJson(" ".repeat(MAX_CREATIVE_TASK_OUTPUT_LENGTH + 1))).toEqual({
      ok: false,
      error: "output-too-large",
    });
    expect(
      parseCreativeTaskOutputJson('{"version":1,"status":"proposal","suggestions":{},"unknownFields":[]}'),
    ).toEqual({
      ok: false,
      error: "invalid-suggestion",
    });
  });
});
