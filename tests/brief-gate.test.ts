import { describe, expect, it, beforeEach } from "vitest";
import { testDoc } from "./fixtures/doc";
import { generateAsyncResult, generateLocalResult } from "../src/intent/pipeline";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { briefGateViolations, evaluateBriefCompliance } from "../src/intent/brief-gate";
import { evaluateCandidate } from "../src/intent/providers/candidate";
import { generatePattern } from "../src/ai/generator";
import { instrumentTrackForRole } from "../src/ai/role-targets";

/**
 * FÁZA 2 (AI-first producer): hard brief gating BEFORE ranking + truthful
 * compliance reporting. A candidate that violates the hard brief (wrong
 * length, all-silent content, prohibited drum content) never enters the
 * candidate bank; the compliance report mirrors every hard fact with
 * ✓/✗/· — never a quality score.
 */

beforeEach(() => {
  localStorage.setItem("pf:intent-ranker", "off");
});

const silentCopy = (pattern: ReturnType<typeof generatePattern>) => ({
  ...pattern,
  rows: Object.fromEntries(
    Object.keys(pattern.rows ?? {}).map((pad) => [pad, new Array<number>(pattern.stepCount).fill(0)]),
  ),
  notes: {},
});

describe("briefGateViolations (per-candidate hard facts)", () => {
  const doc = testDoc();
  const plan = planGeneration(normalizeIntent({ genre: "house", seed: "gate", roles: ["drums", "bass"] }), doc);
  const full = generatePattern(doc, plan.options);

  it("a normal candidate violates nothing", () => {
    expect(briefGateViolations(full, plan)).toEqual([]);
  });

  it("wrong length is a violation", () => {
    const short: typeof full = { ...full, stepCount: full.stepCount / 2 };
    expect(briefGateViolations(short, plan).map((v) => v.id)).toContain("length");
  });

  it("an all-silent candidate is a violation even though invariants pass it", () => {
    const silent = silentCopy(full);
    expect(briefGateViolations(silent, plan).map((v) => v.id)).toContain("empty");
  });

  it("drum content with drums excluded (ZÁKAZY/ZACHOVAŤ) is a violation", () => {
    const melodyPlan = planGeneration(
      normalizeIntent({ genre: "house", seed: "gate", roles: ["bass", "chords", "lead"] }),
      doc,
    );
    expect(briefGateViolations(full, melodyPlan).map((v) => v.id)).toContain("prohibited-drums");
  });

  it("a melody-only candidate with clean rows violates nothing", () => {
    const melodyPlan = planGeneration(
      normalizeIntent({ genre: "house", seed: "gate", roles: ["bass", "chords", "lead"] }),
      doc,
    );
    const clean: typeof full = { ...full, rows: {} };
    const violations = briefGateViolations(clean, melodyPlan);
    expect(violations.filter((v) => v.id === "prohibited-drums")).toEqual([]);
    expect(violations.filter((v) => v.id === "empty")).toEqual([]);
  });

  it("rejects notes on an unrequested, uniquely mapped melodic role", () => {
    const doc = testDoc();
    const plan = planGeneration(
      normalizeIntent({ genre: "house", seed: "gate-unrequested-chords", roles: ["drums", "bass"] }),
      doc,
    );
    const allRoles = generatePattern(doc, { ...plan.options, roles: ["drums", "bass", "chords"] });

    expect(instrumentTrackForRole(doc, "chord")?.id).not.toBe(instrumentTrackForRole(doc, "bass")?.id);
    expect(allRoles.notes[instrumentTrackForRole(doc, "chord")!.id]?.length).toBeGreaterThan(0);
    expect(briefGateViolations(allRoles, plan, { project: doc }).map((violation) => violation.id)).toContain(
      "unexpected-role-chords",
    );
  });

  it("does not mislabel content on a track shared by generated roles", () => {
    const doc = testDoc();
    const plan = planGeneration(
      normalizeIntent({ genre: "house", seed: "gate-shared-lane", roles: ["drums", "bass"] }),
      doc,
    );
    const candidate = generatePattern(doc, plan.options);

    expect(instrumentTrackForRole(doc, "bass")?.id).toBe(instrumentTrackForRole(doc, "lead")?.id);
    expect(briefGateViolations(candidate, plan, { project: doc })).toEqual([]);
  });
});

describe("evaluateCandidate drops brief violations (after invariant/repair)", () => {
  it("all-silent candidate is dropped with a brief-gate reason", () => {
    const doc = testDoc();
    const plan = planGeneration(normalizeIntent({ genre: "house", seed: "gate" }), doc);
    const reasons: string[] = [];
    const silent = silentCopy(generatePattern(doc, plan.options));
    expect(evaluateCandidate(silent, plan, { project: doc, mode: "apply" }, reasons)).toBeNull();
    expect(reasons).toContain("brief-gate:empty");
  });

  it("prohibited drum content is dropped with a brief-gate reason", () => {
    const doc = testDoc();
    const plan = planGeneration(
      normalizeIntent({ genre: "house", seed: "gate", roles: ["bass", "chords", "lead"] }),
      doc,
    );
    const reasons: string[] = [];
    const withDrums = generatePattern(doc, { ...plan.options, roles: ["drums", "bass"] });
    expect(evaluateCandidate(withDrums, plan, { project: doc, mode: "apply" }, reasons)).toBeNull();
    expect(reasons).toContain("brief-gate:prohibited-drums");
  });

  it("out-of-scope melodic content is dropped before ranking", () => {
    const doc = testDoc();
    const plan = planGeneration(
      normalizeIntent({ genre: "house", seed: "gate-prohibited-chords", roles: ["drums", "bass"] }),
      doc,
    );
    const candidate = generatePattern(doc, { ...plan.options, roles: ["drums", "bass", "chords"] });
    const reasons: string[] = [];

    expect(evaluateCandidate(candidate, plan, { project: doc, mode: "apply" }, reasons)).toBeNull();
    expect(reasons).toContain("brief-gate:unexpected-role-chords");
  });

  it("a valid candidate still passes (gate does not over-drop)", () => {
    const doc = testDoc();
    const plan = planGeneration(normalizeIntent({ genre: "house", seed: "gate" }), doc);
    const evaluated = evaluateCandidate(generatePattern(doc, plan.options), plan, { project: doc, mode: "apply" });
    expect(evaluated).not.toBeNull();
    expect(["accepted", "repaired"]).toContain(evaluated!.status);
  });
});

