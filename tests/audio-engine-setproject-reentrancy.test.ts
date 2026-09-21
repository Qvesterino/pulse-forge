import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";
import { MeterRing } from "../src/audio-engine/MeterRing";
import { PeakHold } from "../src/audio-engine/metering";

/**
 * AudioEngine is a Web Audio graph that requires a real `BaseAudioContext`
 * (jsdom provides none) and dozens of plugin worklets. `setProject()` itself
 * is synchronous in shape, but its post-graph-rebuild path is driven by an
 * async worklet load (`queueWorkletRefresh` → `loadCoreWorklets().then(...)`
 * → `queueFxRebuild` → `syncProject(this.doc)`). The bug we're pinning: when
 * a re-entrant `setProject(docB)` lands while the doc A refresh is in
 * flight, the late callback runs against doc B's runtime graph with doc A's
 * stale effect-ID assumptions.
 *
 * We don't need a real `AudioContext` to test the serialization contract —
 * `syncProject` is stubbed, `cancelEffectIntentPreview` early-returns on the
 * empty preview path, and `this.ctx` is just a truthy placeholder so the
 * `if (this.ctx) this.syncProject(target)` guard fires. The
 * `Object.create(AudioEngine.prototype)` shape mirrors
 * `tests/audio-engine-effect-intent-preview.test.ts` and avoids the 138 KB
 * constructor graph.
 */

type Internals = {
  ctx: BaseAudioContext | null;
  doc: ProjectDocument | null;
  effectIntentPreview: unknown;
  meterProjectId: string | null;
  stretchProjectId: string | null;
  missedAssets: Set<string>;
  projectPromise: Promise<void> | null;
  projectQueue: ProjectDocument[];
  resetMeterHistory: ReturnType<typeof vi.fn>;
  clearStretchCache: ReturnType<typeof vi.fn>;
  clearWarpCache: ReturnType<typeof vi.fn>;
  syncProject: ReturnType<typeof vi.fn>;
  cancelEffectIntentPreview: ReturnType<typeof vi.fn>;
};

function makeBareEngine() {
  const engine = Object.create(AudioEngine.prototype) as AudioEngine;
  const internals = engine as unknown as Internals;
  // Truthy placeholder — only the `if (this.ctx)` guard inside setProject
  // reads it, so a bare object satisfies the contract without depending on
  // the full BaseAudioContext surface.
  internals.ctx = {} as BaseAudioContext;
  internals.effectIntentPreview = null; // cancelEffectIntentPreview no-ops
  internals.missedAssets = new Set<string>();
  // Stable defaults so the first call doesn't trigger meter/reset paths.
  internals.meterProjectId = "seed";
  internals.stretchProjectId = "seed";
  internals.projectPromise = null;
  internals.projectQueue = [];
  // Stub the body helpers we don't want real instances of.
  internals.resetMeterHistory = vi.fn();
  internals.clearStretchCache = vi.fn();
  internals.clearWarpCache = vi.fn();
  internals.syncProject = vi.fn();
  internals.cancelEffectIntentPreview = vi.fn(() => true);
  // The constructor's class-field initializers don't run for Object.create
  // instances, so setProperty-related fields aren't required here, but
  // keeping meterHistory + peakHold real so a future code-path that touches
  // them doesn't see undefined.
  (engine as unknown as { meterHistoryL: MeterRing }).meterHistoryL = new MeterRing(8);
  (engine as unknown as { meterHistoryR: MeterRing }).meterHistoryR = new MeterRing(8);
  (engine as unknown as { meterLoudnessBlocks: unknown[] }).meterLoudnessBlocks = [];
  (engine as unknown as { masterPeakHold: PeakHold }).masterPeakHold = new PeakHold(0.4);
  return { engine, internals };
}

function docWithId(id: string): ProjectDocument {
  const doc = createProjectFromTemplate("empty");
  doc.id = id;
  return doc;
}

/**
 * Flush enough microtask ticks to settle both the in-flight body and the
 * FIFO drain loop. Each `await Promise.resolve()` queues a microtask; the
 * body itself is async (returns a Promise) so a single tick isn't enough to
 * chain through the queue. Five is empirically enough for the doc → drain
 * → null-out pipeline in this engine.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("AudioEngine.setProject re-entrancy", () => {
  it("serializes back-to-back setProject calls — engine.doc settles on docB", async () => {
    const { engine, internals } = makeBareEngine();
    const docA = docWithId("doc-A");
    const docB = docWithId("doc-B");

    expect(() => {
      engine.setProject(docA);
      engine.setProject(docB);
    }).not.toThrow();

    // Synchronous contract: callers reading engine.doc immediately after
    // the second setProject returns must see docB, not the pending docA.
    expect(internals.doc).toBe(docB);
    // The IIFE is in-flight, so the promise is non-null until the body
    // resolves and the queued doc drains.
    expect(internals.projectPromise).not.toBeNull();
    // docA's body is awaiting its first microtask continuation; docB has
    // already been queued (re-entrant call landed mid-async).
    expect(internals.projectQueue).toEqual([docB]);

    await settle();

    expect(internals.doc).toBe(docB);
    expect(internals.projectPromise).toBeNull();
    expect(internals.projectQueue).toEqual([]);
    // Both bodies ran in order: docA first (started the IIFE), then docB
    // (drained from the queue once docA's body settled).
    expect(internals.syncProject).toHaveBeenCalledTimes(2);
    expect(internals.syncProject.mock.calls[0]?.[0]).toBe(docA);
    expect(internals.syncProject.mock.calls[1]?.[0]).toBe(docB);
  });

  it("coalesces repeated re-entrant calls — only the last queued doc's body runs", async () => {
    const { engine, internals } = makeBareEngine();
    const docA = docWithId("doc-A");
    const docB = docWithId("doc-B");
    const docC = docWithId("doc-C");

    engine.setProject(docA);
    engine.setProject(docB);
    engine.setProject(docC);

    expect(internals.doc).toBe(docC);
    // docB's push was overwritten by docC — only the latest pending doc
    // survives in the queue.
    expect(internals.projectQueue).toEqual([docC]);

    await settle();

    expect(internals.doc).toBe(docC);
    expect(internals.projectPromise).toBeNull();
    expect(internals.projectQueue).toEqual([]);
    // docB is dropped — its effect IDs would have fought the build for
    // docC, so the coalesce rule keeps only the latest push.
    expect(internals.syncProject.mock.calls.map((call) => call[0])).toEqual([docA, docC]);
  });

  it("keeps the promise non-null while a queued doc's body is in-flight", async () => {
    const { engine, internals } = makeBareEngine();
    const docA = docWithId("doc-A");
    const docB = docWithId("doc-B");

    engine.setProject(docA);
    engine.setProject(docB);

    // One microtask is enough to surface docA's body resolution, but the
    // drain loop is now mid-await on runBody(docB), so projectPromise is
    // still non-null and docB is mid-body.
    await Promise.resolve();
    expect(internals.projectPromise).not.toBeNull();
    expect(internals.doc).toBe(docB);
    // Either the drain has already shifted docB (queue empty) or it
    // hasn't yet — both are valid mid-flight states. The only invariant
    // is: projectPromise must still be tracked.
    expect(internals.projectQueue.length).toBeLessThanOrEqual(1);

    await settle();
    expect(internals.projectPromise).toBeNull();
    expect(internals.projectQueue).toEqual([]);
  });
});