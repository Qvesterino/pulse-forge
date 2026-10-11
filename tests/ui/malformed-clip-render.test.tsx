import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addArrangementClip } from "../../src/commands/arrangement";
import { addAudioClip } from "../../src/commands/audioClips";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";
import type { ArrangementClip, AudioClip, ProjectDocument } from "../../src/project-model/types";

/**
 * §32 BOUNDARY/PRECISION + §36 ERROR HANDLING — "detect NaN, Infinity, negative
 * duration, invalid offsets" and "one bad entity should not crash the entire
 * editor when isolation is possible".
 *
 * These documents are built by WRITING past the command layer on purpose. The
 * save/load path (`normalizeProject`) sanitises, so a malformed clip cannot
 * arrive from a normal import — but a collab peer applying a remote update, or
 * a document written by an older build, is exactly the "not normal import" case
 * the error-handling requirement is about. The editor's answer to one bad
 * entity must be "that clip renders wrong", not "the timeline is blank".
 */

function corrupt(doc: ProjectDocument, mutate: (clips: ArrangementClip[]) => ArrangementClip[]): ProjectDocument {
  return { ...doc, arrangement: { ...doc.arrangement, clips: mutate([...doc.arrangement.clips]) } };
}

function renderPanel(doc: ProjectDocument) {
  const store = new ProjectStore(doc);
  const services = { ...mockServices(doc), store } as unknown as Services;
  render(
    createElement(
      ServicesContext.Provider,
      { value: services },
      createElement(
        SelectionContext.Provider,
        { value: new SelectionStore() },
        createElement(ArrangementPanel) as ReactElement,
      ),
    ),
  );
  return store;
}

const baseDoc = () => {
  let doc = createProjectFromTemplate("house");
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] } };
  doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 8).execute(doc);
  return doc;
};

/** Grid cells actually mounted. jsdom reports clientWidth 0, so the panel's
 * window is [0,0] — which means the GRID extent is the only honest witness for
 * "did a corrupt clip poison the whole timeline". */
const gridCells = () => document.querySelectorAll(".arr-bar-grid").length;

afterEach(() => cleanup());

describe("§32 malformed clip data must not take the timeline down", () => {
  it("CONTROL: a well-formed document renders clips and a full grid", () => {
    const doc = baseDoc();
    renderPanel(doc);
    expect(document.querySelectorAll(".arr-clip").length).toBe(1);
    expect(gridCells()).toBeGreaterThan(0);
  });

  it("a NaN startBar does not crash the render and does not erase the grid", () => {
    const doc = corrupt(baseDoc(), (clips) => clips.map((c, i) => (i === 0 ? { ...c, startBar: Number.NaN } : c)));
    expect(() => renderPanel(doc)).not.toThrow();
    // `Math.max(16, NaN)` is NaN, and a NaN grid extent silently emptied every
    // grid cell in the document — not this clip's cell, all of them.
    expect(gridCells(), "one NaN clip must not blank the timeline grid").toBeGreaterThan(0);
  });

  it("an overflowing startBar (1e308) does not crash the render", () => {
    const doc = corrupt(baseDoc(), (clips) => clips.map((c, i) => (i === 0 ? { ...c, startBar: 1e308 } : c)));
    // Pre-fix this reached `Array.from({ length: 1e308 })` on the unmeasured
    // path — the FIRST render of every session — and threw
    // `RangeError: Invalid array length`, unmounting the panel.
    expect(() => renderPanel(doc)).not.toThrow();
    expect(gridCells()).toBeGreaterThan(0);
  });

  it("an Infinity startBar does not crash the render", () => {
    const doc = corrupt(baseDoc(), (clips) => clips.map((c, i) => (i === 0 ? { ...c, startBar: Infinity } : c)));
    expect(() => renderPanel(doc)).not.toThrow();
  });

  it("a negative lengthBars does not crash the render", () => {
    const doc = corrupt(baseDoc(), (clips) => clips.map((c, i) => (i === 0 ? { ...c, lengthBars: -2 } : c)));
    expect(() => renderPanel(doc)).not.toThrow();
  });

  it("a clip pointing at a deleted scene does not crash the render", () => {
    const doc = corrupt(baseDoc(), (clips) => clips.map((c) => ({ ...c, sceneId: "scene-does-not-exist" })));
    expect(() => renderPanel(doc)).not.toThrow();
  });

  it("one malformed clip does not hide its healthy neighbour", () => {
    const doc = corrupt(baseDoc(), (clips) => [
      { ...clips[0]!, id: "clip-na", startBar: Number.NaN },
      { ...clips[0]!, id: "clip-ok", startBar: 0, lengthBars: 4 },
    ]);
    renderPanel(doc);
    expect(gridCells(), "the grid survives the bad entity").toBeGreaterThan(0);
    // The NaN clip is skipped (it has no position to draw); the healthy clip
    // still renders. Isolation, not blanking.
    const rendered = [...document.querySelectorAll<HTMLElement>(".arr-clip")];
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.style.left).toBe("0px");
  });

  it("a malformed AUDIO clip does not crash the render", () => {
    let doc = createProjectFromTemplate("house");
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    doc = addAudioClip(doc, trackId, "bad-buf", 0, 2, {}).execute(doc);
    const broken: AudioClip = {
      ...doc.arrangement.audioClips![0]!,
      startBar: Number.NaN,
      lengthBars: -1,
      offsetSec: Number.POSITIVE_INFINITY,
    };
    const next: ProjectDocument = {
      ...doc,
      arrangement: { ...doc.arrangement, audioClips: [broken] },
    };
    expect(() => renderPanel(next)).not.toThrow();
  });
});
