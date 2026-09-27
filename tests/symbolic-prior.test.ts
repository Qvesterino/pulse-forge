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
import { parseIntentText } from "../src/intent/text-parser";
import { symbolicPriorProvider, symbolicWanted } from "../src/intent/providers/symbolic";
import { rankCandidateBank } from "../src/intent/candidate-bank";
import { STEP_TICKS } from "../src/project-model/types";

// The prior worker is an ORT/Web-Worker runtime — unit tests stub the client
// with deterministic probabilities. The REAL model artifact is validated by
// scripts/validate-symbolic-prior.mjs + scripts/validate-symbolic-melodic.mjs
// and exercised end-to-end in the browser smoke; these tests pin the provider
// logic around the clients. Melodic defaults to UNAVAILABLE (template melody
// fallback) — tests/symbolic-melodic.test.ts covers the melodic path.
vi.mock("../src/ai/symbolic/prior-client", () => ({
  runPriorGrid: vi.fn(),
  runPriorGridV2: vi.fn(),
  runPriorGridV3: vi.fn(),
  runMelodicNext: vi.fn(async () => ({ ok: false, degree: null, duration: null, source: "fallback" as const })),
  priorMode: vi.fn(() => "on" as const),
  embeddingConditionedMode: vi.fn(() => "on" as const),
  resetPriorClient: vi.fn(),
  currentPriorManifest: vi.fn(() => null),
}));

import { runPriorGrid, runPriorGridV3 } from "../src/ai/symbolic/prior-client";
import { V3_SEMANTIC_DIMS } from "../src/ai/symbolic/prior-features-v3";

/**
 * The semantic (embedding-conditioned) channel. The provider calls
 * `semanticConditioningForIntent` once per candidate batch and uses the result
 * to pick v3 → v2 → v1. In production it embeds the prompt with MiniLM; in
 * Node there is no Worker, so it would return null and every test would
 * silently exercise the template path. This mock makes the channel explicit
 * and controllable: `semanticVector = null` mirrors "no embedding available".
 */
const semanticHolder: { vector: readonly number[] | null } = { vector: null };
vi.mock("../src/intent/semantic-conditioning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/intent/semantic-conditioning")>();
  return {
    ...actual,
    semanticConditioningForIntent: vi.fn(async () => semanticHolder.vector),
    semanticConditioning: vi.fn(async () => semanticHolder.vector),
  };
});

const runPriorGridMock = vi.mocked(runPriorGrid);
const runPriorGridV3Mock = vi.mocked(runPriorGridV3);

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
  // Default to "no embedding available" so the pre-existing suites keep
  // exercising exactly the path they were written against. The semantic-gate
  // suite opts in explicitly.
  semanticHolder.vector = null;
  runPriorGridMock.mockReset();
  runPriorGridV3Mock.mockReset();
  runPriorGridMock.mockImplementation(async (batch: Float32Array, rowCount: number) => {
    const featureCount = batch.length / rowCount;
    if (!Number.isInteger(featureCount) || featureCount !== PRIOR_FEATURE_COUNT) {
      return { ok: false, probs: null, source: "fallback" as const };
    }
    return { ok: true, probs: stubProbs(batch, rowCount), source: "model" as const };
  });
  // v3 row layout: [0..15] semantic projection, then the v1 one-hot block.
  runPriorGridV3Mock.mockImplementation(async (batch: Float32Array, rowCount: number) => {
    const featureCount = batch.length / rowCount;
    if (!Number.isInteger(featureCount) || featureCount <= V3_SEMANTIC_DIMS) {
      return { ok: false, probs: null, source: "fallback" as const };
    }
    const tail = new Float32Array(rowCount * (featureCount - V3_SEMANTIC_DIMS));
    for (let row = 0; row < rowCount; row++) {
      tail.set(
        batch.subarray(row * featureCount + V3_SEMANTIC_DIMS, (row + 1) * featureCount),
        row * (featureCount - V3_SEMANTIC_DIMS),
      );
    }
    const v1Probs = stubProbs(tail, rowCount);
    return { ok: true, probs: v1Probs, source: "model" as const };
  });
});

