import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Mixer } from "../../src/ui/Mixer";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

describe("Mixer performance workflow", () => {
  it("surfaces the first four performance macros in the mixer", () => {
    const doc = createProjectFromTemplate("house");
    renderWithContext(<Mixer />, { services: mockServices(doc) });

    expect(screen.getByRole("group", { name: "Performance macros" })).toBeInTheDocument();
    expect(screen.getByText("DRUMS")).toBeInTheDocument();
    expect(screen.getByText("BASS")).toBeInTheDocument();
    expect(screen.getByText("MUSIC")).toBeInTheDocument();
    expect(screen.getByText("WIDTH")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Macro DRUMS" })).toHaveAttribute("aria-valuenow", "0.5");
  });

  it("reports the actual selected-track count in the batch FX toolbar", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    renderWithContext(<Mixer />, { services });

    expect(screen.getByText("BATCH FX → 3 TRACKS")).toBeInTheDocument();
  });

  it("reveals the FX rack after a batch add (device UI becomes visible)", async () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    const onOpenFxPanel = vi.fn();
    renderWithContext(<Mixer onOpenFxPanel={onOpenFxPanel} />, { services });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Batch effect type" }), "kaskada");
    await user.click(screen.getByRole("button", { name: /ADD TO/ }));

    expect(onOpenFxPanel).toHaveBeenCalledTimes(1);
  });
});
