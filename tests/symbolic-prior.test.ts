import { describe, it, expect, vi, beforeEach } from "vitest";
import { testDoc } from "./fixtures/doc";
import { GROOVE_LIBRARY } from "../src/ai/grooves/index";
import {
  PRIOR_FEATURE_COUNT,
  PRIOR_STYLE_VOCAB,
  buildPriorFeatureRow,
  buildPriorGridRows,
} from "../src/ai/symbolic/prior-features";
import { planGeneration } from "../src/intent/plan";
import { normalizeIntent } from "../src/intent/normalize";
import { symbolicPriorProvider, symbolicWanted } from "../src/intent/providers/symbolic";
import { rankCandidateBank } from "../src/intent/candidate-bank";

// The prior worker is an ORT/Web-Worker runtime — unit tests stub the client
// with deterministic probabilities. The REAL model artifact is validated by
// scripts/validate-symbolic-prior.mjs + scripts/validate-symbolic-melodic.mjs
// and exercised end-to-end in the browser smoke; these tests pin the provider
// logic around the clients. Melodic defaults to UNAVAILABLE (template melody
// fallback) — tests/symbolic-melodic.test.ts covers the melodic path.
vi.mock("../src/ai/symbolic/prior-client", () => ({
  runPriorGrid: vi.fn(),
  runMelodicNext: vi.fn(async () => ({ ok: false, degree: null, duration: null, source: "fallback" as const })),
  priorMode: vi.fn(() => "on" as const),
  resetPriorClient: vi.fn(),
  currentPriorManifest: vi.fn(() => null),
}));

import { runPriorGrid } from "../src/ai/symbolic/prior-client";

const runPriorGridMock = vi.mocked(runPriorGrid);

/** Deterministic synthetic prior: kick hits downbeats, hats hit offbeats. */
function stubProbs(batch: Float32Array, rowCount: number): number[] {
  // Feature layout: [0..3] genre, [4..24] style, [25..33] role,
  // [34..38] step-in-bar, [42] isDownbeat, [43] isBackbeat.
  const probs: number[] = [];
  for (let row = 0; row < rowCount; row++) {
    const roleOffset = 25;
    const isKick = batch[row * PRIOR_FEATURE_COUNT + roleOffset] === 1;
    const isClosedHat = batch[row * PRIOR_FEATURE_COUNT + roleOffset + 3] === 1;
    const s16 = batch[row * PRIOR_FEATURE_COUNT + 34];
    const isDownbeat = batch[row * PRIOR_FEATURE_COUNT + 42] === 1;
    probs.push(isKick ? (isDownbeat ? 0.95 : s16 < 0.5 ? 0.3 : 0.05) : isClosedHat ? 0.4 + s16 * 0.3 : 0.1);
  }
  return probs;
}

beforeEach(() => {
  runPriorGridMock.mockReset();
  runPriorGridMock.mockImplementation(async (batch: Float32Array, rowCount: number) => {
    const featureCount = batch.length / rowCount;
    if (!Number.isInteger(featureCount) || featureCount !== PRIOR_FEATURE_COUNT) {
      return { ok: false, probs: null, source: "fallback" as const };
    }
    return { ok: true, probs: stubProbs(batch, rowCount), source: "model" as const };
  });
});

describe("prior-features contract", () => {
  it("style vocabulary exactly covers the groove library", () => {
    expect([...GROOVE_LIBRARY.map((groove) => groove.id)].sort()).toEqual([...PRIOR_STYLE_VOCAB].sort());
  });

  it("produces deterministic fixed-width one-hot rows", () => {
    const a = buildPriorFeatureRow({ genre: "house", styleId: "house.deep", role: "kick", step: 4, stepCount: 32 });
    const b = buildPriorFeatureRow({ genre: "house", styleId: "house.deep", role: "kick", step: 4, stepCount: 32 });
    expect(a).toEqual(b);
    expect(a.length).toBe(PRIOR_FEATURE_COUNT);
    // genre one-hot: house at index 0
    expect(a[0]).toBe(1);
    // style one-hot: house.deep is index 3 of the vocab
    expect(a[4 + PRIOR_STYLE_VOCAB.indexOf("house.deep")]).toBe(1);
    // role one-hot: kick at index 0 of the role block (offset 4 + 21)
    expect(a[4 + PRIOR_STYLE_VOCAB.length]).toBe(1);
    // downbeat flag at s16=4 must be 0; backbeat flag 1
    expect(a[PRIOR_FEATURE_COUNT - 2]).toBe(0);
    expect(a[PRIOR_FEATURE_COUNT - 1]).toBe(1);
    // all features finite
    for (const value of a) expect(Number.isFinite(value)).toBe(true);
  });

  it("maps vocab roles by index and wraps foreign roles into `unknown`", () => {
    const roleOffset = 4 + PRIOR_STYLE_VOCAB.length; // 25
    // perc is vocab index 5 (kick, snare, clap, closedHat, openHat, perc, …)
    const perc = buildPriorFeatureRow({ genre: "trap", styleId: "trap.classic", role: "perc", step: 0, stepCount: 16 });
    expect(perc[roleOffset + 5]).toBe(1);
    // a foreign role string falls back to the `unknown` one-hot (vocab index 8)
    const foreign = buildPriorFeatureRow({
      genre: "trap",
      styleId: "trap.classic",
      role: "banana" as never,
      step: 0,
      stepCount: 16,
    });
    expect(foreign[roleOffset + 8]).toBe(1);
    // genre + style one-hots remain intact
    expect(foreign[2]).toBe(1); // trap
    expect(foreign[4 + PRIOR_STYLE_VOCAB.indexOf("trap.classic")]).toBe(1);
  });

  it("grid rows are pads × steps, row-major", () => {
    const rows = buildPriorGridRows({ genre: "techno", styleId: "techno.acid", stepCount: 32, padRoles: ["kick", "closedHat", "snare"] });
    expect(rows.length).toBe(3 * 32);
    expect(rows[1]).toEqual(buildPriorFeatureRow({ genre: "techno", styleId: "techno.acid", role: "kick", step: 1, stepCount: 32 }));
    expect(rows[32]).toEqual(buildPriorFeatureRow({ genre: "techno", styleId: "techno.acid", role: "closedHat", step: 0, stepCount: 32 }));
  });
});