describe("semantic conditioning gate", () => {
  // The v1 one-hot vocabulary covers a small slice of the library (house 7/53,
  // trap 5/26, dnb and boombap none), so an out-of-vocab groove silently falls
  // back to template drums. The escape hatch is the semantic (v2/v3) channel,
  // and it is gated ONLY on `intent.text`. This suite pins the whole chain:
  // parser → normalize → semanticConditioning → v3 client.
  const doc = testDoc();

  /**
   * The shape IntentPanel actually builds: the PARSED prompt (which now
   * carries `text`) merged with plan-shaping fields. Pin the groove to
   * house.afropop so this test always exercises the v3-only vocabulary gap.
   */
  const planFromPrompt = (prompt: string) =>
    planGeneration(
      normalizeIntent({
        ...parseIntentText(prompt).input,
        genre: "house",
        style: "afropop",
        seed: "semantic-gate",
        length: 16,
        candidateCount: 1,
        symbolicCandidates: 1,
        roles: ["drums", "bass", "chords", "lead"],
      }),
      doc,
    );

  it("carries the raw prompt text from the parser into the intent", () => {
    const raw = "travis scott meets metro boomin";
    const intent = normalizeIntent(parseIntentText(raw).input);
    expect(intent.text).toBe(raw);
  });

  it("routes an out-of-vocabulary groove to the v3 semantic prior when text is present", async () => {
    // The provider prefers v3 (semantic + one-hot, 60-dim) for ANY style.
    // Without an embedding it degrades to v1-or-template — which is exactly
    // the 13%-coverage regression that the missing `intent.text` caused.
    semanticHolder.vector = Object.freeze(new Array<number>(V3_SEMANTIC_DIMS).fill(0.05));

    // house.afropop is deliberately outside PRIOR_STYLE_VOCAB.
    expect((PRIOR_STYLE_VOCAB as readonly string[]).includes("house.afropop")).toBe(false);

    const plan = planFromPrompt("travis scott meets metro boomin");

    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      0,
    );
    expect(failures).toEqual([]);
    expect(runPriorGridV3Mock).toHaveBeenCalled();
    // A prior-produced grid ⇒ the candidate is tagged prior-derived, not
    // template. This is the coverage the missing `text` used to cost.
    expect(entries[0].source).toBe("symbolic-prior");
  });

  it("falls back to the template for the same groove when no embedding is available", async () => {
    // The mirror image: same prompt, embedding unavailable. This is what a
    // user without the semantic model gets, and it must degrade safely rather
    // than guess a grid.
    semanticHolder.vector = null;

    const plan = planFromPrompt("travis scott meets metro boomin");

    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      0,
    );
    expect(failures).toEqual([]);
    expect(runPriorGridV3Mock).not.toHaveBeenCalled();
    expect(entries[0].source).toBe("template");
    // Still a usable pattern — every drum row is shaped for the step count.
    for (const row of Object.values(entries[0].pattern.rows)) expect(row.length).toBe(16);
  });
});

