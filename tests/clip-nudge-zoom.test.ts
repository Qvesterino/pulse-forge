import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ArrangementPanel } from "../src/ui/ArrangementPanel";
import { ProjectStore } from "../src/store/ProjectStore";
import { SelectionStore } from "../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../src/ui/context";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  addArrangementClip,
  addAudioClip,
  deleteArrangementClip,
  groupClips,
  nudgeClips,
  setClipsLocked,
} from "../src/commands/commands";
import { mockServices } from "./helpers";
import type { AudioClip, ArrangementClip, ProjectDocument } from "../src/project-model/types";
import type { Services } from "../src/services";

/**
 * CLIP NUDGE (←/→) — the keyboard-move verb over BOTH clip systems.
 *
 *  N1 mixed selection moves by the same delta; spacing preserved
 *  N2 left clamp at bar 0 (partial: clips already at 0 stay, the rest move)
 *  N3 locked clips are skipped while the unlocked part of the selection moves
 *  N4 arrangement no-overlap: a clip whose target would collide stays put
 *     (partial application — audio clips still move)
 *  N5 group expansion: nudging ONE member moves the whole group
 *  N6 no-op (delta 0 / nothing live) pushes no history entry; undo/redo exact
 *  Z1 zoom range: ctrl+wheel reaches the extended 0.05–40× clamps
 *     (1.5 px/bar at BASE_BAR_WIDTH 30 — min), plain wheel never zooms
 */

const domRect = (left: number, width: number) =>
  ({
    left,
    top: 0,
    width,
    height: 40,
    right: left + width,
    bottom: 40,
    x: left,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;

const docWithMixed = (): { doc: ProjectDocument; arrId: string; audioId: string; audio2: string } => {
  let doc = createProjectFromTemplate("house");
  for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
  const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
  doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
  doc = addAudioClip(doc, trackId, "buf-a", 0, 2).execute(doc);
  doc = addAudioClip(doc, trackId, "buf-b", 8, 2).execute(doc);
  return {
    doc,
    arrId: doc.arrangement.clips[0]!.id,
    audioId: (doc.arrangement.audioClips ?? []).find((c) => c.bufferId === "buf-a")!.id,
    audio2: (doc.arrangement.audioClips ?? []).find((c) => c.bufferId === "buf-b")!.id,
  };
};

const clipsOf = (doc: ProjectDocument): AudioClip[] => doc.arrangement.audioClips ?? [];
const arrClip = (doc: ProjectDocument): ArrangementClip => doc.arrangement.clips[0]!;

describe("N1/N6 nudge model", () => {
  it("mixed selection moves by the same delta; undo/redo exact", () => {
    const { doc, arrId, audioId } = docWithMixed();
    const store = new ProjectStore(doc);
    const baseline = store.doc;
    store.execute(nudgeClips(store.doc, [arrId, audioId], 2));
    expect(arrClip(store.doc).startBar).toBe(2);
    expect(clipsOf(store.doc).find((c) => c.id === audioId)!.startBar).toBe(2);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc).toEqual(baseline);
    store.redo();
    expect(arrClip(store.doc).startBar).toBe(2);
  });

  it("left nudge clamps at bar 0 — partial application keeps the rest moving", () => {
    const { doc, arrId, audioId, audio2 } = docWithMixed();
    const store = new ProjectStore(doc);
    // audio2 sits at bar 8; a -4 bar nudge would floor IT at 0 too — use -2:
    // arr (0) stays clamped at 0, buf-a (0) stays, buf-b (8→6) moves.
    store.execute(nudgeClips(store.doc, [arrId, audio2], -2));
    expect(arrClip(store.doc).startBar).toBe(0);
    expect(clipsOf(store.doc).find((c) => c.id === audio2)!.startBar).toBe(6);
    void audioId;
  });

  it("zero delta pushes no history entry", () => {
    const { doc, arrId } = docWithMixed();
    const store = new ProjectStore(doc);
    const before = store.undoStackLength;
    store.execute(nudgeClips(store.doc, [arrId], 0));
    expect(store.undoStackLength).toBe(before);
  });
});

describe("N3/N4 lock and overlap skips", () => {
  it("locked clips stay; unlocked members of the selection move", () => {
    const { doc, arrId, audioId } = docWithMixed();
    const store = new ProjectStore(doc);
    store.execute(setClipsLocked(store.doc, [arrId], true));
    store.execute(nudgeClips(store.doc, [arrId, audioId], 1));
    expect(arrClip(store.doc).startBar).toBe(0);
    expect(clipsOf(store.doc).find((c) => c.id === audioId)!.startBar).toBe(1);
  });

  it("a scene clip whose target would overlap stays put (no-overlap lane); audio moves", () => {
    const { doc, arrId, audioId, audio2 } = docWithMixed();
    const store = new ProjectStore(doc);
    // A second scene clip sits at bars 4..8: nudging arr (0..4) right by 1
    // would land it at 1..5 — colliding at bar 4 — so it stays; the audio
    // clip layers freely and moves.
    store.execute(addArrangementClip(store.doc, store.doc.scenes[0]!.id, 4, 4));
    store.execute(nudgeClips(store.doc, [arrId, audioId], 1));
    expect(arrClip(store.doc).startBar).toBe(0);
    expect(clipsOf(store.doc).find((c) => c.id === audioId)!.startBar).toBe(1);
    void audio2;
  });
});

describe("N5 group expansion", () => {
  it("nudging ONE member moves the whole group (drag parity)", () => {
    const { doc, arrId, audioId } = docWithMixed();
    const store = new ProjectStore(doc);
    store.execute(groupClips(store.doc, [arrId, audioId]));
    store.execute(nudgeClips(store.doc, [arrId], 1));
    expect(arrClip(store.doc).startBar).toBe(1);
    expect(clipsOf(store.doc).find((c) => c.id === audioId)!.startBar).toBe(1);
  });
});

describe("Z1 extended zoom range", () => {
  afterEach(() => cleanup());

  it("ctrl+wheel reaches the 0.05× floor (1.5 px/bar) and the 40× ceiling (1200 px/bar)", () => {
    const { doc } = docWithMixed();
    const project = new ProjectStore(doc);
    const selectionStore = new SelectionStore();
    const services = { ...mockServices(doc), store: project } as unknown as Services;
    const { container } = render(
      createElement(
        ServicesContext.Provider,
        { value: services },
        createElement(
          SelectionContext.Provider,
          { value: selectionStore },
          createElement(ArrangementPanel) as ReactElement,
        ),
      ),
    );
    const scroll = container.querySelector(".arr-lane-scroll") as HTMLElement;
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(domRect(0, 800));
    const laneWidth = () => parseInt((container.querySelector(".arr-lane") as HTMLElement).style.width, 10);
    // Zoom out hard: totalBars(16) × 1.5 px = the 0.05× floor (lane ≈ 24 + bars).
    for (let i = 0; i < 30; i++) {
      act(() => {
        fireEvent.wheel(scroll, { ctrlKey: true, deltaY: 240, clientX: 400, clientY: 100 });
      });
    }
    const min = laneWidth();
    expect(min).toBeLessThanOrEqual(30); // 16 bars × 1.5 px ≈ 24–30 px
    // Zoom in hard: the 40× ceiling (16 bars × 1200 px).
    for (let i = 0; i < 120; i++) {
      act(() => {
        fireEvent.wheel(scroll, { ctrlKey: true, deltaY: -240, clientX: 400, clientY: 100 });
      });
    }
    expect(laneWidth()).toBeGreaterThanOrEqual(16 * 1200);
    expect(min).toBeGreaterThan(0);
  });
});
