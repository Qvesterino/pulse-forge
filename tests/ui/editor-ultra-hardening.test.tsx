import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { useSelection } from "../../src/ui/context";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addAudioTakeClip } from "../../src/commands/audioClips";
import { mockServices, renderWithContext } from "../helpers";
import type { Services } from "../../src/services";
import type { ProjectDocument } from "../../src/project-model/types";
import { BAR_TICKS } from "../../src/project-model/types";

/**
 * Ultra editor hardening (2026-10-06) — interaction-level regression coverage.
 *
 * Take-lane comp-range drag vs mid-gesture zoom: the drag now captures the
 * lane geometry (px width + px/bar) at pointerdown, the same discipline as
 * DragState.barWidth / audioDragRef.barWidth. Pre-fix, Ctrl+wheel zoom during
 * the drag re-rendered the lane at a new barWidth and the live pointer was
 * converted against the NEW geometry — the same pixel suddenly meant a
 * different tick and the comp range teleported left.
 */

// jsdom rects are all-zero, which collapses the panel's pixel hit-zones (an
// audio clip is "always the right edge") and lane width fallbacks. Give every
// element a wide, left-anchored rect so clientX maps straight to lane px.
let rectSpy: ReturnType<typeof vi.spyOn> | undefined;
function useWideRects(): void {
  rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 10_000,
    bottom: 100,
    width: 10_000,
    height: 100,
    toJSON: () => ({}),
  } as DOMRect);
}
afterEach(() => {
  rectSpy?.mockRestore();
  rectSpy = undefined;
});

const SelectionProbe = () => {
  const selection = useSelection();
  return <div data-testid="clip-selection">{selection.clipIds.join(",")}</div>;
};

function takeGroupDoc(): { doc: ProjectDocument; groupId: string } {
  let doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((t) => t.kind !== "group")!;
  doc = addAudioTakeClip(doc, "grp-ultra", "take-1", track.id, "buf-a", 0, 8).execute(doc);
  doc = addAudioTakeClip(doc, "grp-ultra", "take-2", track.id, "buf-b", 0, 8).execute(doc);
  return { doc, groupId: "grp-ultra" };
}

function renderLiveArrangement(doc: ProjectDocument) {
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  const utils = renderWithContext(
    <>
      <ArrangementPanel />
      <SelectionProbe />
    </>,
    { services },
  );
  return { ...utils, project };
}

describe("take-lane comp range drag under mid-gesture zoom (§13/§31)", () => {
  it("keeps the range in the geometry captured at pointerdown", () => {
    useWideRects();
    const { doc } = takeGroupDoc();
    const { project } = renderLiveArrangement(doc);

    // Select the take clip without committing an edit: pointerdown sets the
    // audio selection synchronously; pointercancel aborts the gesture.
    const clip = document.querySelector<HTMLElement>(".arr-audio-clip")!;
    expect(clip).toBeTruthy();
    fireEvent.pointerDown(clip, { button: 0, pointerId: 1, clientX: 120 });
    fireEvent.pointerCancel(clip, { pointerId: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Show audio take lanes" }));
    const lanes = Array.from(document.querySelectorAll<HTMLElement>(".arr-audio-take-lane-track"));
    expect(lanes.length).toBeGreaterThanOrEqual(1);

    // BASE_BAR_WIDTH * zoom(1) = 30 px/bar. Drag from bar 2 ...
    const lane = lanes[0]!;
    fireEvent.pointerDown(lane, { button: 0, pointerId: 2, clientX: 60 });
    // ... zoom in mid-gesture (wheel is a native non-passive listener on the
    // scroll container) — barWidth re-renders to 30 * e^0.48 ≈ 48.5 ...
    const scroll = document.querySelector<HTMLElement>(".arr-lane-scroll")!;
    fireEvent.wheel(scroll, { ctrlKey: true, deltaY: -240, clientX: 400 });
    // ... then move the pointer HALF A BAR further in the CAPTURED geometry.
    fireEvent.pointerMove(lane, { pointerId: 2, clientX: 75 });
    fireEvent.pointerUp(lane, { pointerId: 2, clientX: 75 });

    // The comp command is the observable: it runs against the final range.
    fireEvent.click(screen.getByRole("button", { name: "Comp selected take-lane range" }));
    const next = project.getDoc();
    const group = next.arrangement.takeGroups?.find((g) => g.id === "grp-ultra");
    expect(group?.compTakeId).toBeDefined();
    const compClips = (next.arrangement.audioClips ?? []).filter((c) => c.takeId === group!.compTakeId);
    expect(compClips.length).toBeGreaterThanOrEqual(1);
    // Captured geometry: [2, 2.5] bars exactly. Pre-fix the live pointer was
    // re-converted at the new barWidth (75/48.5 ≈ 1.55 bars) and the range
    // teleported to ≈ [1.55, 2].
    expect(Math.min(...compClips.map((c) => c.startBar))).toBeCloseTo(2, 6);
    const spanBars =
      Math.max(...compClips.map((c) => c.startBar + c.lengthBars)) - Math.min(...compClips.map((c) => c.startBar));
    expect(spanBars).toBeCloseTo(0.5, 6);
    // Source takes stay immutable.
    expect((next.arrangement.audioClips ?? []).filter((c) => c.takeId === "take-1").length).toBe(1);
    void BAR_TICKS;
  });
});
