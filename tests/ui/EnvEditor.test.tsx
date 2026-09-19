import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { EnvEditor } from "../../src/ui/EnvEditor";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack, ProjectDocument } from "../../src/project-model/types";

function synthTrack(): InstrumentTrack {
  const doc = createProjectFromTemplate("house");
  const t = doc.tracks.find((tr): tr is InstrumentTrack => tr.kind === "instrument");
  if (!t) throw new Error("expected instrument track");
  return t;
}

describe("EnvEditor", () => {
  it("renders the SVG envelope editor with the aria-label", () => {
    const track = synthTrack();
    const doc: ProjectDocument = createProjectFromTemplate("house");
    const { container } = renderWithContext(<EnvEditor track={track} doc={doc} services={mockServices()} />);
    expect(screen.getByLabelText(/DAHDSR envelope editor/i)).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders stage handles (circles) for the DAHDSR stages", () => {
    const track = synthTrack();
    const doc: ProjectDocument = createProjectFromTemplate("house");
    const { container } = renderWithContext(<EnvEditor track={track} doc={doc} services={mockServices()} />);
    const handles = container.querySelectorAll("circle.env-handle");
    expect(handles.length).toBeGreaterThanOrEqual(4);
  });

  it("renders the decay-loop cycle button and shape cycle buttons", () => {
    const track = synthTrack();
    const doc: ProjectDocument = createProjectFromTemplate("house");
    renderWithContext(<EnvEditor track={track} doc={doc} services={mockServices()} />);
    expect(screen.getByLabelText(/Cycle decay loop/i)).toBeInTheDocument();
    // shape cycle buttons (one per stage)
    expect(screen.getAllByLabelText(/Cycle .* shape/i).length).toBeGreaterThan(0);
  });
});
