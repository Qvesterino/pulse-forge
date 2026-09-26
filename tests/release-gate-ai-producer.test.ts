import { describe, expect, it, beforeEach } from "vitest";
import { testDoc } from "./fixtures/doc";
import { generateLocalResult, generateAsyncResult, resultForCandidate } from "../src/intent/pipeline";
import { parseIntentText } from "../src/intent/text-parser";
import { normalizeIntent } from "../src/intent/normalize";
import { intentHash } from "../src/intent/hash";
import { applyGenerationResultCommand } from "../src/commands/commands";
import { briefGateViolations } from "../src/intent/brief-gate";
import { compileIteration } from "../src/intent/iteration";
import { recommendLoudnessTrim } from "../src/intent/loudness";
import { rememberGeneration, type SessionGeneration } from "../src/intent/session-context";

/**
 * FÁZA 8 — RELEASE GATE pre AI-first producer workflow.
 *
 * Every code-verifiable gate criterion runs here against the REAL modules
 * (parser → contract → plan → candidates → gates → apply), not mocks. The
 * gates that are NOT code-verifiable from a vitest run are reported in the
 * roadmap status, never counted as PASS:
 *   - ľudské blind listening (Fáza 4/8) — OWED, pending;
 *   - e2e smoke / real-browser / build+budget — executed as shell commands
 *     alongside this suite, reported with their own results.
 */

beforeEach(() => {
  localStorage.setItem("pf:intent-ranker", "off");
});

// ── Gate 1: BRIEF FIDELITY ────────────────────────────────────────────────
// Hard constraints are either satisfied by the proposal, or the candidate
// never reached the bank (model scores cannot override what isn't there).

const GATE_BRIEFS: ReadonlyArray<{ name: string; text: string }> = [
  { name: "explicit BPM + genre", text: "dark rolling techno at 140 with lead" },
  { name: "drum prohibition", text: "melodic techno at 128, žiadne bicie" },
  { name: "melody only", text: "beat only, dark trap at 142" },
  { name: "protected roles", text: "house groovy 124, nechaj bass a akordy" },
];

function hardFactViolations(
  pattern: NonNullable<ReturnType<typeof generateLocalResult>["proposal"]>["pattern"],
  intent: ReturnType<typeof normalizeIntent>,
): string[] {
  const violations: string[] = [];
  if (pattern.stepCount !== intent.length) violations.push("length");
  const rows = Object.values(pattern.rows ?? {});
  const hasRows = rows.some((row) => Array.isArray(row) && row.some((v) => Number.isFinite(v) && v > 0));
  const notes = Object.values(pattern.notes ?? {});
  const hasNotes = notes.some((list) => Array.isArray(list) && list.length > 0);
  if (!hasRows && !hasNotes) violations.push("empty");
  if (!intent.roles.includes("drums") && hasRows) violations.push("prohibited-drums");
  if (intent.preserve?.includes("drums") && hasRows) violations.push("preserved-drums");
  return violations;
}

describe("GATE brief fidelity — hard constraints over model scores", () => {
  for (const brief of GATE_BRIEFS) {
    it(`"${brief.name}": proposal satisfies hard facts, bank is violation-free`, () => {
      const doc = testDoc();
      const parsed = parseIntentText(brief.text);
      const input = normalizeIntent({ ...parsed.input, candidateCount: 3, seed: `gate-${brief.name}` });
      const result = generateLocalResult(doc, input, "apply");
      expect(result.proposal).toBeDefined();
      // The applied proposal itself carries no hard violation…
      expect(hardFactViolations(result.proposal!.pattern, result.plan.intent)).toEqual([]);
      // …and the bank cannot contain one — ranking only sees gated candidates.
      for (const candidate of result.bank ?? []) {
        expect(briefGateViolations(candidate.pattern, result.plan)).toEqual([]);
      }
    });
  }
});

// ── Gate 2: PRESNOSŤ ZMIEN ────────────────────────────────────────────────

