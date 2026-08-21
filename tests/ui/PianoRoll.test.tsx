import { describe, expect, it, vi } from "vitest";
import { PianoRollTrack } from "../../src/ui/PianoRoll";
import { renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

describe("PianoRollTrack", () => {
  it("renders piano roll SVG area", () => {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    const pattern = doc.patterns[0];
    const { container } = renderWithContext(
      <PianoRollTrack
        track={track}
        pattern={pattern}
        playheadStep={-1}
        selectedNote={null}
        onSelectNote={vi.fn()}
        scaleSnap={false}
      />,
    );
    expect(container.querySelector(".pianoroll")).toBeTruthy();
  });

  it("renders with piano roll class", () => {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    const pattern = doc.patterns[0];
    const { container } = renderWithContext(
      <PianoRollTrack
        track={track}
        pattern={pattern}
        playheadStep={-1}
        selectedNote={null}
        onSelectNote={vi.fn()}
        scaleSnap={false}
      />,
    );
    const svg = container.querySelector(".pianoroll");
    expect(svg).toBeTruthy();
  });
});
