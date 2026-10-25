import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../../src/project-model/schema";
import { ProjectStore } from "../../src/store/ProjectStore";
import { setInstrumentParams } from "../../src/commands/instrument";
import { defaultInstrumentParams } from "../../src/instruments/definitions";
import type { InstrumentTrack, ProjectDocument } from "../../src/project-model/types";

/**
 * THE KOPA EDITOR'S COMMIT — one drag, one undo step.
 *
 * The editor paints locally while the pointer moves and writes the document
 * ONCE, when the pointer comes up. That is the whole point of the batch
 * command: a drag that touched four parameters must be ONE undo action, not
 * four. The single-parameter command cannot do that, and the EnvEditor's
 * per-move commits cannot undo a drag at all.
 *
 * The command also owns the CLAMP: a drag that overshoots writes the legal
 * range, and the undo restores exactly what was there — the keys it touched,
 * and nothing else.
 */

function docWithKopa(): { doc: ProjectDocument; trackId: string } {
  const doc = createDefaultProject();
  const base = doc.tracks.find((track) => track.kind === "instrument");
  if (!base) throw new Error("the default project has no instrument track");
  const track: InstrumentTrack = {
    ...(base as InstrumentTrack),
    id: "kopa-track",
    instrument: "kopa",
    name: "KOPA",
    params: { ...defaultInstrumentParams("kopa") },
  };
  return {
    doc: { ...doc, tracks: [track] } as ProjectDocument,
    trackId: track.id,
  };
}

/** The instrument track's parameters (the Track union needs narrowing). */
function paramsOf(doc: ProjectDocument): Record<string, number> {
  const track = doc.tracks.find((candidate): candidate is InstrumentTrack => candidate.kind === "instrument");
  if (!track) throw new Error("no instrument track");
  return track.params;
}

describe("the KOPA editor's commit", () => {
  it("writes several parameters as ONE undo step", () => {
    const { doc, trackId } = docWithKopa();
    const store = new ProjectStore(doc);
    const before = { ...paramsOf(store.doc) };

    store.execute(
      setInstrumentParams(store.doc, trackId, { bodyDecay: 0.8, tailLevel: 0.6, clickLevel: 0.2 }, "KOPA shape"),
    );
    const edited = paramsOf(store.doc);
    expect(edited.bodyDecay).toBe(0.8);
    expect(edited.tailLevel).toBe(0.6);
    expect(edited.clickLevel).toBe(0.2);

    // ONE undo for the whole drag.
    store.undo();
    const restored = paramsOf(store.doc);
    expect(restored.bodyDecay).toBe(before.bodyDecay);
    expect(restored.tailLevel).toBe(before.tailLevel);
    expect(restored.clickLevel).toBe(before.clickLevel);
  });

  it("undoes exactly the keys it touched — and leaves the rest alone", () => {
    const { doc, trackId } = docWithKopa();
    const store = new ProjectStore(doc);
    store.execute(setInstrumentParams(store.doc, trackId, { bodyDecay: 0.9 }, "KOPA shape"));
    const marker = paramsOf(store.doc).level;
    store.execute(setInstrumentParams(store.doc, trackId, { tailLevel: 0.4 }, "KOPA shape"));
    expect(paramsOf(store.doc).level).toBe(marker);

    store.undo();
    expect(paramsOf(store.doc).tailLevel).not.toBe(0.4);
    expect(paramsOf(store.doc).bodyDecay).toBe(0.9);
    expect(paramsOf(store.doc).level).toBe(marker);
  });

  it("clamps every value to the instrument's own range", () => {
    const { doc, trackId } = docWithKopa();
    const store = new ProjectStore(doc);
    store.execute(
      setInstrumentParams(store.doc, trackId, { bodyDecay: 99, clickLevel: -5, pitchAmount: 900 }, "KOPA shape"),
    );
    const params = paramsOf(store.doc);
    expect(params.bodyDecay).toBeLessThanOrEqual(2);
    expect(params.clickLevel).toBeGreaterThanOrEqual(0);
    expect(params.pitchAmount).toBeLessThanOrEqual(48);
  });

  it("redoes the whole drag", () => {
    const { doc, trackId } = docWithKopa();
    const store = new ProjectStore(doc);
    store.execute(setInstrumentParams(store.doc, trackId, { bodyDecay: 0.75, tailLevel: 0.55 }, "KOPA shape"));
    store.undo();
    store.redo();
    expect(paramsOf(store.doc).bodyDecay).toBe(0.75);
    expect(paramsOf(store.doc).tailLevel).toBe(0.55);
  });
});