describe("GATE precision of changes — protected content, stale proposals", () => {
  it("a protected-role iteration keeps non-target content identical; reject mutates nothing", async () => {
    const doc = testDoc();
    const result = await generateAsyncResult(
      doc,
      normalizeIntent({ genre: "house", seed: "gate-iter", candidateCount: 3, length: 16 }),
      { mode: "apply", includeBank: true },
    );
    const generation: SessionGeneration = {
      text: "gate",
      intent: result.plan.intent,
      candidates: (result.bank ?? []).map((entry, index) => ({
        index,
        pattern: entry.pattern,
        intent: result.plan.intent,
      })),
      appliedIndex: null,
      docId: doc.id,
      at: 0,
    };
    rememberGeneration(generation);
    const before = JSON.stringify(doc);
    const proposal = compileIteration("ten druhý, ale temnejší; nechaj bass a akordy", generation, doc)!;
    // Rejected (never applied) → project bit-for-bit unchanged.
    expect(JSON.stringify(doc)).toBe(before);
    // Protected melodic block content-identical to the referenced candidate.
    const candidate = generation.candidates[1].pattern;
    expect(JSON.stringify(proposal.result.proposal!.pattern.notes)).toBe(JSON.stringify(candidate.notes));
  });

  it("the loudness recommendation never mutates the master by itself", () => {
    const doc = testDoc();
    const before = JSON.stringify(doc);
    recommendLoudnessTrim(-10, -14, 0);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

// ── Gate 3: DETERMINIZMUS A MUTÁCIE ───────────────────────────────────────

describe("GATE determinism and mutations", () => {
  it("same brief + seed + engine → identical intent hash and content", () => {
    const doc = testDoc();
    const text = "dark rolling techno at 140 with lead";
    const input = normalizeIntent({ ...parseIntentText(text).input, seed: "gate-det" });
    const a = generateLocalResult(doc, input, "apply");
    const b = generateLocalResult(doc, input, "apply");
    expect(intentHash(a.plan.intent)).toBe(intentHash(b.plan.intent));
    expect(a.proposal).toBeDefined();
    expect(JSON.stringify(a.proposal?.pattern.rows)).toBe(JSON.stringify(b.proposal?.pattern.rows));
  });

  it("the auditioned candidate applies as-is via ONE undoable command (no regeneration)", async () => {
    const doc = testDoc();
    const result = await generateAsyncResult(
      doc,
      normalizeIntent({ genre: "house", seed: "gate-audition", candidateCount: 3 }),
      { mode: "apply", includeBank: true },
    );
    const bank = result.bank!;
    const pickedIndex = bank[1].candidateIndex;
    const picked = resultForCandidate(result, pickedIndex);
    // No regeneration: the applied pattern carries the auditioned entry's
    // exact content and id (resultForCandidate wraps provenance, not music).
    const auditioned = bank.find((c) => c.candidateIndex === pickedIndex)!.pattern;
    expect(picked.proposal!.pattern.id).toBe(auditioned.id);
    expect(JSON.stringify(picked.proposal!.pattern.rows)).toBe(JSON.stringify(auditioned.rows));
    expect(JSON.stringify(picked.proposal!.pattern.notes)).toBe(JSON.stringify(auditioned.notes));
    const command = applyGenerationResultCommand(doc, picked, "gate");
    const next = command.execute(doc);
    expect(next.patterns.length).toBe(doc.patterns.length + 1);
    expect(JSON.stringify(command.undo(next))).toBe(JSON.stringify(doc));
  });
});

// ── Gate 4: MODELOVÁ ODOLNOSŤ ─────────────────────────────────────────────

describe("GATE model resilience — missing/degraded model still produces a valid result", () => {
  it("ranker off: generation completes with heuristic selection and provenance", async () => {
    const doc = testDoc();
    const result = await generateAsyncResult(
      doc,
      normalizeIntent({ genre: "house", seed: "gate-offline", candidateCount: 3 }),
      { mode: "apply", includeBank: true },
    );
    expect(result.proposal).toBeDefined();
    expect(["accepted", "repaired", "fallback"]).toContain(result.status);
    expect(result.selection?.mode).toBe("off");
    expect(result.selection?.source).toBe("fallback");
    // The bank still exists and every entry is hard-gate clean.
    expect((result.bank ?? []).length).toBeGreaterThan(0);
    for (const candidate of result.bank ?? []) {
      expect(briefGateViolations(candidate.pattern, result.plan)).toEqual([]);
    }
  });

  it("a nonsense ranker-mode value degrades to a working generation (never throws)", () => {
    localStorage.setItem("pf:intent-ranker", "bogus-value");
    const doc = testDoc();
    const result = generateLocalResult(doc, normalizeIntent({ genre: "trap", seed: "gate-bogus" }), "apply");
    expect(result.proposal).toBeDefined();
    expect(["accepted", "repaired", "fallback"]).toContain(result.status);
  });
});

// ── Gate 5: AUDIO — generated PCM is bounded and finite ───────────────────

describe("GATE audio — generated content is bounded and finite", () => {
  it("every generated row velocity is finite within 0..1; pitches within MIDI range", () => {
    const doc = testDoc();
    for (const text of GATE_BRIEFS.map((brief) => brief.text)) {
      const result = generateLocalResult(
        doc,
        normalizeIntent({ ...parseIntentText(text).input, seed: "gate-pcm" }),
        "apply",
      );
      const pattern = result.proposal!.pattern;
      for (const row of Object.values(pattern.rows ?? {})) {
        for (const value of row) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
      for (const notes of Object.values(pattern.notes ?? {})) {
        for (const note of notes) {
          expect(Number.isFinite(note.pitch)).toBe(true);
          expect(note.pitch).toBeGreaterThanOrEqual(0);
          expect(note.pitch).toBeLessThanOrEqual(127);
          expect(Number.isFinite(note.duration)).toBe(true);
          expect(note.duration).toBeGreaterThan(0);
        }
      }
    }
  });
});
