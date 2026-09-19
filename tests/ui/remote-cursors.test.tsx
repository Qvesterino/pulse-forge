/**
 * Collab presence cursors — the awareness → editor overlay flow.
 *
 * Uses a fake CollabSession (subscribe + remoteCursors + setCursor spy):
 * the awareness transport itself is covered by the collab server tests;
 * here we verify publishing (hover → setCursor) and rendering (remote
 * cursor → colored marker on the right cell) for sequencer + piano roll.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Sequencer } from "../../src/ui/Sequencer";
import { PianoRollTrack } from "../../src/ui/PianoRoll";
import { cursorsAt } from "../../src/ui/remoteCursors";
import type { RemoteCursor } from "../../src/collab/CollaborationProvider";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack } from "../../src/project-model/types";
import { renderWithContext, mockServices } from "../helpers";

function fakeCollab(cursors: RemoteCursor[] = []) {
  const setCursor = vi.fn();
  const listeners = new Set<() => void>();
  const collab = {
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    remoteCursors: cursors,
    setCursor,
  };
  return { collab, setCursor };
}

function baseDoc() {
  return createProjectFromTemplate("house");
}

beforeEach(() => {
  // jsdom fires pointer events without PointerEvent in older versions —
  // ensure the constructor exists so pointerType init lands on the event.
  if (typeof (globalThis as any).PointerEvent === "undefined") {
    (globalThis as any).PointerEvent = class extends MouseEvent {
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? "";
      }
    };
  }
});

const defaultProps = {
  selectedPadId: "",
  selectedTrackId: "",
  onSelectTrack: vi.fn(),
  onSelectPad: vi.fn(),
  selectedNote: null,
  onSelectNote: vi.fn(),
  stepSelection: null,
  onSelectSteps: vi.fn(),
  scaleSnap: false,
};

describe("cursorsAt", () => {
  it("matches every provided coordinate exactly", () => {
    const remote: RemoteCursor[] = [
      {
        user: { id: "a", name: "Nova", color: "#f00" },
        cursor: { view: "sequencer", patternId: "p1", padId: "kick", stepIndex: 2 },
      },
      {
        user: { id: "b", name: "Echo", color: "#0f0" },
        cursor: { view: "sequencer", patternId: "p1", padId: "kick", stepIndex: 4 },
      },
      {
        user: { id: "c", name: "Prism", color: "#00f" },
        cursor: { view: "pianoroll", patternId: "p1", trackId: "bass", pitch: 60 },
      },
    ];
    expect(cursorsAt(remote, { view: "sequencer", patternId: "p1", padId: "kick", stepIndex: 2 })).toHaveLength(1);
    expect(cursorsAt(remote, { view: "sequencer", patternId: "p1", padId: "kick", stepIndex: 3 })).toHaveLength(0);
    expect(cursorsAt(remote, { view: "pianoroll", trackId: "bass", pitch: 60 })).toHaveLength(1);
    // Same pad, different pattern → no match.
    expect(cursorsAt(remote, { view: "sequencer", patternId: "p2", padId: "kick", stepIndex: 2 })).toHaveLength(0);
  });
});

describe("sequencer remote cursors", () => {
  it("renders a colored marker on the cell a remote user points at", () => {
    const doc = baseDoc();
    const pattern = doc.patterns[0];
    const padId = Object.keys(pattern.rows)[0];
    const { collab } = fakeCollab([
      {
        user: { id: "u1", name: "Nova", color: "#22d3ee" },
        cursor: { view: "sequencer", patternId: pattern.id, padId, stepIndex: 3 },
      },
    ]);
    const services = mockServices(doc);
    (services as unknown as { collab: unknown }).collab = collab;

    const { container } = renderWithContext(<Sequencer {...defaultProps} />, { services });

    const dots = container.querySelectorAll<HTMLSpanElement>(".remote-cursor-dot");
    expect(dots).toHaveLength(1);
    expect(dots[0].style.background).toBe("rgb(34, 211, 238)");
    // The dot lives inside the exact data-pad/data-step cell.
    const cell = dots[0].closest("[data-pad][data-step]") as HTMLElement;
    expect(cell.dataset.pad).toBe(padId);
    expect(cell.dataset.step).toBe("3");
    expect(screen.getByLabelText("Nova is pointing at this step")).toBeTruthy();
  });

  it("publishes the hovered cell and clears on leaving the sequencer", () => {
    const doc = baseDoc();
    const pattern = doc.patterns[0];
    const padId = Object.keys(pattern.rows)[0];
    const { collab, setCursor } = fakeCollab();
    const services = mockServices(doc);
    (services as unknown as { collab: unknown }).collab = collab;

    const { container } = renderWithContext(<Sequencer {...defaultProps} />, { services });

    const cell = container.querySelector<HTMLElement>(`[data-pad="${padId}"][data-step="5"]`);
    expect(cell).toBeTruthy();
    fireEvent.pointerEnter(cell!, { pointerType: "mouse" });
    expect(setCursor).toHaveBeenCalledWith({
      view: "sequencer",
      patternId: pattern.id,
      padId,
      stepIndex: 5,
    });

    const section = container.querySelector("section.sequencer") as HTMLElement;
    fireEvent.pointerLeave(section);
    expect(setCursor).toHaveBeenLastCalledWith(null);
  });

  it("does not publish from touch pointers", () => {
    const doc = baseDoc();
    const padId = Object.keys(doc.patterns[0].rows)[0];
    const { collab, setCursor } = fakeCollab();
    const services = mockServices(doc);
    (services as unknown as { collab: unknown }).collab = collab;

    const { container } = renderWithContext(<Sequencer {...defaultProps} />, { services });
    fireEvent.pointerEnter(container.querySelector(`[data-pad="${padId}"][data-step="1"]`)!, {
      pointerType: "touch",
    });
    expect(setCursor).not.toHaveBeenCalled();
  });
});

describe("piano roll remote cursors", () => {
  function pianoProps(doc: ReturnType<typeof baseDoc>) {
    const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument")!;
    return { track, pattern: doc.patterns[0] };
  }

  it("renders a marker at the remote user's pitch/step cell", () => {
    const doc = baseDoc();
    const { track, pattern } = pianoProps(doc);
    const { collab } = fakeCollab([
      {
        user: { id: "u2", name: "Echo", color: "#a78bfa" },
        cursor: { view: "pianoroll", patternId: pattern.id, trackId: track.id, stepIndex: 2, pitch: 60 },
      },
    ]);
    const services = mockServices(doc);
    (services as unknown as { collab: unknown }).collab = collab;

    const { container } = renderWithContext(
      <PianoRollTrack
        track={track}
        pattern={pattern}
        playheadStep={-1}
        selectedNote={null}
        onSelectNote={vi.fn()}
        scaleSnap={false}
      />,
      { services },
    );

    const marker = container.querySelector<HTMLElement>(".pr-remote-cursor");
    expect(marker).toBeTruthy();
    expect(marker!.style.background).toBe("rgb(167, 139, 250)");
    // Step 2 of 16 → 12.5% from left; pitch 60 with PITCH_MAX 84, ROW_HEIGHT 14.
    expect(marker!.style.left).toBe("12.5%");
    expect(marker!.style.top).toBe(`${(84 - 60) * 14}px`);
  });

  it("publishes hover while moving over the grid and null on leave", () => {
    const doc = baseDoc();
    const { track, pattern } = pianoProps(doc);
    const { collab, setCursor } = fakeCollab();
    const services = mockServices(doc);
    (services as unknown as { collab: unknown }).collab = collab;

    const { container } = renderWithContext(
      <PianoRollTrack
        track={track}
        pattern={pattern}
        playheadStep={-1}
        selectedNote={null}
        onSelectNote={vi.fn()}
        scaleSnap={false}
      />,
      { services },
    );

    const grid = container.querySelector(".pianoroll-grid") as HTMLElement;
    // jsdom geometry is 0×0 (0/0 width → NaN) — give the grid a real size so
    // the first cell is deterministic: step 0, top pitch 84.
    vi.spyOn(grid, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 160,
      height: 100,
      right: 160,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerMove(grid, { pointerType: "mouse" });
    expect(setCursor).toHaveBeenCalledWith({
      view: "pianoroll",
      patternId: pattern.id,
      trackId: track.id,
      stepIndex: 0,
      pitch: 84,
    });
    // Same cell again → no duplicate publish.
    fireEvent.pointerMove(grid, { pointerType: "mouse" });
    expect(setCursor).toHaveBeenCalledTimes(1);

    fireEvent.pointerLeave(grid);
    expect(setCursor).toHaveBeenLastCalledWith(null);
  });
});
