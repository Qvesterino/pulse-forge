import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EffectRack } from "../../src/ui/EffectRack";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

describe("EffectRack", () => {
  function trackWithEffects(count: number) {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    track.effects = Array.from({ length: count }, (_, i) => ({
      id: `fx${i}`,
      type: "delay" as const,
      bypassed: false,
      params: {},
    }));
    return { doc, track };
  }

  it("shows empty message when no effects", () => {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    expect(screen.getByText(/No effects on this track/)).toBeInTheDocument();
  });

  it("renders effect devices", () => {
    const { doc, track } = trackWithEffects(2);
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    // fx-device-name class contains the effect name
    const deviceNames = document.querySelectorAll(".fx-device-name");
    expect(deviceNames.length).toBe(2);
  });

  it("shows add effect dropdown", () => {
    const { doc, track } = trackWithEffects(0);
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    expect(screen.getByLabelText("Add effect")).toBeInTheDocument();
  });

  it("disables move-earlier on first effect", () => {
    const { doc, track } = trackWithEffects(2);
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    const earlierBtns = screen.getAllByText("◀");
    expect(earlierBtns[0]).toBeDisabled();
    expect(earlierBtns[1]).not.toBeDisabled();
  });

  it("disables move-later on last effect", () => {
    const { doc, track } = trackWithEffects(2);
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    const laterBtns = screen.getAllByText("▶");
    expect(laterBtns[0]).not.toBeDisabled();
    expect(laterBtns[1]).toBeDisabled();
  });

  it("executes removeEffect on × click", async () => {
    const user = userEvent.setup();
    const { doc, track } = trackWithEffects(1);
    const { services } = renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    await user.click(screen.getByText("×"));
    expect(services.store.execute).toHaveBeenCalled();
  });

  it("executes toggleEffectBypass on B click", async () => {
    const user = userEvent.setup();
    const { doc, track } = trackWithEffects(1);
    const { services } = renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    await user.click(screen.getByText("B"));
    expect(services.store.execute).toHaveBeenCalled();
  });
});
