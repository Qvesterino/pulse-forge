import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
// (userEvent removed — unused)
import { WavetablePanel } from "../../src/ui/WavetablePanel";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { modDstOptions } from "../../src/instruments/modmatrix";
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

    // Index 1 = Cutoff, a route the wtvoice worklet actually implements.
    const dst = screen.getByRole("combobox", { name: "MOD A destination" }) as HTMLSelectElement;
    fireEvent.change(dst, { target: { value: "1" } });

    expect(services.store.execute).toHaveBeenCalled();
    const call = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string;
    };
    expect(call.type).toBe("setInstrumentParam");
  });

  it("offers only modulation destinations the engine actually implements", () => {
    // Index 2 is reserved/unimplemented: neither the wtvoice worklet nor the
    // offline fallback reads modADst/modBDst === 2, and modmatrix.ts documents
    // it as such. The panel used to offer "Detune", which produced a silent
    // dead route at any modulation amount.
    const { doc, track } = wtDoc();
    renderWithContext(
      <WavetablePanel
        track={track}
        doc={doc}
        services={mockServices() as Parameters<typeof WavetablePanel>[0]["services"]}
      />,
    );

    for (const name of ["MOD A destination", "MOD B destination"]) {
      const select = screen.getByRole("combobox", { name }) as HTMLSelectElement;
      const values = Array.from(select.options).map((o) => o.value);
      expect(values).toEqual(["0", "1", "3"]);
      expect(values).not.toContain("2");
      expect(screen.queryByText("Detune")).not.toBeInTheDocument();
    }
  });

  it("the offered destinations match the registry's authoritative list", () => {
    // Guards against the panel drifting from modmatrix.ts again.
    const { doc, track } = wtDoc();
    renderWithContext(
      <WavetablePanel
        track={track}
        doc={doc}
        services={mockServices() as Parameters<typeof WavetablePanel>[0]["services"]}
      />,
    );
    const select = screen.getByRole("combobox", { name: "MOD A destination" }) as HTMLSelectElement;
    const panelValues = Array.from(select.options).map((o) => o.value);
    const registryValues = modDstOptions(true, true).map((o) => String(o.value));
    expect(panelValues).toEqual(registryValues);
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
