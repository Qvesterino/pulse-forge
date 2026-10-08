import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addArrangementClip, deleteArrangementClip, groupClips, setClipsLocked } from "../../src/commands/commands";
import { mockServices } from "../helpers";
import type { ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";

/**
 * GROUP-AWARE MOVE + LOCK GUARD at the gesture layer (v15 follow-up).
 *
 *  - A plain press on a grouped clip drags the WHOLE group: both clips move
 *    by the same delta, relative spacing preserved, one gesture.
 *  - A LOCKED clip refuses the gesture entirely: the drag is a no-op — the
 *    command-level guard would catch it anyway, but the gesture must not even
 *    produce a ghost preview of a move that cannot commit.
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

function fixture(locked = false): ProjectDocument {
  let doc = createProjectFromTemplate("house");
  for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
  const sceneId = doc.scenes[0]!.id;
  doc = addArrangementClip(doc, sceneId, 0, 4).execute(doc);
  doc = addArrangementClip(doc, sceneId, 8, 4).execute(doc);
  if (locked) doc = setClipsLocked(doc, [doc.arrangement.clips[0]!.id], true).execute(doc);
  return doc;
}

function dragBody(doc: ProjectDocument, dxPx: number): ProjectDocument {
  cleanup();
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
  const target = document.querySelector(".arr-clip") as HTMLElement;
  expect(target, "scene clip rendered").not.toBeNull();
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(domRect(400, 120)); // 4 bars @30px

  act(() => {
    target.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 460, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointermove", { clientX: 460 + dxPx, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerup", { clientX: 460 + dxPx, pointerId: 1, bubbles: true }));
  });
  return project.getDoc();
}

describe("group-aware move gesture", () => {
  afterEach(() => cleanup());

  it("dragging one member of a group moves BOTH clips by the same delta", () => {
    const base = fixture();
    const ids = base.arrangement.clips.map((c) => c.id);
    const doc = groupClips(base, ids).execute(base);
    const after = dragBody(doc, 60); // +2 bars
    const moved = after.arrangement.clips.map((c) => c.startBar).sort((a, b) => a - b);
    expect(moved).toEqual([2, 10]); // 0+2 and 8+2 — spacing preserved
    expect(after.arrangement.clips.map((c) => c.id)).toEqual(ids); // no re-grouping surprises
  });

  it("a locked clip refuses the drag (no ghost of an impossible move)", () => {
    const doc = fixture(true);
    const before = doc.arrangement.clips[0]!;
    const after = dragBody(doc, 60);
    expect(after.arrangement.clips[0]!.startBar).toBe(before.startBar);
    expect(after.arrangement.clips[0]!.lengthBars).toBe(before.lengthBars);
  });
});
