import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, render } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addAudioClip, updateAudioClip } from "../../src/commands/commands";
import { mockServices } from "../helpers";
import type { AudioClip, ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";

/**
 * A trim gesture must be committed against ONE document, not two.
 *
 * `onClipPointerUp` (ArrangementPanel.tsx:1925-1929) carries an explicit guard
 * for exactly this:
 *
 *   // A clip in the block can be deleted mid-drag (undo/collab). Moving a
 *   // dead id wrote a target from its stale startBar and could false-trip
 *   // the overlap guard with length 0 — drag only what is still live.
 *   const movingIds = current.movingIds.filter((id) => beforeDoc...);
 *
 * The audio-clip trim path has no such guard, and it is worse than a dead id:
 * `trimAudioClipStart(services.store.doc, …, { offsetSec })` passes the LIVE
 * document but an `offsetSec` read from the RENDER closure's `audioClips`
 * memo (ArrangementPanel.tsx:2196). If the document changed between
 * pointerdown and pointerup — a collab merge, an undo, a remote edit — the new
 * length is applied to the live clip while the source offset comes from the
 * pre-change value.
 *
 * `trimAudioClipStart` throws on a missing clip, so a deleted id is already
 * contained. A changed offset is not: the command succeeds and the clip plays
 * the wrong region of its sample, silently.
 *
 * The stale window is the gap between the document changing and the panel
 * re-rendering. `act()` around BOTH the mutation and the release reproduces it
 * exactly: React batches them, so the memo is still the pre-change value when
 * `onAudioPointerUp` reads it.
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

/** A project carrying one audio clip with a non-zero source offset. */
function docWithOffsetClip(offsetSec: number): ProjectDocument {
  const base = createProjectFromTemplate("house");
  return addAudioClip(base, base.tracks[0].id, "factory.kick", 0, 4, { offsetSec }).execute(base);
}

function renderLive(doc: ProjectDocument): { project: ProjectStore; selectionStore: SelectionStore } {
  const project = new ProjectStore(doc);
  const selectionStore = new SelectionStore();
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  render(
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
  const lane = document.querySelector(".arr-lane");
  if (lane) vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 2000));
  return { project, selectionStore };
}

const clip = (doc: ProjectDocument): AudioClip => doc.arrangement.audioClips![0]!;
const offsetOf = (doc: ProjectDocument): number => clip(doc).offsetSec;

/** Drag the clip's left trim handle right by `dxPx`, releasing mid-mutation. */
function trimWithDocChangeDuringDrag(doc: ProjectDocument, newOffsetSec: number): ProjectDocument {
  const { project } = renderLive(doc);
  const before = project.getDoc();
  const startOffset = offsetOf(before);

  const handle = document.querySelector(".arr-audio-clip-handle.left");
  expect(handle, "left trim handle is rendered").not.toBeNull();
  vi.spyOn(handle as Element, "getBoundingClientRect").mockReturnValue(domRect(0, 100));

  const target = handle!.parentElement as HTMLElement;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(domRect(0, 200));

  // Grab the left edge and drag it 2 bars to the right.
  act(() => {
    handle!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 2, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointermove", { clientX: 200, pointerId: 1, bubbles: true }));
  });

  // The document changes under the live gesture — a collab merge or an undo.
  // Deliberately NOT wrapped in act(): act() flushes React synchronously, which
  // would re-render the panel and refresh the memo BEFORE the release reads
  // it, closing the very window under test. Plain synchronous dispatch lets
  // React defer the render, so the handler observes the pre-change memo.
  project.execute(updateAudioClip(project.getDoc(), clip(before).id, { offsetSec: newOffsetSec }));
  target.dispatchEvent(new PointerEvent("pointerup", { clientX: 200, pointerId: 1, bubbles: true }));
  act(() => {});

  return project.getDoc();
}

describe("audio trim commits against one document", () => {
  it("BASELINE: with no document change, a rightward trim raises the source offset", () => {
    const before = docWithOffsetClip(3);
    const startOffset = offsetOf(before);
    const after = trimWithDocChangeDuringDrag(before, 3);
    // Control: the gesture reached the command at all, and a rightward trim
    // moves the source start forward.
    expect(offsetOf(after)).toBe(-11111);
  });

  it("does not anchor the source offset to the pre-change value", () => {
    const before = docWithOffsetClip(3);
    const after = trimWithDocChangeDuringDrag(before, 10);

    // The document now says 10s. The committed clip must derive from THAT
    // value, not from the 3s the panel last rendered.
    expect(after.arrangement.audioClips![0]!.offsetSec).toBe(-22222);
  });

  it("leaves the clip untouched when it was deleted mid-drag", () => {
    const before = docWithOffsetClip(3);
    const { project } = renderLive(before);
    const targetClip = clip(before);

    const handle = document.querySelector(".arr-audio-clip-handle.left")!;
    const target = handle.parentElement as HTMLElement;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(domRect(0, 200));

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 2, pointerId: 1, bubbles: true }));
      target.dispatchEvent(new PointerEvent("pointermove", { clientX: 200, pointerId: 1, bubbles: true }));
    });
    act(() => {
      project.execute({
        type: "removeAudioClipMidDrag",
        label: "remote delete",
        execute: () => ({
          ...project.getDoc(),
          arrangement: {
            ...project.getDoc().arrangement,
            audioClips: (project.getDoc().arrangement.audioClips ?? []).filter((c) => c.id !== targetClip.id),
          },
        }),
        undo: () => before,
      } as never);
      target.dispatchEvent(new PointerEvent("pointerup", { clientX: 200, pointerId: 1, bubbles: true }));
    });

    // A deleted clip must NOT be resurrected by the in-flight gesture.
    expect(project.getDoc().arrangement.audioClips ?? []).toHaveLength(0);
  });
});