describe("symbolic prior provider", () => {
  const intent = normalizeIntent({
    genre: "house",
    seed: "sym-test",
    length: 16,
    candidateCount: 1,
    symbolicCandidates: 2,
    roles: ["drums", "bass", "chords", "lead"],
  });
  const doc = testDoc();

  it("requests symbolic candidates only when configured", () => {
    const plan = planGeneration(intent, doc);
    expect(symbolicWanted(plan)).toBe(true);
    expect(plan.symbolicSeeds).toEqual(["sym-test|symbolic:0", "sym-test|symbolic:1"]);

    const plain = planGeneration(normalizeIntent({ genre: "house", seed: "x" }), doc);
    expect(symbolicWanted(plain)).toBe(false);
    expect(plain.symbolicSeeds).toEqual([]);
  });

  it("produces valid, invariant-clean candidates through the shared gates", async () => {
    const plan = planGeneration(intent, doc);
    const { entries, failures } = await symbolicPriorProvider.collectCandidates(plan, { project: doc, mode: "apply" }, 1);
    expect(failures).toEqual([]);
    expect(entries.length).toBe(2);
    for (const entry of entries) {
      expect(entry.source).toBe("symbolic-prior");
      expect(entry.status === "accepted" || entry.status === "repaired").toBe(true);
      // rows are complete and shaped for every pad of the drum track
      const drumTrack = doc.tracks.find((track) => track.kind === "drum");
      for (const pad of drumTrack?.pads ?? []) {
        expect(entry.pattern.rows[pad.id]?.length).toBe(16);
      }
      // melodic engine output preserved
      expect(Object.keys(entry.pattern.notes ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("is deterministic for the same plan and stubbed prior", async () => {
    const plan = planGeneration(intent, doc);
    const first = await symbolicPriorProvider.collectCandidates(plan, { project: doc, mode: "apply" }, 1);
    const second = await symbolicPriorProvider.collectCandidates(plan, { project: doc, mode: "apply" }, 1);
    expect(first.entries.length).toBe(second.entries.length);
    for (let index = 0; index < first.entries.length; index++) {
      expect(first.entries[index].pattern.rows).toEqual(second.entries[index].pattern.rows);
      // UUIDs differ by design; the UUID-free CONTENT identity must not.
      expect(first.entries[index].pattern.generation?.outputContentHash).toBeTruthy();
      expect(first.entries[index].pattern.generation?.outputContentHash).toBe(
        second.entries[index].pattern.generation?.outputContentHash,
      );
      const stripIds = (notes: typeof first.entries[number]["pattern"]["notes"]) =>
        JSON.stringify(notes, (key, value) => (key === "id" ? undefined : value));
      expect(stripIds(first.entries[index].pattern.notes)).toBe(stripIds(second.entries[index].pattern.notes));
    }
  });

  it("shrink-to-zero on prior failure — never throws", async () => {
    runPriorGridMock.mockResolvedValue({ ok: false, probs: null, source: "fallback" });
    const plan = planGeneration(intent, doc);
    const { entries, failures } = await symbolicPriorProvider.collectCandidates(plan, { project: doc, mode: "apply" }, 1);
    expect(entries).toEqual([]);
    expect(failures.length).toBe(2);
    expect(failures[0]).toContain("prior-fallback");
  });

  it("entries compete in the shared candidate bank", async () => {
    const plan = planGeneration(intent, doc);
    const { entries } = await symbolicPriorProvider.collectCandidates(plan, { project: doc, mode: "apply" }, 1);
    const ranked = rankCandidateBank(doc, entries);
    expect(ranked.length).toBe(2);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });
});

describe("async pipeline integration", () => {
  it("merges symbolic candidates into the ranked bank with diagnostics", async () => {
    const doc = testDoc();
    const result = await (await import("../src/intent/pipeline")).generateAsyncResult(
      doc,
      normalizeIntent({
        genre: "house",
        seed: "integration",
        candidateCount: 2,
        symbolicCandidates: 2,
      }),
      { mode: "apply" },
    );
    expect(result.proposal).toBeDefined();
    expect(["accepted", "repaired", "fallback"]).toContain(result.status);
    const warnings = result.diagnostics.warnings;
    expect(warnings).toContain("candidate-bank-enabled");
    expect(warnings.some((warning) => warning.startsWith("candidate-bank-selected:"))).toBe(true);
    expect(warnings).toContain("symbolic-prior-candidates:2");
  });
});
