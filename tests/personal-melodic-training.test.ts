import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  trainPersonalModel,
  shouldInstallPersonalModel,
  type PersonalProof,
} from "../src/intent/personal-melodic-training";
import { PERSONAL_MIN_ENTRIES } from "../src/intent/personal-melodic-trainer";
import { buildMelodicFeatureRow, type MelodicGenre } from "../src/ai/symbolic/melodic-features";
import type { FavoriteLedgerEntry } from "../src/intent/favorites-core";

/**
 * W3 — the personal-prior training flow.
 *
 * The flow's job is to be HONEST: it must refuse a model that does not beat
 * the shipped prior on the user's own ★ rows, and it must produce the same
 * model twice from the same ledger. These tests pin both — the install gate is
 * the only thing standing between a user and a worse-sounding prior.
 */

const ONNX_PATH = path.resolve("public", "models", "symbolic-melodic-v1.onnx");
const MANIFEST = {
  kind: "melodic",
  featureCount: 29,
  degreeClasses: 8,
  durationClasses: 4,
  hidden: [64, 32] as const,
  modelHash: "test-hash-melodic-v1",
};

/** A ledger built from the real feature builder, so widths always line up. */
function ledgerWith(count: number): FavoriteLedgerEntry[] {
  const entries: FavoriteLedgerEntry[] = [];
  for (let i = 0; i < count; i++) {
    const noteCount = 6 + (i % 4);
    const root = 0;
    const majorIntervals = [0, 2, 4, 5, 7, 9, 11];
    const notes = [];
    for (let n = 0; n < noteCount; n++) {
      const degree = (n * 2 + i) % 7;
      const pitch = 3 * 12 + root + majorIntervals[degree];
      notes.push({ pitch, start: n * 240, duration: 240, velocity: 0.8 });
    }
    entries.push({
      seed: `entry-${i}`,
      intent: { genre: "house", energy: 0.7, density: 0.5 },
      key: "C Major" as FavoriteLedgerEntry["key"],
      createdAt: 1,
      rows: { "0": [1, 0, 0, 0] },
      melodic: [{ role: "bass", trackName: "Bass", notes }],
    } as unknown as FavoriteLedgerEntry);
  }
  return entries;
}

function shippedBytes(): Uint8Array {
  return new Uint8Array(readFileSync(ONNX_PATH));
}

describe("personal training — refusal paths", () => {
  it("refuses with a clear minimum when the ledger is too small", () => {
    const status = trainPersonalModel({
      shippedOnnx: shippedBytes(),
      manifest: MANIFEST,
      entries: ledgerWith(PERSONAL_MIN_ENTRIES - 1),
    });
    expect(status.ok).toBe(false);
    if (!status.ok && status.reason === "not-enough-favorites") {
      expect(status.needed).toBe(PERSONAL_MIN_ENTRIES);
      expect(status.have).toBe(PERSONAL_MIN_ENTRIES - 1);
    }
  });

  it("refuses when the shipped bytes do not match the manifest", () => {
    const status = trainPersonalModel({
      shippedOnnx: new Uint8Array([1, 2, 3, 4, 5]),
      manifest: MANIFEST,
      entries: ledgerWith(PERSONAL_MIN_ENTRIES),
    });
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toBe("shipped-model-mismatch");
  });

  it("refuses when no entry carries a usable key (inversion impossible)", () => {
    const entries = ledgerWith(PERSONAL_MIN_ENTRIES).map((entry) => ({ ...entry, key: null }));
    const status = trainPersonalModel({ shippedOnnx: shippedBytes(), manifest: MANIFEST, entries });
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toBe("no-usable-entries");
  });
});

describe("personal training — happy path", () => {
  it("trains a valid payload and reports an A/B proof", () => {
    const status = trainPersonalModel({
      shippedOnnx: shippedBytes(),
      manifest: MANIFEST,
      entries: ledgerWith(PERSONAL_MIN_ENTRIES),
      epochs: 2,
    });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.payload.version).toBe(1);
    expect(status.payload.featureCount).toBe(29);
    expect(status.payload.w0.length).toBe(29 * 64);
    expect(status.proof.cases).toBeGreaterThan(0);
    expect(status.proof.personalHits).toBeGreaterThanOrEqual(0);
    expect(status.proof.shippedHits).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic: the same ledger and shipped model produce the same payload", () => {
    const entries = ledgerWith(PERSONAL_MIN_ENTRIES);
    const a = trainPersonalModel({ shippedOnnx: shippedBytes(), manifest: MANIFEST, entries, epochs: 3 });
    const b = trainPersonalModel({ shippedOnnx: shippedBytes(), manifest: MANIFEST, entries, epochs: 3 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Same rows ⇒ same weights (no RNG on the personal path).
    expect(a.payload.w0).toEqual(b.payload.w0);
    expect(a.payload.bt).toEqual(b.payload.bt);
  });
});

describe("personal training — install gate (the honesty rule)", () => {
  const proof = (personalHits: number, shippedHits: number, cases = 10): PersonalProof => ({
    personalHits,
    shippedHits,
    cases,
  });

  it("installs when the personal model clears 70% AND beats the shipped prior", () => {
    const verdict = shouldInstallPersonalModel(proof(8, 5), PERSONAL_MIN_ENTRIES);
    expect(verdict.ok).toBe(true);
  });

  it("refuses below the 70% bar", () => {
    const verdict = shouldInstallPersonalModel(proof(6, 3), PERSONAL_MIN_ENTRIES);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("70");
  });

  it("refuses when the personal model does not beat the shipped prior", () => {
    const verdict = shouldInstallPersonalModel(proof(8, 8), PERSONAL_MIN_ENTRIES);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("beat");
  });

  it("refuses with no ★ to prove against", () => {
    const verdict = shouldInstallPersonalModel(proof(0, 0, 0), PERSONAL_MIN_ENTRIES);
    expect(verdict.ok).toBe(false);
  });

  it("refuses below the minimum entry count even with a great proof", () => {
    const verdict = shouldInstallPersonalModel(proof(10, 1), PERSONAL_MIN_ENTRIES - 1);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("★");
  });
});

describe("favorite conversion parity (the training labels)", () => {
  it("produces v1-width rows from the recorded key", () => {
    // Sanity for the feature builder the favorites path imports — the personal
    // trainer must see the same row width the shipped model expects.
    const row = buildMelodicFeatureRow({
      genre: "house" as MelodicGenre,
      role: "bass",
      startStep: 0,
      prevDegree: -1,
      prevDuration: 2,
      prevPrevDegree: -1,
    });
    expect(row.length).toBe(29);
  });
});