describe("the bank cannot contain a brief-violating result (end-to-end)", () => {
  it("sync path with a prohibited brief produces content matching the generation set", () => {
    const doc = testDoc();
    const result = generateLocalResult(
      doc,
      normalizeIntent({ genre: "house", seed: "gate-e2e", roles: ["drums"], candidateCount: 3 }),
      "apply",
    );
    expect(["accepted", "repaired"]).toContain(result.status);
    expect(result.proposal!.pattern.stepCount).toBe(result.plan.intent.length);
  });

  it("async bank: every candidate matches the planned length", async () => {
    const doc = testDoc();
    const result = await generateAsyncResult(
      doc,
      normalizeIntent({ genre: "house", seed: "gate-e2e", candidateCount: 3, length: 32 }),
      { mode: "apply", includeBank: true },
    );
    for (const candidate of result.bank ?? []) {
      expect(candidate.pattern.stepCount).toBe(32);
      expect(briefGateViolations(candidate.pattern, result.plan)).toEqual([]);
    }
  });
});

describe("evaluateBriefCompliance (truthful UI mirror)", () => {
  it("provable facts get ✓, unset ones get ·", () => {
    const doc = testDoc();
    const result = generateLocalResult(
      doc,
      normalizeIntent({ genre: "house", seed: "compliance", bpmRange: [140, 140], roles: ["drums"] }),
      "apply",
    );
    const items = evaluateBriefCompliance(result, doc);
    const byId = (id: string) => items.find((item) => item.id === id);
    expect(byId("bpm")?.satisfied).toBe(true);
    expect(byId("length")?.satisfied).toBe(true);
    expect(byId("key")?.satisfied).toBeNull();
    expect(byId("roles")?.satisfied).toBe(true);
    expect(byId("no-drums")).toBeUndefined(); // drums ARE in the set — no prohibition row
  });

  it("role compliance checks every uniquely mapped requested lane, not any content", () => {
    const doc = testDoc();
    const result = generateLocalResult(
      doc,
      normalizeIntent({ genre: "house", seed: "compliance-role-scope", roles: ["drums", "bass", "chords"] }),
      "apply",
    );
    const chordTrackId = instrumentTrackForRole(doc, "chord")!.id;
    const missingChords = {
      ...result,
      proposal: result.proposal
        ? {
            ...result.proposal,
            pattern: { ...result.proposal.pattern, notes: { ...result.proposal.pattern.notes, [chordTrackId]: [] } },
          }
        : undefined,
    };
    const roles = evaluateBriefCompliance(missingChords, doc).find((item) => item.id === "roles");

    expect(roles?.satisfied).toBe(false);
    expect(roles?.detail).toContain("chords ✗");
  });

  it("reports role compliance as unverified when one track represents multiple roles", () => {
    const doc = testDoc();
    const result = generateLocalResult(
      doc,
      normalizeIntent({ genre: "house", seed: "compliance-shared-role", roles: ["drums", "bass"] }),
      "apply",
    );
    const roles = evaluateBriefCompliance(result, doc).find((item) => item.id === "roles");

    expect(roles?.satisfied).toBeNull();
    expect(roles?.detail).toContain("zdieľaný track, nemožno samostatne overiť");
  });

  it("preserved drums are not mislabeled as a no-drums request", () => {
    const doc = testDoc();
    const result = generateLocalResult(
      doc,
      normalizeIntent({ genre: "house", seed: "compliance2", roles: ["bass"], preserve: ["drums"] }),
      "apply",
    );
    const items = evaluateBriefCompliance(result, doc);
    const byId = (id: string) => items.find((item) => item.id === id);
    expect(byId("no-drums")).toBeUndefined();
    expect(byId("preserve")?.label).toContain("drums");
    expect(byId("preserve")?.satisfied).toBe(true);
    expect(byId("preserve")?.detail).toContain("zdrojových rolí je v návrhu zachovaný");
  });

  it("reports a preserve mismatch when the audition candidate loses protected source content", () => {
    const doc = testDoc();
    const result = generateLocalResult(
      doc,
      normalizeIntent({ genre: "house", seed: "compliance-preserve-mismatch", roles: ["bass"], preserve: ["drums"] }),
      "apply",
    );
    const pattern = result.proposal?.pattern;
    expect(pattern).toBeDefined();
    const damaged = {
      ...result,
      proposal: result.proposal
        ? { ...result.proposal, pattern: { ...result.proposal.pattern, rows: {}, stepMeta: undefined } }
        : undefined,
    };
    const preserve = evaluateBriefCompliance(damaged, doc).find((item) => item.id === "preserve");
    expect(preserve?.satisfied).toBe(false);
    expect(preserve?.detail).toMatch(/zdrojový obsah.*líši/i);
  });
});
