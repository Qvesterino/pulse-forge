import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addAudioClip } from "../../src/commands/commands";
import { audioClipDurationSec } from "../../src/commands/audioClips";
import { audioClipPlayWindow } from "../../src/audio-engine/warpManager";
import { mockServices } from "../helpers";
import type { AudioClip, ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";

/**
 * TRIM START ON AN AUDIO CLIP — the committed clip must be the clip the user
 * dragged, and it must play the source the gesture asked for.
 *
 * THREE DEFECTS, ONE GESTURE. All three lived in the same commit path
 * (`ArrangementPanel.onAudioPointerUp` → `trimAudioClipStart`).
 *
 * D1 — THE CLIP DID NOT MOVE (P1, wrong edit applied).
 *   The drag PREVIEW renders the clip at the dragged position: the start edge
 *   moves right and the END edge never moves (`newLen = origStart + origLength
 *   - newStart`). The COMMIT never wrote `startBar`, so the clip stayed where
 *   it was and shrank from the RIGHT. The user dragged the head two bars
 *   right, watched the clip move, released — and the clip snapped back to its
 *   old start with a shorter tail. The committed geometry and the preview
 *   were two different clips. The scene-clip twin `trimArrangementClipStart`
 *   has always done it correctly ("move it right, end stays").
 *
 * D2 — THE SOURCE SKIP IGNORED THE STRETCH RATE (P1, source mapping).
 *   `offsetSec`/`trimStart` are positions in the ORIGINAL sample; the clip
 *   plays the original at `playbackRate = stretchRate` (triggerEngine.ts), so
 *   ONE WALL SECOND of trim moves the source by `rate` source seconds. The
 *   commit used the wall delta verbatim. The split already does it right
 *   (`audioClips.ts`: `elapsedSec * clip.stretchRate`).
 *
 * D3 — THE SAME SKIP WAS COUNTED TWICE (P1, source mapping).
 *   The audible source start is `offsetSec + trimStart` (audioClipPlayWindow).
 *   The commit advanced BOTH fields by the same delta, so the clip played
 *   twice as deep into the sample as the gesture asked for. A rate-1 clip
 *   skipped 2× the source; only rate 2 happened to land on the right place.
 *
 * WHAT THIS TEST PINS.
 *
 *   The committed clip's playable window — the SAME window the engine plays
 *   and the waveform draws — must match the gesture: the start edge moved
 *   right by the dragged amount, the end edge did not move, and the source
 *   skip equals the wall delta × the clip's rate.
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

/** A project carrying one audio clip with the given source offset and rate. */
function docWithClip(offsetSec: number, stretchRate: number, stretchMode?: "resample" | "stretch"): ProjectDocument {
  const base = createProjectFromTemplate("house");
  return addAudioClip(base, base.tracks[0].id, "factory.kick", 0, 4, {
    offsetSec,
    stretchRate,
    ...(stretchMode ? { stretchMode } : {}),
  }).execute(base);
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

/** The source playhead the engine will actually use (original-sample seconds). */
const playheadOf = (clip: AudioClip): number => audioClipPlayWindow(clip, 100, 10, 1).playOffset;

/**
 * Drag the clip's LEFT trim handle to `clientX` and release.
 * The handle grabs at x=2 and the pointer moves to `clientX`, so the gesture's
 * bar delta is `(clientX - 2) / 30` bars (BASE_BAR_WIDTH = 30 px/bar).
 */
function trimStartTo(doc: ProjectDocument, clientX: number): { after: ProjectDocument; before: ProjectDocument } {
  cleanup();
  const project = renderLive(doc);
  const before = project.getDoc();

  const handle = document.querySelector(".arr-audio-clip-handle.left");
  expect(handle, "left trim handle is rendered").not.toBeNull();
  vi.spyOn(handle as Element, "getBoundingClientRect").mockReturnValue(domRect(0, 100));
  const target = handle!.parentElement as HTMLElement;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(domRect(0, 200));

  act(() => {
    handle!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 2, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointermove", { clientX, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerup", { clientX, pointerId: 1, bubbles: true }));
  });

  return { after: project.getDoc(), before };
}