describe("prior-features contract", () => {
  it("fixed model style vocabulary only references grooves in the library", () => {
    const grooveIds = new Set(GROOVE_LIBRARY.map((groove) => groove.id));
    expect(PRIOR_STYLE_VOCAB.length).toBeGreaterThan(0);
    expect(PRIOR_STYLE_VOCAB.every((styleId) => grooveIds.has(styleId))).toBe(true);
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

  it("does not alias an untrained style to the first trained style", () => {
    const row = buildPriorFeatureRow({
      genre: "house",
      styleId: "drill.dark",
      role: "kick",
      step: 0,
      stepCount: 16,
    });
    expect(row.slice(4, 4 + PRIOR_STYLE_VOCAB.length)).toEqual(Array(PRIOR_STYLE_VOCAB.length).fill(0));
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
    const rows = buildPriorGridRows({
      genre: "techno",
      styleId: "techno.acid",
      stepCount: 32,
      padRoles: ["kick", "closedHat", "snare"],
    });
    expect(rows.length).toBe(3 * 32);
    expect(rows[1]).toEqual(
      buildPriorFeatureRow({ genre: "techno", styleId: "techno.acid", role: "kick", step: 1, stepCount: 32 }),
    );
    expect(rows[32]).toEqual(
      buildPriorFeatureRow({ genre: "techno", styleId: "techno.acid", role: "closedHat", step: 0, stepCount: 32 }),
    );
  });
});

describe("symbolic prior provider", () => {
  // The drum-prior one-hot block only covers the frozen training vocabulary
  // (house: 7 of 53 grooves, trap: 5 of 26, dnb/boombap: none). An intent
  // WITHOUT an explicit style makes resolveGroove() pick a random groove, so
  // the prior is skipped and every candidate is honestly tagged "template".
  // That degradation is real — it is pinned by its own test below.
  //
  // `priorIntent` therefore pins an in-vocabulary style so the prior-path
  // assertions actually exercise the prior. It is kept separate from
  // `intent` because an explicit style is a request-level contract:
  // candidateSearchVariant() deliberately disables the `alternate-groove`
  // family when `plan.intent.style` is set (candidate-search.ts:125), and the
  // search-lane tests below depend on that family being available.
  const intent = normalizeIntent({
    genre: "house",
    seed: "sym-test",
    length: 16,
    candidateCount: 1,
    symbolicCandidates: 2,
    roles: ["drums", "bass", "chords", "lead"],
  });
  const priorIntent = normalizeIntent({
    genre: "house",
    style: "deep",
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
    const plan = planGeneration(priorIntent, doc);
    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      1,
    );
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

  it("applies the shared search-lane policy while retaining the original intent provenance", async () => {
    const plan = planGeneration(intent, doc);
    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      3,
      true,
    );

    expect(failures).toEqual([]);
    expect(entries.map((entry) => entry.search?.lane)).toEqual(["safe", "personal"]);
    expect(entries[0].candidateIndex).toBe(3);
    expect(entries[0].seed).toBe(plan.symbolicSeeds[0]);
    expect(entries[1].seed).toContain("search:v1:personal");
    for (const entry of entries) {
      expect(entry.pattern.generation?.intent).toEqual(plan.intent);
      expect(entry.status === "accepted" || entry.status === "repaired").toBe(true);
    }
  });

  it("uses the selected alternate groove for symbolic candidates without changing validation provenance", async () => {
    const plan = planGeneration(normalizeIntent({ ...intent, length: 32 }), doc);
    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      2,
      true,
    );

    expect(failures).toEqual([]);
    expect(entries).toHaveLength(2);
    const experimental = entries.find((entry) => entry.search?.lane === "experimental");
    expect(experimental?.search?.family).toBe("alternate-groove");
    expect(experimental?.search?.melodyFamily).toBe("evolving-hook");
    expect(experimental?.search?.grooveId).not.toBe(plan.groove.id);
    expect(experimental?.pattern.generation?.grooveId).toBe(experimental?.search?.grooveId);
    expect(experimental?.pattern.generation?.intent).toEqual(plan.intent);
    expect(experimental?.status === "accepted" || experimental?.status === "repaired").toBe(true);

    const leadTrackIds = new Set(plan.rolePlans.lead.targetTrackIds);
    const targetInstrumentTracks = doc.tracks.filter(
      (track) => track.kind === "instrument" && leadTrackIds.has(track.id),
    );
    expect(targetInstrumentTracks.length).toBeGreaterThan(0);
    const leadTrack =
      targetInstrumentTracks.find((track) => track.name.toLowerCase().includes("lead")) ??
      targetInstrumentTracks[2 % targetInstrumentTracks.length];
    expect(leadTrack).toBeDefined();
    const leadNotes = experimental?.pattern.notes?.[leadTrack!.id] ?? [];
    const barTicks = 16 * STEP_TICKS;
    const motifInBar = (bar: number) =>
      leadNotes
        .filter((note) => note.start >= bar * barTicks && note.start < (bar + 1) * barTicks)
        .map(({ start, pitch, duration, velocity }) => ({ start: start - bar * barTicks, pitch, duration, velocity }));
    expect(motifInBar(0).length).toBeGreaterThan(0);
    const firstMotif = motifInBar(0);
    const secondMotif = motifInBar(1);
    expect(secondMotif.length).toBeGreaterThan(0);
    expect(secondMotif.length).toBeGreaterThanOrEqual(firstMotif.length - 1);
    expect(secondMotif.slice(0, -1)).toEqual(firstMotif.slice(0, secondMotif.length - 1));
    expect(secondMotif.length < firstMotif.length || secondMotif.at(-1)!.duration < firstMotif.at(-1)!.duration).toBe(
      true,
    );
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
      const stripIds = (notes: (typeof first.entries)[number]["pattern"]["notes"]) =>
        JSON.stringify(notes, (key, value) => (key === "id" ? undefined : value));
      expect(stripIds(first.entries[index].pattern.notes)).toBe(stripIds(second.entries[index].pattern.notes));
    }
  });

  it("shrink-to-zero on prior failure — never throws", async () => {
    runPriorGridMock.mockResolvedValue({ ok: false, probs: null, source: "fallback" });
    const plan = planGeneration(priorIntent, doc);
    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      1,
    );
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

  it("keeps unsupported groove genres on the template path instead of aliasing them to house", async () => {
    const drillIntent = normalizeIntent({
      genre: "drill",
      seed: "unsupported-prior-genre",
      candidateCount: 0,
      symbolicCandidates: 1,
      roles: ["drums", "bass", "chords", "lead"],
    });
    const plan = planGeneration(drillIntent, doc);
    const { entries } = await symbolicPriorProvider.collectCandidates(plan, { project: doc, mode: "apply" }, 0);
    expect(runPriorGridMock).not.toHaveBeenCalled();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("template");
    const drumRows = Object.values(entries[0].pattern.rows);
    expect(drumRows.length).toBeGreaterThan(0);
    for (const row of drumRows) expect(row.length).toBe(16);
  });

  // Guards the coverage gap the pinned `style: "deep"` fixture above hides.
  // The v1 drum prior only answers for grooves in its frozen one-hot vocab, so
  // any in-genre-but-out-of-vocab groove silently falls back to template
  // drums. That is the correct safe behaviour (a missing prior must never
  // fabricate a bad grid), but it is invisible unless it is asserted here.
  it("degrades an in-genre but out-of-vocabulary groove to template instead of guessing", async () => {
    const afropopIntent = normalizeIntent({
      genre: "house",
      style: "afropop",
      seed: "out-of-vocab-groove",
      length: 16,
      candidateCount: 0,
      symbolicCandidates: 1,
      roles: ["drums", "bass", "chords", "lead"],
    });
    expect((PRIOR_STYLE_VOCAB as readonly string[]).includes("house.afropop")).toBe(false);

    const plan = planGeneration(afropopIntent, doc);
    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      0,
    );
    expect(failures).toEqual([]);
    // The prior client is never consulted for a style it was not trained on.
    expect(runPriorGridMock).not.toHaveBeenCalled();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("template");
    // Still a usable pattern: every drum row is shaped for the step count.
    const drumRows = Object.values(entries[0].pattern.rows);
    expect(drumRows.length).toBeGreaterThan(0);
    for (const row of drumRows) expect(row.length).toBe(16);
  });
});

describe("async pipeline integration", () => {
  it("merges symbolic candidates into the ranked bank with diagnostics", async () => {
    const doc = testDoc();
    const result = await (
      await import("../src/intent/pipeline")
    ).generateAsyncResult(
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
