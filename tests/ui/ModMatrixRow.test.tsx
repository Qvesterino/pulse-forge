/**
 * Mod matrix shared UI: the Inspector/plugin render MOD A/B + MOD LFO as a
 * compact routed pair instead of seven raw rows. Commits go through the
 * generic setInstrumentParam command, so the mock store sees plain numeric
 * writes keyed by the mod param ids.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModMatrixRow } from "../../src/ui/ModMatrixRow";
import { defaultInstrumentParams } from "../../src/instruments/registry";
import type { InstrumentTrack, ProjectDocument } from "../../src/project-model/types";

function makeTrack(instrument: InstrumentTrack["instrument"], params: Record<string, number> = {}): InstrumentTrack {
  return {
    id: `track-${instrument}`,
    kind: "instrument",
    instrument,
    name: "Test",
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sampleId: null,
    params: { ...defaultInstrumentParams(instrument), ...params },
    effects: [],
    sends: {},
  };
}

function renderRow(instrument: InstrumentTrack["instrument"], params: Record<string, number> = {}) {
  const execute = vi.fn();
  const track = makeTrack(instrument, params);
  // setInstrumentParam resolves the track from the doc — include it.
  const doc = { tracks: [track] } as unknown as ProjectDocument;
  render(<ModMatrixRow track={track} doc={doc} services={{ store: { execute } }} />);
  return { execute };
}

describe("ModMatrixRow", () => {
  it("renders both routes with source/destination selects and an LFO slider", () => {
    renderRow("analog");
    expect(screen.getByRole("group", { name: "Mod matrix" })).toBeTruthy();
    expect(screen.getByLabelText("MOD A source")).toBeTruthy();
    expect(screen.getByLabelText("MOD A destination")).toBeTruthy();
    expect(screen.getByLabelText("MOD B source")).toBeTruthy();
    expect(screen.getByLabelText("MOD B destination")).toBeTruthy();
    // ENV/LFO/VEL/PRESS sources; CUTOFF + AMP destinations on analog
    const src = screen.getByLabelText("MOD A source") as HTMLSelectElement;
    expect(src.options.length).toBe(4);
    const dst = screen.getByLabelText("MOD A destination") as HTMLSelectElement;
    expect([...dst.options].map((o) => o.value).sort()).toEqual(["0", "1", "3"]); // OFF/CUTOFF/AMP
  });

  it("changing a route commits the mod param through the store", async () => {
    const user = userEvent.setup();
    const { execute } = renderRow("analog");
    await user.selectOptions(screen.getByLabelText("MOD A source"), "2"); // LFO
    const last = execute.mock.calls.at(-1)?.[0] as { label?: string };
    expect(last.label).toContain("modASrc");
  });

  it("vocalchop offers no CUTOFF destination and wavetable keeps MORPH", () => {
    renderRow("vocalchop");
    const dst = screen.getByLabelText("MOD A destination") as HTMLSelectElement;
    expect([...dst.options].map((o) => o.value)).toEqual(["0", "3"]); // OFF + AMP only (no CUTOFF)
    cleanup();
    renderRow("wavetable");
    const wdst = screen.getByLabelText("MOD B destination") as HTMLSelectElement;
    expect([...wdst.options].some((o) => o.value === "0" && o.textContent === "MORPH")).toBe(true);
  });
});