describe("TRIM START on an audio clip commits the clip the user dragged", () => {
  it("D1: the start edge moves right and the end edge never moves", () => {
    // The clip is 4 bars long; drag its head 2 bars right (30 px per bar).
    const { before, after } = trimStartTo(docWithClip(0, 1), 62);
    const b = clipOf(before);
    const a = clipOf(after);

    // The gesture moved the head right.
    expect(a.startBar, "the clip must move with the dragged head").toBeCloseTo(b.startBar + 2, 6);
    // The end edge is anchored: the clip got SHORTER by exactly what it moved.
    expect(a.startBar + a.lengthBars).toBeCloseTo(b.startBar + b.lengthBars, 6);
    expect(a.lengthBars).toBeCloseTo(b.lengthBars - 2, 6);
  });

  it("D1b: a head dragged past the clip's end still commits the previewed clip", () => {
    // 6.85 bars of drag on a 4-bar clip: the preview collapses the clip to the
    // 0.25-bar floor AT the dragged position. The commit must land there too
    // — the old code kept the clip at bar 0 and shortened it from the right.
    const { before, after } = trimStartTo(docWithClip(0, 1), 200);
    const b = clipOf(before);
    const a = clipOf(after);
    expect(a.startBar).toBeGreaterThan(b.startBar + 4);
    expect(a.lengthBars).toBeCloseTo(0.25, 6);
  });

  it("D2: the source skip scales with the clip's stretch rate", () => {
    const control = trimStartTo(docWithClip(0, 1), 200);
    const controlSkip = playheadOf(clipOf(control.after)) - playheadOf(clipOf(control.before));

    const stretched = trimStartTo(docWithClip(0, 2), 200);
    const stretchedSkip = playheadOf(clipOf(stretched.after)) - playheadOf(clipOf(stretched.before));

    // One wall second of trim = `rate` source seconds of sample.
    expect(controlSkip).toBeGreaterThan(0);
    expect(stretchedSkip).toBeCloseTo(controlSkip * 2, 6);
  });

  it("D3: the source skip is counted ONCE, not twice", () => {
    const control = trimStartTo(docWithClip(0, 1), 200);
    const controlSkip = playheadOf(clipOf(control.after)) - playheadOf(clipOf(control.before));

    const b = clipOf(control.before);
    const a = clipOf(control.after);
    const barsMoved = a.startBar - b.startBar;
    // The wall-clock length of the trimmed head, from the document's own tempo
    // map (the independent helper — the panel integrates the delta through
    // `arrangementSecondsBetweenTicks`).
    const wallSec = audioClipDurationSec(control.before, barsMoved, b.startBar);

    // On a rate-1 clip the source skip IS the wall delta. A double-counted
    // skip (offsetSec AND trimStart both advanced) came out at twice this.
    expect(controlSkip).toBeCloseTo(wallSec, 3);
  });

  it("the audible source start advances by exactly the wall delta × the rate", () => {
    for (const rate of [1, 2, 0.5]) {
      const { before, after } = trimStartTo(docWithClip(0, rate), 200);
      const b = clipOf(before);
      const a = clipOf(after);

      const wallSec = audioClipDurationSec(before, a.startBar - b.startBar, b.startBar);
      const skip = playheadOf(a) - playheadOf(b);

      // Rate 1 is the reference: the skip is the wall delta. Scaled clips
      // consume `rate` source seconds per wall second.
      expect(skip, `rate ${rate}: audible skip`).toBeCloseTo(wallSec * rate, 3);
    }
  });

  it("a PITCH-PRESERVING stretch clip consumes 1/rate source seconds per wall second", () => {
    // The other stretch mode is the inverse: the clip plays a pre-rendered
    // `original × rate` buffer at `playbackRate = 1`, so one wall second
    // consumes `1 / rate` original seconds. Multiplying by the raw rate here
    // over-skipped by rate² — at rate 2 that is four times too deep.
    const { before, after } = trimStartTo(docWithClip(0, 2, "stretch"), 62);
    const b = clipOf(before);
    const a = clipOf(after);

    const wallSec = audioClipDurationSec(before, a.startBar - b.startBar, b.startBar);
    const skip = playheadOf(a) - playheadOf(b);
    expect(skip, "stretch mode consumes 1/rate source seconds per wall second").toBeCloseTo(wallSec / 2, 3);
  });

  it("the waveform window and the played window are the same window", () => {
    const { after } = trimStartTo(docWithClip(0, 1), 200);
    const clip = clipOf(after);
    // `audioClipWaveformWindow` starts at offsetSec + trimStart — the same
    // sum the engine plays from. If these ever diverge, the picture lies.
    expect(playheadOf(clip)).toBeCloseTo(clip.offsetSec + clip.trimStart, 6);
  });
});
