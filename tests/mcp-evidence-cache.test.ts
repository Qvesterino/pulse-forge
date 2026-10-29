import { describe, expect, it, vi } from "vitest";
import { cachedEvidence, clearEvidenceCache, evidenceCacheKey, type EvidenceSource } from "../src/mcp/evidence-cache";
import { mcpRenderSummary } from "../src/mcp/render-summary";
import { addArrangementClip } from "../src/commands/commands";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * E10 (MUG-10) — the revision-keyed evidence cache.
 *
 * The contract under test: a diagnose → fix → verify loop pays the render
 * cost ONCE per document revision, and a STALE ANSWER IS IMPOSSIBLE — the
 * cache key contains the revision (ADR 0065), so any edit lands under a new
 * key and the old envelope is unreachable. Pass criteria from the audit
 * experiment: ≥3× fewer computes on a repeated-read loop (measured as render
 * invocations, which is what dominates wall time) and ZERO stale hits across
 * a mutation fuzz (every returned number matches the freshly-computed value
 * for the current revision).
 *
 * The renderer is stubbed (no vitest spec renders audio — audible parity
 * belongs to the real-browser gate) with revision-derived buffer levels, so
 * "stale" has a hard answer: a served envelope whose peak does not match the
 * current revision's level IS a stale hit, and the fuzz asserts there are none.
 */

const SR = 44100;

function makeStereoBuffer(lengthSamples: number, level: number) {
  const left = new Float32Array(lengthSamples).fill(level);
  const right = new Float32Array(lengthSamples).fill(level);
  return {
    length: lengthSamples,
    sampleRate: SR,
    numberOfChannels: 2,
    getChannelData: (channel: number) => (channel === 0 ? left : right),
  };
}

interface FakeStoreOptions {
  doc: ProjectDocument;
  revision?: number;
  withRevision?: boolean;
}

function makeStore({ doc, revision = 0, withRevision = true }: FakeStoreOptions) {
  const state = { doc, revision };
  const store = {
    getDoc: () => state.doc,
    ...(withRevision ? { getRevision: () => state.revision } : {}),
  };
  return { store, state };
}

describe("evidence cache unit contract", () => {
  it("a store without a revision disables caching — every call computes, nothing is stored", async () => {
    const { store } = makeStore({ doc: testDoc(), withRevision: false });
    let computes = 0;
    const first = await cachedEvidence(store, "family", { a: 1 }, async () => ({ n: ++computes }));
    const second = await cachedEvidence(store, "family", { a: 1 }, async () => ({ n: ++computes }));
    expect(first.cache).toBe("disabled");
    expect(second.cache).toBe("disabled");
    expect(computes).toBe(2);
    expect(evidenceCacheKey(store, "family", {})).toBeNull();
  });

  it("an identical request at the same revision is a HIT; the compute runs once", async () => {
    const { store } = makeStore({ doc: testDoc() });
    let computes = 0;
    await cachedEvidence(store, "family", { a: 1 }, async () => ({ n: ++computes }));
    const again = await cachedEvidence(store, "family", { a: 1 }, async () => ({ n: ++computes }));
    expect(again.cache).toBe("hit");
    expect(computes).toBe(1);
  });

  it("a revision bump changes the key — the old envelope is unreachable and the fresh value is served", async () => {
    const { store, state } = makeStore({ doc: testDoc() });
    const read = async () => cachedEvidence(store, "family", { k: 1 }, async () => ({ revision: state.revision }));
    const first = await read();
    expect(first.data.revision).toBe(0);
    state.revision = 1;
    const second = await read();
    expect(second.cache).toBe("miss");
    expect(second.data.revision).toBe(1);
    const repeat = await read();
    expect(repeat.cache).toBe("hit");
    expect(repeat.data.revision).toBe(1);
  });

  it("two stores holding the same project id at the same revision NEVER share envelopes", async () => {
    const doc = testDoc();
    const a = makeStore({ doc });
    const b = makeStore({ doc });
    const read = (store: EvidenceSource, level: number) =>
      cachedEvidence(store, "family", { k: 1 }, async () => ({ level }));
    const fromA = await read(a.store, 0.25);
    const fromB = await read(b.store, 0.75);
    expect(fromA.data.level).toBe(0.25);
    expect(fromB.data.level).toBe(0.75);
    expect(fromB.cache).toBe("miss");
  });

  it("a FAILED compute is evicted — the next call retries instead of replaying the rejection", async () => {
    const { store } = makeStore({ doc: testDoc() });
    let attempts = 0;
    const read = () =>
      cachedEvidence(store, "family", { k: 1 }, async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("render exploded");
        return { ok: true };
      });
    await expect(read()).rejects.toThrow("render exploded");
    const retry = await read();
    expect(retry.cache).toBe("miss");
    expect(retry.data).toEqual({ ok: true });
  });

  it("concurrent identical calls coalesce into ONE compute", async () => {
    const { store } = makeStore({ doc: testDoc() });
    let computes = 0;
    const read = () =>
      cachedEvidence(store, "family", { k: 1 }, async () => {
        computes += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { computes };
      });
    const [a, b, c] = await Promise.all([read(), read(), read()]);
    expect(computes).toBe(1);
    expect(a.cache).toBe("miss");
    expect(b.cache).toBe("hit");
    expect(c.cache).toBe("hit");
  });

  it("the LRU bound evicts the oldest entry (64 envelopes per store)", async () => {
    const { store } = makeStore({ doc: testDoc() });
    clearEvidenceCache(store);
    let computes = 0;
    const read = (k: number) => cachedEvidence(store, "family", { k }, async () => ({ n: ++computes }));
    for (let k = 0; k < 64; k += 1) await read(k);
    expect(computes).toBe(64);
    await read(100); // evicts key 0
    expect(computes).toBe(65);
    const evicted = await read(0); // must recompute, not serve a dead entry
    expect(evicted.cache).toBe("miss");
    expect(evicted.data.n).toBe(66);
    // Each miss+insert evicts the next-oldest entry (a cascade): 0 then 1.
    const reinserted = await read(1); // evicted by read(0)'s insert — miss; its insert evicts key 2
    expect(reinserted.cache).toBe("miss");
    const resident = await read(1); // hit — nothing was inserted after it
    expect(resident.cache).toBe("hit");
  });
});

