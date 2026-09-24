import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import type { EffectRuntime } from "../src/effects/types";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * Regression: AudioEngine.previewFxParam must skip degraded (bypass) runtimes.
 *
 * Background: when a flagship plugin's AudioWorklet module hasn't loaded yet,
 * `bypassRuntime` (src/effects/registry.ts:279) installs a transparent
 * 1:1 passthrough whose `setParameter` is a deliberate no-op. Calling
 * previewFxParam against it was silently swallowing the slider-drag
 * preview while the panel still visually moved the control — the user
 * saw the gesture but heard no change, with no diagnostic. Suppressing
 * the call at the engine level makes the behavior explicit, keeps the
 * commit path unaffected (doc still receives the final value, syncFxParams
 * replays it once the real runtime installs), and protects every caller
 * (FxEq/Ultina/KASKÁDA/MorphDynamics panels + renderer) at once.
 */
function createPreviewEngine(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  runtime: EffectRuntime,
) {
  const engine = Object.create(AudioEngine.prototype) as AudioEngine;
  const internals = engine as unknown as {
    doc: ProjectDocument;
    trackNodes: Map<string, { fx: { runtimes: Map<string, EffectRuntime> } }>;
    groupNodes: Map<string, { fx: { runtimes: Map<string, EffectRuntime> } }>;
    returnNodes: Map<string, { fx: { runtimes: Map<string, EffectRuntime> } }>;
  };
  internals.doc = doc;
  internals.trackNodes = new Map([[trackId, { fx: { runtimes: new Map([[fxId, runtime]]) } }]]);
  internals.groupNodes = new Map();
  internals.returnNodes = new Map();
  return { engine };
}

function fxeqProject() {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
  track.effects = [{ id: "fx-fxeq", type: "fxeq", bypassed: false, params: { bandCount: 6 } }];
  return { doc, track };
}

describe("AudioEngine.previewFxParam — degraded runtime suppression", () => {
  it("forwards to a real (non-degraded) runtime as before", () => {
    const { doc, track } = fxeqProject();
    const setParameter = vi.fn();
    const { engine } = createPreviewEngine(doc, track.id, "fx-fxeq", {
      input: {} as AudioNode,
      output: {} as AudioNode,
      setParameter,
      dispose: vi.fn(),
    });

    engine.previewFxParam(track.id, "fx-fxeq", "band1.gainDb", -3.5);

    expect(setParameter).toHaveBeenCalledTimes(1);
    expect(setParameter).toHaveBeenCalledWith("band1.gainDb", -3.5);
  });

  it("does NOT call setParameter on a degraded (bypass) runtime", () => {
    const { doc, track } = fxeqProject();
    const setParameter = vi.fn();
    const { engine } = createPreviewEngine(doc, track.id, "fx-fxeq", {
      input: {} as AudioNode,
      output: {} as AudioNode,
      setParameter,
      dispose: vi.fn(),
      degraded: true,
      degradedReason: "AudioWorklet unavailable — PRISM is bypassed (1:1 signal)",
    });

    engine.previewFxParam(track.id, "fx-fxeq", "band1.gainDb", -3.5);
    engine.previewFxParam(track.id, "fx-fxeq", "crossoverFreq2", 250);
    engine.previewFxParam(track.id, "fx-fxeq", "mix", 0.8);

    expect(setParameter).not.toHaveBeenCalled();
  });

  it("does NOT throw when the runtime is missing (chain rebuild window)", () => {
    const doc = createProjectFromTemplate("house");
    const { engine } = createPreviewEngine(doc, "ghost-track", "ghost-fx", {
      input: {} as AudioNode,
      output: {} as AudioNode,
      setParameter: vi.fn(),
      dispose: vi.fn(),
    });

    // Track not registered — simulates the brief dispose→clear→rebuild window
    // in rebuildFxChain (AudioEngine.ts:1798–1901), where state.runtimes.get
    // returns undefined between dispose() and the new runtime being inserted.
    expect(() => engine.previewFxParam("ghost-track", "ghost-fx", "mix", 0.5)).not.toThrow();
  });

  it("doc commit path is unaffected — engine.previewFxParam only handles live audio", () => {
    // previewFxParam is fire-and-forget and must NOT touch the document.
    // The panel still calls onParam → setFxEqParam → store.execute for the
    // committed value, and syncFxParams replays the doc values into the
    // real runtime once the worklet lands. This test pins the contract:
    // previewFxParam does not mutate doc.tracks[0].effects[0].params.
    const { doc, track } = fxeqProject();
    const paramsBefore = JSON.stringify(track.effects[0].params);
    const { engine } = createPreviewEngine(doc, track.id, "fx-fxeq", {
      input: {} as AudioNode,
      output: {} as AudioNode,
      setParameter: vi.fn(),
      dispose: vi.fn(),
      degraded: true,
    });

    engine.previewFxParam(track.id, "fx-fxeq", "band1.gainDb", -12);
    engine.previewFxParam(track.id, "fx-fxeq", "mix", 1);

    expect(JSON.stringify(track.effects[0].params)).toBe(paramsBefore);
  });
});
