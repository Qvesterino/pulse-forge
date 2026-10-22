import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addAudioClip, trimAudioClipStart } from "../../src/commands/commands";
import { audioClipDurationSec } from "../../src/commands/audioClips";
import { audioClipPlayWindow } from "../../src/audio-engine/warpManager";
import { mockServices } from "../helpers";
import type { AudioClip, ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";

/**
 * EXTENDING A CLIP'S HEAD LEFT — the source has a headroom, and the clip must
 * not grow past it.
 *
 * THE DEFECT (P2, a wrong edit applied silently). The audio trim gesture let
 * the head move LEFT, which is a valid gesture as long as the SOURCE can move
 * back with it: `offsetSec` is a position in the ORIGINAL sample, so a clip
 * whose source starts 4 s into the file can grow left by 4 s of material.
 *
 * With no headroom (`offsetSec === 0`) the source position could not move
 * back, and the command CLAMPED IT TO 0 SILENTLY. The clip still grew on the
 * timeline, the source stayed where it was, and the engine then played
 * `min(wall, available)` — LESS than the clip's wall duration. The audio lost
 * its tail with no message, no error and no visual difference: a clip that
 * looks 2 bars long plays 2 bars short.
 *
 * The scene-clip twin refuses the same gesture outright ("extend-left is a
 * separate verb"). The audio twin needs the same contract, expressed in the
 * source's own terms: the head may move back exactly as far as the file goes
 * back, and not one sample further.
 *
 * WHAT THIS PINS:
 *   1. the gesture stops at the source's headroom — the preview and the commit
 *      agree, and the clip does not grow past its material,
 *   2. with headroom, the gesture works and the source moves back with it,
 *   3. the COMMAND refuses a source position before the file's start, so no
 *      other caller (intent, MCP, collab) can write a truncated clip,
 *   4. the invariant: an accepted clip always plays its whole wall duration.
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

/** A project carrying one audio clip at bar 4, four bars long. */
function docWithClip(offsetSec: number): ProjectDocument {
  const base = createProjectFromTemplate("house");
  return addAudioClip(base, base.tracks[0].id, "factory.kick", 4, 4, { offsetSec }).execute(base);
}

function renderLive(doc: ProjectDocument): ProjectStore {
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
  return project;
}

const clipOf = (doc: ProjectDocument): AudioClip => doc.arrangement.audioClips![0]!;

/**
 * Drag the clip's LEFT trim handle `bars` bars to the LEFT and release.
 * The handle grabs at x=2 and the panel draws 30 px per bar, so one bar left
 * is clientX = 2 - 30.
 */
function extendHeadLeft(doc: ProjectDocument, bars: number): { before: ProjectDocument; after: ProjectDocument } {
  cleanup();
  const project = renderLive(doc);
  const before = project.getDoc();

  const handle = document.querySelector(".arr-audio-clip-handle.left");
  expect(handle, "left trim handle is rendered").not.toBeNull();
  vi.spyOn(handle as Element, "getBoundingClientRect").mockReturnValue(domRect(0, 100));
  const target = handle!.parentElement as HTMLElement;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(domRect(0, 200));

  const clientX = 2 - 30 * bars;
  act(() => {
    handle!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 2, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointermove", { clientX, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerup", { clientX, pointerId: 1, bubbles: true }));
  });

  return { before, after: project.getDoc() };
}

/** The wall seconds the engine actually plays for this clip. */
function playedWallSec(doc: ProjectDocument, clip: AudioClip): number {
  const rate = clip.stretchRate ?? 1;
  const timeScale = clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01 ? rate : 1;
  const wallSec = audioClipDurationSec(doc, clip.lengthBars, clip.startBar);
  return audioClipPlayWindow(clip, 100 * timeScale, wallSec, timeScale).duration;
}

/** A clip that plays less than its own wall duration is a silent truncation. */
function playsWholeWall(doc: ProjectDocument, clip: AudioClip): boolean {
  const wallSec = audioClipDurationSec(doc, clip.lengthBars, clip.startBar);
  return Math.abs(playedWallSec(doc, clip) - wallSec) < 1e-6;
}

describe("extending an audio clip's head left is bounded by the source's headroom", () => {
  it("the head stops at the source's start — the clip does not grow past its material", () => {
    const { before, after } = extendHeadLeft(docWithClip(0), 1);
    const b = clipOf(before);
    const a = clipOf(after);

    // The source starts at the file's first sample: there is nothing to reveal.
    expect(a.startBar, "the head must not move before the source's start").toBeCloseTo(b.startBar, 6);
    expect(a.lengthBars, "the clip must not grow without material to grow into").toBeCloseTo(b.lengthBars, 6);
  });

  it("with headroom, the head moves back and the source moves with it", () => {
    const { before, after } = extendHeadLeft(docWithClip(4), 1);
    const b = clipOf(before);
    const a = clipOf(after);

    expect(a.startBar, "the head moves left").toBeLessThan(b.startBar);
    expect(a.lengthBars, "the clip grows by the same amount").toBeCloseTo(b.lengthBars + (b.startBar - a.startBar), 6);
    expect(a.offsetSec, "the source moves back with the head").toBeLessThan(b.offsetSec);
    expect(a.offsetSec, "the source must stay inside the file").toBeGreaterThanOrEqual(0);
  });

  it("the command refuses a source position before the file's start", () => {
    const doc = docWithClip(0);
    const clip = clipOf(doc);
    expect(() =>
      trimAudioClipStart(doc, clip.id, {
        startBar: clip.startBar - 1,
        lengthBars: clip.lengthBars + 1,
        trimStart: clip.trimStart ?? 0,
        offsetSec: clip.offsetSec - 2,
      }),
    ).toThrow(/extend-left/);
  });

  it("the source moves with the head — the gesture means what it says", () => {
    // The head moved left by N bars: the source position must have moved back
    // by exactly those N bars of wall time. A head that grows the clip while
    // the source stays put is the right-extend wearing the left-extend's
    // clothes, and it is the defect this contract removes.
    const { before, after } = extendHeadLeft(docWithClip(4), 1);
    const b = clipOf(before);
    const a = clipOf(after);
    const secPerBar = audioClipDurationSec(before, b.lengthBars, b.startBar) / b.lengthBars;
    const headWallSec = (b.startBar - a.startBar) * secPerBar;

    expect(headWallSec, "the head really moved").toBeGreaterThan(0);
    expect(b.offsetSec - a.offsetSec, "the source moved back with the head").toBeCloseTo(headWallSec, 6);
    expect(playsWholeWall(after, a), "the clip still plays its whole wall duration").toBe(true);
  });

  it("a clip with no headroom is not left playing less than its length", () => {
    // The control: with no headroom the head does not move, so the clip is
    // exactly as it was — it never became longer than the material it plays.
    const { before, after } = extendHeadLeft(docWithClip(0), 1);
    expect(playsWholeWall(before, clipOf(before))).toBe(true);
    expect(playsWholeWall(after, clipOf(after))).toBe(true);
  });
});
