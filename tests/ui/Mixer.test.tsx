import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
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
});
