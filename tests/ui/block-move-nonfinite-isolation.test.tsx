import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addArrangementClip } from "../../src/commands/arrangement";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";
import type { ArrangementClip, ProjectDocument } from "../../src/project-model/types";

/**
 * §24 PROJECT STATE vs EDITOR STATE — the block move spreads the gesture's own
 * geometry over every selected clip.
 *
 * `Math.min(...Object.values(origStarts))` is the floor for the whole block:
 * it is computed from the clips' captured start positions, and `Math.min`
 * PROPAGATES NaN. A single member carrying a non-finite position therefore
 * yields a NaN delta, and `Math.max(0, Math.round(orig + NaN))` is NaN — the
 * commit writes NaN into EVERY member, so one bad clip stops being one bad
 * clip. That is §32 corruption (P1: clip mapping corruption) arriving through
 * the gesture layer rather than through a command.
 *
 * Reachable without any test-only trick: select-all picks up the bad id, and a
 * clip with no renderable position is culled from the lane — so the user
 * drags a perfectly healthy neighbour while the selection carries the poison.
 */

const domRect = (left: number, width: number) =>
  ({ left, top: 0, width, height: 40, right: left + width, bottom: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

function fixture(): { doc: ProjectDocument; healthyId: string; badId: string } {
  let doc = createProjectFromTemplate("house");
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] } };
  doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 8).execute(doc);
  const healthy: ArrangementClip = doc.arrangement.clips[0]!;
  const bad: ArrangementClip = { ...healthy, id: "clip-nan", startBar: Number.NaN, lengthBars: 4 };
  const next: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, clips: [healthy, bad] },
  };
  return { doc: next, healthyId: healthy.id, badId: bad.id };
}

function mount(doc: ProjectDocument, selected: string[]) {
  const store = new ProjectStore(doc);
  const services = { ...mockServices(doc), store } as unknown as Services;
  const selectionStore = new SelectionStore();
  selectionStore.setClips(selected);
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
  const lane = document.querySelector(".arr-lane")!;
  const clips = [...document.querySelectorAll<HTMLElement>(".arr-clip")];
  vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 4_000_000));
  for (const el of clips) vi.spyOn(el, "getBoundingClientRect").mockReturnValue(domRect(0, 100));
  return { store, clips };
}

const startBars = (store: ProjectStore) =>
  Object.fromEntries(store.doc.arrangement.clips.map((c) => [c.id, c.startBar]));

afterEach(() => cleanup());

describe("§24 block move with a non-finite member", () => {
  it("CONTROL: dragging a healthy clip with a healthy partner moves both", () => {
    let doc = createProjectFromTemplate("house");
    doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] } };
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 4, 4).execute(doc);
    const ids = doc.arrangement.clips.map((c) => c.id);
    const { store, clips } = mount(doc, ids);
    expect(clips.length).toBe(2);
    fireEvent.pointerDown(clips[0]!, { button: 0, clientX: 40, pointerId: 1 });
    act(() => {
      fireEvent.pointerMove(clips[0]!, { clientX: 240, pointerId: 1 });
    });
    fireEvent.pointerUp(clips[0]!, { pointerId: 1 });
    const after = ids.map((id) => store.doc.arrangement.clips.find((c) => c.id === id)!.startBar);
    expect(after.every((v) => Number.isFinite(v))).toBe(true);
    expect(after[1]!).toBeGreaterThan(after[0]!);
  });

  it("a non-finite member must not poison its healthy neighbours", () => {
    const { doc, healthyId, badId } = fixture();
    const before = startBars(new ProjectStore(doc));
    const { store, clips } = mount(doc, [healthyId, badId]);
    expect(clips.length, "the non-finite clip is culled, the healthy one is draggable").toBe(1);

    fireEvent.pointerDown(clips[0]!, { button: 0, clientX: 40, pointerId: 1 });
    act(() => {
      fireEvent.pointerMove(clips[0]!, { clientX: 240, pointerId: 1 });
    });
    fireEvent.pointerUp(clips[0]!, { pointerId: 1 });

    const after = startBars(store);
    expect(after[healthyId], "the dragged clip must stay a real bar position").toBe(expect.any(Number));
    expect(Number.isFinite(after[healthyId]), "a NaN delta must never reach the document").toBe(true);
    expect(Number.isNaN(after[healthyId])).toBe(false);
    expect(after[healthyId]).not.toBe(NaN);
    // The bad member is left exactly as it was — the gesture does not touch it.
    expect(Object.is(after[badId], NaN)).toBe(Object.is(before[badId], NaN));
  });

  it("the document never accumulates more non-finite positions than it started with", () => {
    const { doc, healthyId, badId } = fixture();
    const { store, clips } = mount(doc, [healthyId, badId]);
    fireEvent.pointerDown(clips[0]!, { button: 0, clientX: 40, pointerId: 1 });
    act(() => {
      fireEvent.pointerMove(clips[0]!, { clientX: 240, pointerId: 1 });
    });
    fireEvent.pointerUp(clips[0]!, { pointerId: 1 });
    const broken = store.doc.arrangement.clips.filter((c) => !Number.isFinite(c.startBar));
    expect(
      broken.map((c) => c.id),
      "one bad clip must stay one bad clip",
    ).toEqual([badId]);
  });

  it("undo after such a drag restores every finite position", () => {
    const { doc, healthyId, badId } = fixture();
    const { store, clips } = mount(doc, [healthyId, badId]);
    fireEvent.pointerDown(clips[0]!, { button: 0, clientX: 40, pointerId: 1 });
    act(() => {
      fireEvent.pointerMove(clips[0]!, { clientX: 240, pointerId: 1 });
    });
    fireEvent.pointerUp(clips[0]!, { pointerId: 1 });
    if (store.canUndo) store.undo();
    const healed = store.doc.arrangement.clips.find((c) => c.id === healthyId)!;
    expect(Number.isFinite(healed.startBar)).toBe(true);
    expect(healed.startBar).toBe(0);
  });
});
