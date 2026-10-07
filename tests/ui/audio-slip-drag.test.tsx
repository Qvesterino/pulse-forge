import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addAudioClip } from "../../src/commands/commands";
import { mockServices } from "../helpers";
import type { AudioClip, ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";

/**
 * SLIP GESTURE (B2): Alt+drag in an audio clip's BODY shifts which part of
 * the source plays (offsetSec) without moving/resizing the clip. Plain drag
 * in the body still MOVES the clip; reverse/loop/warp clips refuse to slip.
 *
 * The modifier is Alt because Shift+press on an audio clip is already the
 * range-select gesture (and Ctrl+press the multi-toggle).
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

function docWithClip(patch: Partial<AudioClip> = {}): ProjectDocument {
  const base = createProjectFromTemplate("house");
  return addAudioClip(base, base.tracks[0].id, "factory.kick", 4, 4, patch).execute(base);
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

/** Press the clip BODY with `alt`, drag by `dxPx`, release. */
function dragBody(doc: ProjectDocument, dxPx: number, alt: boolean): ProjectDocument {
  cleanup();
  const { project } = renderLive(doc);
  const body = document.querySelector(".arr-audio-clip");
  expect(body, "audio clip rendered").not.toBeNull();
  const target = body as HTMLElement;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(domRect(400, 200));

  act(() => {
    target.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 500, pointerId: 1, bubbles: true, altKey: alt }),
    );
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointermove", { clientX: 500 + dxPx, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerup", { clientX: 500 + dxPx, pointerId: 1, bubbles: true }));
  });
  return project.getDoc();
}

describe("slip gesture: Alt+drag body shifts content, not position", () => {
  it("dragging the content left raises offsetSec; startBar/lengthBars unchanged", () => {
    const after = dragBody(docWithClip({ offsetSec: 1 }), -60, true);
    const c = clip(after);
    expect(c.offsetSec).toBeGreaterThan(1); // later source material
    expect(c.startBar).toBe(4);
    expect(c.lengthBars).toBe(4);
  });

  it("plain body drag (no Alt) still MOVES the clip and never writes offsetSec", () => {
    const before = docWithClip({ offsetSec: 1 });
    const after = dragBody(before, -60, false);
    const c = clip(after);
    expect(c.offsetSec).toBe(1);
    expect(c.startBar).toBeLessThan(4);
  });

  it("reverse clips refuse to slip (offset mapping undefined backwards)", () => {
    const before = docWithClip({ offsetSec: 1, reverse: true });
    const after = dragBody(before, -60, true);
    expect(clip(after).offsetSec).toBe(1);
    expect(clip(after).startBar).toBe(4);
  });
});
