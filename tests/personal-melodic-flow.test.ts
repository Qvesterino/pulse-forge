import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runPersonalTraining } from "../src/intent/personal-melodic-flow";
import { getPersonalModel } from "../src/persistence/PersonalModelRepository";
import { FAVORITES_LEDGER_KEY } from "../src/intent/favorites";
import { openDb, STORE_PERSONAL_MODELS, tx } from "../src/persistence/db";
import { PERSONAL_MIN_ENTRIES } from "../src/intent/personal-melodic-trainer";
import type { FavoriteLedgerEntry } from "../src/intent/favorites-core";
import type { PersonalTrainingRun } from "../src/intent/personal-melodic-flow";

/**
 * W3 — the one-click personalization flow.
 *
 * The flow is the thing the UI button calls, so its contract is the honesty
 * contract: never install when the ledger is too small, never install when the
 * shipped artifact cannot be read, and report the refusal reason in words.
 * The manifest + ONNX fetch are stubbed (no network in unit tests).
 */

const MANIFEST = {
  kind: "melodic-v2",
  modelPath: "/models/symbolic-melodic-v2.onnx",
  modelHash: "flow-test-hash",
  // The flow re-reads the manifest on disk and the DISK values win, so the
  // caller's copy here is deliberately wrong — that is the cross-check.
  featureCount: 29,
  degreeClasses: 8,
  durationClasses: 4,
  hidden: [64, 32] as const,
};

const realFetch = globalThis.fetch;

function ledgerEntry(index: number): FavoriteLedgerEntry {
  const root = 0;
  const majorIntervals = [0, 2, 4, 5, 7, 9, 11];
  const notes = [];
  for (let n = 0; n < 6; n++) {
    const degree = (n + index) % 7;
    const pitch = 3 * 12 + root + majorIntervals[degree];
    notes.push({ pitch, start: n * 240, duration: 240, velocity: 0.8 });
  }
  return {
    savedAt: index,
    seed: `flow-${index}`,
    genre: "house",
    grooveId: "house.rolling",
    energy: 0.7,
    density: 0.5,
    complexity: 0.5,
    variation: 0.3,
    padIds: [],
    padNames: [],
    rows: { "0": [1, 0, 0, 0] },
    style: "rolling",
    key: "C Major",
    // v1-shape melodic notes are converted by favoritesToMelodicSamples.
    melodic: [{ role: "bass", trackName: "Bass", notes }],
  } as unknown as FavoriteLedgerEntry;
}

/**
 * Stub fetch: serve the REAL shipped v2 manifest + real ONNX bytes so the
 * flow exercises the true de-transposition and training path.
 */
function installFetchStub(): void {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const bytes = readFileSync(path.resolve("public", "models", "symbolic-melodic-v2.onnx"));
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("symbolic-melodic-v2.manifest.json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            kind: "melodic-v2",
            modelPath: "/models/symbolic-melodic-v2.onnx",
            modelHash: "flow-test-hash",
            featureVersion: "melodic-features-v2",
            featureCount: 41,
            degreeClasses: 8,
            durationClasses: 4,
            hidden: [64, 32],
          }),
          { status: 200 },
        ),
      );
    }
    if (url.includes("symbolic-melodic-v2.onnx")) {
      return Promise.resolve(new Response(bytes, { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

async function setLedger(entries: FavoriteLedgerEntry[]): Promise<void> {
  localStorage.setItem(FAVORITES_LEDGER_KEY, JSON.stringify(entries));
}

async function clearPersonalStore(): Promise<void> {
  const db = await openDb();
  await tx(db, STORE_PERSONAL_MODELS, "readwrite", (store) => {
    store.clear();
  });
}

describe("personal training flow", () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearPersonalStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("refuses with a human summary when there are not enough ★", async () => {
    await setLedger([ledgerEntry(0)]);
    const run = await runPersonalTraining({ ...MANIFEST, featureCount: 29 });
    expect(run.installed).toBe(false);
    expect(run.summary).toContain(String(PERSONAL_MIN_ENTRIES));
    expect(run.status.ok).toBe(false);
    if (!run.status.ok) expect(run.status.reason).toBe("not-enough-favorites");
  });

  it("installs a personal model when the proof clears the bar", async () => {
    installFetchStub();
    await setLedger(Array.from({ length: 6 }, (_, i) => ledgerEntry(i)));
    const run = await runPersonalTraining(MANIFEST);
    // The proof on these synthetic ★ rows is decisive (personal learns them,
    // the shipped prior does not), so the flow MUST install.
    expect(run.installed).toBe(true);
    const stored = await getPersonalModel({ kind: "melodic-v2", baseModelHash: "flow-test-hash" });
    expect(stored).not.toBeNull();
    expect(stored!.favoritesUsed).toBe(6);
    expect(stored!.report?.topOneCases).toBeGreaterThan(0);
    expect(stored!.report!.topOneWins).toBeGreaterThan(stored!.report!.topOneCases / 2);
  });

  it("never installs when the shipped ONNX cannot be fetched", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("nope", { status: 404 })));
    await setLedger(Array.from({ length: 6 }, (_, i) => ledgerEntry(i)));
    const run = await runPersonalTraining(MANIFEST);
    expect(run.installed).toBe(false);
    expect(run.status.ok).toBe(false);
    if (!run.status.ok) expect(run.status.reason).toBe("shipped-model-mismatch");
  });

  it("builds the ranker preference groups from the same ledger", async () => {
    installFetchStub();
    await setLedger(Array.from({ length: 5 }, (_, i) => ledgerEntry(i)));
    const run = await runPersonalTraining(MANIFEST);
    expect(run.ranker).not.toBeNull();
    expect(run.ranker!.datasetVersion).toBe("intent-ranker-favorites.v1");
    expect(run.ranker!.sourceEntries).toBe(5);
    // Every group carries the favourite as its winner.
    for (const group of run.ranker!.groups) {
      expect(group.favorite).toBe(true);
      expect(typeof group.winnerIndex).toBe("number");
    }
  });

  it("always returns a summary string the UI can show", async () => {
    await setLedger([]);
    const run: PersonalTrainingRun = await runPersonalTraining(MANIFEST);
    expect(typeof run.summary).toBe("string");
    expect(run.summary.length).toBeGreaterThan(0);
  });
});
