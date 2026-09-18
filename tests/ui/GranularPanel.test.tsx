import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GranularPanel } from "../../src/ui/GranularPanel";
import { mockServices } from "../helpers";
import type { InstrumentTrack } from "../../src/project-model/types";

const track: InstrumentTrack = {
  id: "track-grain",
  kind: "instrument",
  name: "Granular",
  instrument: "granular",
  params: { position: 0.25, size: 0.09, jitter: 0.15 },
  mute: false,
  solo: false,
  gain: 0.7,
  pan: 0.5,
  sampleId: "sample-1",
  effects: [],
  sends: {},
};

const docMock = {
  tracks: [track],
  tempo: 120,
  swing: 0,
  patterns: [],
  macros: [],
  palette: [],
  selectedPatternId: null,
} as unknown as Parameters<typeof GranularPanel>[0]["doc"];

describe("GranularPanel", () => {
  it("renders the granular playhead canvas with a sane aria-label", () => {
    const services = mockServices();
    render(<GranularPanel track={track} doc={docMock} services={services as any} />);
    expect(screen.getByLabelText(/Granular playhead/)).toBeInTheDocument();
  });

  it("the caption shows GRAIN and POS markers", () => {
    const services = mockServices();
    render(<GranularPanel track={track} doc={docMock} services={services as any} />);
    expect(screen.getByText(/GRANULAR PLAYHEAD/)).toBeInTheDocument();
    expect(screen.getByText(/POS/)).toBeInTheDocument();
    expect(screen.getByText(/GRAIN/)).toBeInTheDocument();
  });

  it("renders without crashing when the bank has no sample (empty-state path)", () => {
    const services = mockServices();
    render(
      <GranularPanel
        track={{ ...track, sampleId: null } as InstrumentTrack}
        doc={docMock}
        services={services as any}
      />,
    );
    expect(screen.getByLabelText(/Granular playhead/)).toBeInTheDocument();
  });

  it("reading the test track params shows position at 25%", () => {
    const services = mockServices();
    render(<GranularPanel track={track} doc={docMock} services={services as any} />);
    // The label "position XX%" reflects what the canvas-bound aria-label is rendering.
    expect(screen.getByLabelText(/position 25%/)).toBeInTheDocument();
  });
});