describe("render summary through the cache (E10 loop contract)", () => {
  function docWithClips(): ProjectDocument {
    const base = testDoc();
    const sceneId = base.scenes[0]!.id;
    return addArrangementClip(base, sceneId, 0, 4).execute(base);
  }

  function makeServices(doc: ProjectDocument, revisionRef: { current: number }) {
    return {
      store: { getDoc: () => doc, getRevision: () => revisionRef.current },
      bank: { add: vi.fn(), remove: vi.fn(), get: vi.fn() },
    } as never;
  }

  it("diagnose → fix → verify: three reads at one revision render ONCE (≥3× compute cut)", async () => {
    const mocks = vi.hoisted(() => ({ render: vi.fn() }));
    vi.doMock("../src/rendering/renderer", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/rendering/renderer")>();
      return { ...actual, renderProject: mocks.render };
    });
    try {
      const doc = docWithClips();
      const revisionRef = { current: 7 };
      const services = makeServices(doc, revisionRef);
      mocks.render.mockImplementation(
        async () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(makeStereoBuffer(Math.ceil(8 * (60 / 124) * SR), 0.3)), 50),
          ),
      );

      const first = await mcpRenderSummary(services, { scope: "master" });
      const second = await mcpRenderSummary(services, { scope: "master" });
      const third = await mcpRenderSummary(services, { scope: "master" });

      expect(mocks.render).toHaveBeenCalledTimes(1); // 3-step loop, ONE render
      expect(first.cache).toBe("miss");
      expect(second.cache).toBe("hit");
      expect(third.cache).toBe("hit");
      expect(second.master).toEqual(first.master); // identical evidence, no recompute
      // The ≥3× compute cut is asserted structurally above (1 render for a
      // 3-read loop; renders dominate wall time). A wall-clock assertion here
      // would measure the test environment's module loading, not the cache.
    } finally {
      vi.doUnmock("../src/rendering/renderer");
      vi.resetModules();
    }
  });

  it("mutation fuzz: zero stale hits across ten revisions — every number matches its revision", async () => {
    const mocksFuzz = vi.hoisted(() => ({ render: vi.fn() }));
    vi.doMock("../src/rendering/renderer", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/rendering/renderer")>();
      return { ...actual, renderProject: mocksFuzz.render };
    });
    try {
      const doc = docWithClips();
      const revisionRef = { current: 0 };
      const services = makeServices(doc, revisionRef);
      let currentLevel = 0.1;

      mocksFuzz.render.mockImplementation(async () => {
        // The render observes the CURRENT simulated mix — one 8 s bar-4 doc at 124 bpm.
        await Promise.resolve();
        return makeStereoBuffer(Math.ceil(8 * (60 / 124) * SR), currentLevel);
      });

      for (let revision = 1; revision <= 10; revision += 1) {
        // "The agent applies a fix": the mix changes, the revision moves.
        currentLevel = Math.round((0.1 + revision * 0.05) * 1000) / 1000;
        revisionRef.current = revision;
        const fresh = await mcpRenderSummary(services, { scope: "master" });
        const cached = await mcpRenderSummary(services, { scope: "master" });

        const expectedPeak = Number((20 * Math.log10(currentLevel)).toFixed(1));
        // ZERO STALE HITS: both reads report EXACTLY the current revision's level.
        expect(fresh.master?.peakDb).toBe(expectedPeak);
        expect(cached.master?.peakDb).toBe(expectedPeak);
        expect(cached.cache).toBe("hit");
        expect(fresh.cache).toBe("miss");
      }
      // Exactly one compute per revision: ten fixes, ten renders, zero repeats.
      expect(mocksFuzz.render).toHaveBeenCalledTimes(10);
    } finally {
      vi.doUnmock("../src/rendering/renderer");
      vi.resetModules();
    }
  });
});
