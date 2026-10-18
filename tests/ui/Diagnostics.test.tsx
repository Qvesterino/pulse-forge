import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Diagnostics } from "../../src/ui/Diagnostics";
import { AudioEngine } from "../../src/audio-engine/AudioEngine";
import { mockServices, renderWithContext } from "../helpers";

describe("Diagnostics", () => {
  it("renders ENGINE tab by default", () => {
    renderWithContext(<Diagnostics />);
    expect(screen.getByText("ENGINE")).toBeInTheDocument();
    expect(screen.getByText("MEMORY")).toBeInTheDocument();
    expect(screen.getByText("PERFORMANCE")).toBeInTheDocument();
  });

  it("shows engine diagnostics rows", () => {
    renderWithContext(<Diagnostics />);
    expect(screen.getByText("bpm")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
  });

  it("switches to MEMORY tab", async () => {
    const user = userEvent.setup();
    renderWithContext(<Diagnostics />);
    await user.click(screen.getByText("MEMORY"));
    expect(screen.getByText("Load metrics")).toBeInTheDocument();
  });

  it("switches to PERFORMANCE tab and shows measure buttons", async () => {
    const user = userEvent.setup();
    renderWithContext(<Diagnostics />);
    await user.click(screen.getByText("PERFORMANCE"));
    expect(screen.getByText("MEASURE PATTERN")).toBeInTheDocument();
    expect(screen.getByText("MEASURE SONG")).toBeInTheDocument();
  });

  it("has correct aria-label", () => {
    renderWithContext(<Diagnostics />);
    expect(screen.getByRole("region", { name: /Engine diagnostics/ })).toBeInTheDocument();
  });

  it("shows the audio-boundary counters from the real engine diagnostics", () => {
    const rows = new AudioEngine().getDiagnostics();
    const services = mockServices();
    (services as unknown as { getDiagnostics: () => Record<string, string | number | boolean> }).getDiagnostics = () =>
      rows;
    renderWithContext(<Diagnostics />, { services });

    const drops = screen.getByText("audioBoundaryDrops").closest(".diagnostics-row");
    expect(drops?.textContent, "the dropped-event total must reach the panel").toContain("0");
    const kinds = screen.getByText("audioBoundaryDropKinds").closest(".diagnostics-row");
    expect(kinds?.textContent, "the per-kind row must render the real empty state").toContain("none");
    const closeFailures = screen.getByText("contextCloseFailures").closest(".diagnostics-row");
    expect(closeFailures?.textContent, "failed context closes must be visible, not a silent leak").toContain("0");
  });
});
