import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
// (userEvent removed — unused)
import { WavetablePanel } from "../../src/ui/WavetablePanel";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack, ProjectDocument } from "../../src/project-model/types";

function wtDoc(): { doc: ProjectDocument; track: InstrumentTrack } {
  const doc = createProjectFromTemplate("house");
  const track: InstrumentTrack = {
    id: "wt-track",
    kind: "instrument",
    instrument: "wavetable",
    name: "WT",
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sampleId: null,
    params: {},
    effects: [],
    sends: {},
  };
  return { doc: { ...doc, tracks: [...doc.tracks, track] }, track };
}

describe("WavetablePanel", () => {
  it("renders the wavetable canvas with the table name in the aria-label", () => {
    const { doc, track } = wtDoc();
    renderWithContext(
      <WavetablePanel
        track={track}
        doc={doc}
        services={mockServices() as Parameters<typeof WavetablePanel>[0]["services"]}
      />,
    );
    const canvas = screen.getByLabelText(/Wavetable .* — \d+ frames/);
    expect(canvas).toBeInTheDocument();
    expect(canvas.tagName.toLowerCase()).toBe("canvas");
  });

  it("renders MOD A and MOD B modulation rows with source/destination selectors", () => {
    const { doc, track } = wtDoc();
    renderWithContext(
      <WavetablePanel
        track={track}
        doc={doc}
        services={mockServices() as Parameters<typeof WavetablePanel>[0]["services"]}
      />,
    );

    expect(screen.getByRole("combobox", { name: "MOD A source" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "MOD A destination" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "MOD B source" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "MOD B destination" })).toBeInTheDocument();
  });

  it("changing the MOD A destination commits a setInstrumentParam command", () => {
    const { doc, track } = wtDoc();
    const services = mockServices();
    renderWithContext(
      <WavetablePanel
        track={track}
        doc={doc}
        services={services as Parameters<typeof WavetablePanel>[0]["services"]}
      />,
    );

    const dst = screen.getByRole("combobox", { name: "MOD A destination" }) as HTMLSelectElement;
    fireEvent.change(dst, { target: { value: "2" } });

    expect(services.store.execute).toHaveBeenCalled();
    const call = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string;
    };
    expect(call.type).toBe("setInstrumentParam");
  });

  it("exposes a MOD LFO rate slider that defaults to the source's rate value", () => {
    const { doc, track } = wtDoc();
    renderWithContext(
      <WavetablePanel
        track={track}
        doc={doc}
        services={mockServices() as Parameters<typeof WavetablePanel>[0]["services"]}
      />,
    );
    const lfo = screen.getByRole("slider", { name: "MOD LFO" });
    expect(lfo).toBeInTheDocument();
    expect(lfo).toHaveAttribute("aria-valuenow");
  });
});
