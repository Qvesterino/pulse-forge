/**
 * Mobile layout V2 — fullscreen piano roll toggle + bottom-sheet wiring.
 * (The sheet presentation itself is CSS; here we test the state logic.)
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { PianoRollTrack } from "../../src/ui/PianoRoll";
import { Sequencer } from "../../src/ui/Sequencer";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack } from "../../src/project-model/types";
import { renderWithContext, mockServices } from "../helpers";

const doc = createProjectFromTemplate("house");
const instrumentTrack = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument");
const pattern = doc.patterns[0];

function renderPiano(overrides: Partial<Parameters<typeof PianoRollTrack>[0]> = {}) {
  const services = mockServices(doc);
  return renderWithContext(
    <PianoRollTrack
      track={instrumentTrack!}
      pattern={pattern}
      playheadStep={-1}
      selectedNote={null}
      onSelectNote={vi.fn()}
      scaleSnap={false}
      {...overrides}
    />,
    { services },
  );
}

describe("fullscreen piano roll", () => {
  it("is inline by default — no fullscreen class, no toggle button", () => {
    const { container } = renderPiano();
    expect(container.querySelector(".pianoroll-wrap.pr-fullscreen")).toBeNull();
    expect(container.querySelector(".pr-fullscreen-toggle")).toBeNull();
  });

  it("applies the fullscreen class and aria state from props", () => {
    const { container } = renderPiano({ fullscreen: true, onToggleFullscreen: vi.fn() });
    expect(container.querySelector(".pianoroll-wrap.pr-fullscreen")).toBeTruthy();
    const button = container.querySelector<HTMLButtonElement>(".pr-fullscreen-toggle")!;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Exit fullscreen piano roll");
  });

  it("toggles through the callback", () => {
    const onToggle = vi.fn();
    const { container } = renderPiano({ fullscreen: false, onToggleFullscreen: onToggle });
    const button = container.querySelector<HTMLButtonElement>(".pr-fullscreen-toggle")!;
    expect(button.textContent).toBe("⤢");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("Sequencer wires the toggle per track (only that track goes fullscreen)", () => {
    const services = mockServices(doc);
    const props = {
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
    const { container } = renderWithContext(<Sequencer {...props} />, { services });

    const toggle = container.querySelector<HTMLButtonElement>(".pr-fullscreen-toggle");
    expect(toggle).toBeTruthy();
    expect(container.querySelector(".pianoroll-wrap.pr-fullscreen")).toBeNull();
    fireEvent.click(toggle!);
    expect(container.querySelector(".pianoroll-wrap.pr-fullscreen")).toBeTruthy();
    // Same button is now ✕ — clicking again returns inline.
    expect(toggle!.textContent).toBe("✕");
    fireEvent.click(toggle!);
    expect(container.querySelector(".pianoroll-wrap.pr-fullscreen")).toBeNull();
  });
});
