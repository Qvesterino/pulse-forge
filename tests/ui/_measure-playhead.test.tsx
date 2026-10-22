import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addAudioClip } from "../../src/commands/commands";
import { audioClipPlayWindow } from "../../src/audio-engine/warpManager";
import { mockServices } from "../helpers";
import type { AudioClip, ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";

const domRect = (left: number, width: number) =>
  ({ left, top: 0, width, height: 40, right: left + width, bottom: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

function docWithClip(offsetSec: number, stretchRate: number): ProjectDocument {
  const base = createProjectFromTemplate("house");
  return addAudioClip(base, base.tracks[0].id, "factory.kick", 0, 4, { offsetSec, stretchRate }).execute(base);
}

function renderLive(doc: ProjectDocument): ProjectStore {
  const project = new ProjectStore(doc);
  const selectionStore = new SelectionStore();
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  render(
    createElement(
      ServicesContext.Provider,
      { value: services },
      createElement(SelectionContext.Provider, { value: selectionStore }, createElement(ArrangementPanel) as ReactElement),
    ),
  );
  const lane = document.querySelector(".arr-lane");
  if (lane) vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 2000));
  return project;
}

const clipOf = (doc: ProjectDocument): AudioClip => doc.arrangement.audioClips![0]!;

/** The source playhead the engine will actually use (original-sample seconds). */
function playhead(clip: AudioClip): number {
  const win = audioClipPlayWindow(clip, 100, 10, 1);
  return win.playOffset;
}

function trimStartTo(doc: ProjectDocument, clientX: number) {
  cleanup();
  const project = renderLive(doc);
  const before = project.getDoc();
  const handle = document.querySelector(".arr-audio-clip-handle.left");
  if (!handle) throw new Error("no handle");
  vi.spyOn(handle as Element, "getBoundingClientRect").mockReturnValue(domRect(0, 100));
  const target = handle.parentElement as HTMLElement;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(domRect(0, 200));
  act(() => {
    handle.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 2, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointermove", { clientX, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerup", { clientX, pointerId: 1, bubbles: true }));
  });
  return { after: project.getDoc(), before };
}

describe("MEASURE", () => {
  it("reports the playhead movement", () => {
    for (const rate of [1, 2, 0.5]) {
      const { before, after } = trimStartTo(docWithClip(0, rate), 200);
      const b = clipOf(before);
      const a = clipOf(after);
      // eslint-disable-next-line no-console
      console.log(
        `RATE ${rate}: offsetSec ${b.offsetSec}->${a.offsetSec} | trimStart ${b.trimStart}->${a.trimStart} | ` +
          `PLAYHEAD ${playhead(b).toFixed(4)}->${playhead(a).toFixed(4)} (advance ${(playhead(a) - playhead(b)).toFixed(4)}) | ` +
          `wallStart ${b.startBar}->${a.startBar} len ${b.lengthBars}->${a.lengthBars}`,
      );
    }
    expect(true).toBe(true);
  });
});
