import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

function createPreviewEngine(doc: ProjectDocument, trackId: string, fxId: string, setParameter = vi.fn()) {
  const engine = Object.create(AudioEngine.prototype) as AudioEngine;
  const internals = engine as unknown as {
    doc: ProjectDocument;
    trackNodes: Map<string, { fx: { runtimes: Map<string, { setParameter: typeof setParameter }> } }>;
    groupNodes: Map<string, { fx: { runtimes: Map<string, { setParameter: typeof setParameter }> } }>;
    returnNodes: Map<string, { fx: { runtimes: Map<string, { setParameter: typeof setParameter }> } }>;
  };
  internals.doc = doc;
  internals.trackNodes = new Map([[trackId, { fx: { runtimes: new Map([[fxId, { setParameter }]]) } }]]);
  internals.groupNodes = new Map();
  internals.returnNodes = new Map();
  return { engine, setParameter };
}

function reverbProject() {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
  track.effects = [{ id: "fx-reverb", type: "reverb", bypassed: false, params: { mix: 0.3, decay: 1.8, tone: 6000 } }];
  return { doc, track };
}

describe("AudioEngine effect intent preview lease", () => {
  it("auditions validated values and restores the latest document values", () => {
    const { doc, track } = reverbProject();
    const { engine, setParameter } = createPreviewEngine(doc, track.id, "fx-reverb");
    const onEnded = vi.fn();

    expect(engine.beginEffectIntentPreview(track.id, "fx-reverb", { mix: 0.6, decay: 2.2 }, onEnded)).toBe(true);
    expect(setParameter.mock.calls).toEqual([["mix", 0.6], ["decay", 2.2]]);

    const changedDoc = structuredClone(doc);
    changedDoc.tracks.find((candidate) => candidate.id === track.id)!.effects[0].params.mix = 0.42;
    changedDoc.tracks.find((candidate) => candidate.id === track.id)!.effects[0].params.decay = 2;
    engine.cancelEffectIntentPreview(changedDoc, "projectChanged");

    expect(setParameter.mock.calls.slice(2)).toEqual([["mix", 0.42], ["decay", 2]]);
    expect(onEnded).toHaveBeenCalledWith("projectChanged");
  });

  it("rejects unknown or invalid parameter values before touching the runtime", () => {
    const { doc, track } = reverbProject();
    const { engine, setParameter } = createPreviewEngine(doc, track.id, "fx-reverb");

    expect(engine.beginEffectIntentPreview(track.id, "fx-reverb", { madeUpParameter: 1 })).toBe(false);
    expect(engine.beginEffectIntentPreview(track.id, "fx-reverb", { mix: Number.NaN })).toBe(false);
    expect(setParameter).not.toHaveBeenCalled();
  });

  it("ends the audition automatically when transport starts", () => {
    const { doc, track } = reverbProject();
    const { engine, setParameter } = createPreviewEngine(doc, track.id, "fx-reverb");
    const onEnded = vi.fn();

    expect(engine.beginEffectIntentPreview(track.id, "fx-reverb", { mix: 0.6 }, onEnded)).toBe(true);
    engine.transportStarted(0, 0);

    expect(setParameter.mock.calls).toEqual([["mix", 0.6], ["mix", 0.3]]);
    expect(onEnded).toHaveBeenCalledWith("transportStarted");
  });

  it("reports a restore failure instead of claiming the audition was cancelled cleanly", () => {
    const { doc, track } = reverbProject();
    const setParameter = vi.fn((_id: string, value: number) => {
      if (value === 0.3) throw new Error("runtime rejected original value");
    });
    const { engine } = createPreviewEngine(doc, track.id, "fx-reverb", setParameter);
    const onEnded = vi.fn();

    expect(engine.beginEffectIntentPreview(track.id, "fx-reverb", { mix: 0.6 }, onEnded)).toBe(true);
    expect(engine.cancelEffectIntentPreview()).toBe(false);

    expect(onEnded).toHaveBeenCalledWith("restoreFailed");
  });
});
