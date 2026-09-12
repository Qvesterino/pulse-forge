/**
 * MPE discoverability strip: the badge lights up once the controller sends
 * per-note pressure or CC74 timbre, and held notes show their live
 * pressure/timbre bars. The component reads `services.midi` — the test
 * feeds a fake with canned state.
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MpeIndicator } from "../../src/ui/MpeIndicator";
import { renderWithContext } from "../helpers";
import type { Services } from "../../src/services";

function withMidi(state: { connected: boolean; notes: Array<{ pitch: number; pressure: number; timbre: number }> }) {
  const midi = {
    subscribeMpe: (_l: () => void) => () => {},
    getMpeNotes: () => state.notes,
    isMpeConnected: () => state.connected,
  };
  return { services: { midi } } as unknown as { services: Services };
}

function withLegacyMidi() {
  return { services: { midi: { subscribeDevices: () => () => {} } } } as unknown as { services: Services };
}

describe("MpeIndicator", () => {
  it("shows an inactive badge and hint before any MPE message", () => {
    renderWithContext(<MpeIndicator />, withMidi({ connected: false, notes: [] }));
    const badge = screen.getByText("MPE");
    expect(badge.className).not.toContain("active");
    expect(screen.getByText("no MPE notes held")).toBeTruthy();
  });

  it("lights the badge and lists held notes with bars once MPE is live", () => {
    renderWithContext(
      <MpeIndicator />,
      withMidi({ connected: true, notes: [{ pitch: 60, pressure: 0.75, timbre: 0.5 }] }),
    );
    const badge = screen.getByText("MPE");
    expect(badge.className).toContain("active");
    expect(screen.getByText("C4")).toBeTruthy();
    const fills = screen.getAllByTitle("C4 — pressure 75%, timbre 50%");
    expect(fills.length).toBeGreaterThan(0);
  });

  it("degrades to an inactive badge when the MIDI facade predates MPE", () => {
    renderWithContext(<MpeIndicator />, withLegacyMidi());
    expect(screen.getByText("MPE").className).not.toContain("active");
    expect(screen.getByText("no MPE notes held")).toBeTruthy();
  });
});
