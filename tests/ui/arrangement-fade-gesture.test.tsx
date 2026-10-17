import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addAudioClip } from "../../src/commands/audioClips";
import { renderWithContext, mockServices } from "../helpers";
import type { Services } from "../../src/services";

/**
 * ARRANGEMENT FADE HANDLE GESTURE GATE (seam: arrangement-fade-handles)
 *
 * The seam ledger listed this OPEN — "no pointerDown anywhere near a fade
 * handle", while the intent layer already had a fade verb (the UI gesture was
 * the uncovered half). These specs drag the REAL `.arr-audio-clip-handle-fade`
 * against a REAL `ProjectStore`.
 *
 * Geometry: zoom defaults to 1 → barWidth = 30 px (BASE_BAR_WIDTH), and the
 * lane rect is jsdom's all-zero rect, so `bar = clientX / 30`. Fade math:
 * fadeOut moves OPPOSITE the pointer (drag left = longer fade), clamped to
 * min(2 s, half the clip's wall-clock span); a gesture may only commit when
 * the value changed by more than 0.005 s (rounded to 2 decimals on commit).
 */

function setup() {
  let doc = createProjectFromTemplate("house");
  const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
  doc = addAudioClip(doc, trackId, "buf-fade", 0, 4).execute(doc);
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  renderWithContext(<ArrangementPanel />, { services });
  const clipEl = document.querySelector<HTMLElement>(".arr-audio-clip");
  expect(clipEl, "audio clip did not render — the probe measured nothing").not.toBeNull();
  const fadeOut = clipEl!.querySelector<HTMLElement>(".arr-audio-clip-handle-fade.right");
  const fadeIn = clipEl!.querySelector<HTMLElement>(".arr-audio-clip-handle-fade.left");
  expect(fadeOut, "fade-out handle did not render").not.toBeNull();
  expect(fadeIn, "fade-in handle did not render").not.toBeNull();
  expect(document.querySelector(".arr-lane"), "lane element missing — bar math would be inert").not.toBeNull();
  return { project, clipId: doc.arrangement.audioClips![0]!.id, fadeOut: fadeOut!, fadeIn: fadeIn! };
}

const clipOf = (project: ProjectStore, clipId: string) =>
  project.doc.arrangement.audioClips!.find((c) => c.id === clipId)!;

afterEach(() => cleanup());

describe("arrangement fade handle gesture (seam: arrangement-fade-handles)", () => {
  it("dragging the fade-out handle left commits ONE longer fade", () => {
    const { project, clipId, fadeOut } = setup();
    expect(clipOf(project, clipId).fadeOut).toBe(0);

    // −6 px = −0.2 bar ≈ −0.39 s of fade, nowhere near the 2 s ceiling.
    fireEvent.pointerDown(fadeOut, { button: 0, clientX: 500, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(fadeOut, { clientX: 494, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(fadeOut, { pointerId: 1 });

    const clip = clipOf(project, clipId);
    expect(clip.fadeOut).toBeGreaterThan(0);
    expect(clip.fadeOut).toBeLessThan(2);
    expect(clip.fadeIn, "the fade-out gesture must not touch fade-in").toBe(0);
    expect(project.undoStackLength).toBe(1); // one fade commit (the clip was seeded straight into the doc)
  });

  it("a large drag clamps the fade to the 2 s ceiling", () => {
    const { project, clipId, fadeOut } = setup();

    // −150 px = −5 bars → far beyond the ceiling.
    fireEvent.pointerDown(fadeOut, { button: 0, clientX: 500, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(fadeOut, { clientX: 350, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(fadeOut, { pointerId: 1 });

    expect(clipOf(project, clipId).fadeOut).toBe(2);
    expect(project.undoStackLength).toBe(1);
  });

  it("NEGATIVE: pressing the handle and releasing with NO move commits nothing", () => {
    const { project, clipId, fadeOut } = setup();

    fireEvent.pointerDown(fadeOut, { button: 0, clientX: 500, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(fadeOut, { pointerId: 1 });

    expect(clipOf(project, clipId).fadeOut).toBe(0);
    expect(project.undoStackLength).toBe(0); // nothing committed
  });

  it("NEGATIVE: dragging right at the floor (already 0) commits nothing", () => {
    const { project, clipId, fadeOut } = setup();

    // fadeOut is already 0; pulling right would compute a negative value,
    // which clamps straight back to 0 — no change, no undo entry.
    fireEvent.pointerDown(fadeOut, { button: 0, clientX: 500, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(fadeOut, { clientX: 530, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(fadeOut, { pointerId: 1 });

    expect(clipOf(project, clipId).fadeOut).toBe(0);
    expect(project.undoStackLength).toBe(1);
  });

  it("NEGATIVE: an interrupted fade drag (pointercancel) commits nothing", () => {
    const { project, clipId, fadeOut } = setup();

    fireEvent.pointerDown(fadeOut, { button: 0, clientX: 500, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(fadeOut, { clientX: 350, clientY: 10, pointerId: 1 });
    fireEvent.pointerCancel(fadeOut, { pointerId: 1 });

    expect(clipOf(project, clipId).fadeOut).toBe(0);
    expect(project.undoStackLength).toBe(1);
  });
});
