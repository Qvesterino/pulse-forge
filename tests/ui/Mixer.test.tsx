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

  it("toggles the master buss glue through one command", async () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    renderWithContext(<Mixer />, { services });

    const user = userEvent.setup();
    const glue = screen.getByRole("button", { name: "Master glue" });
    expect(glue).toHaveAttribute("aria-pressed", "true");
    await user.click(glue);

    const executed = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { type: string },
    );
    expect(executed.some((c) => c.type === "setMasterConfig")).toBe(true);
  });

  it("shows the master TILT/TRIM knobs with the document's current values", () => {
    // Sound-quality pass: the song builder pre-sets tilt (genre tone) and the
    // loudness trim (genre reference) — the master strip must DISPLAY them.
    const doc = createProjectFromTemplate("house");
    const withKnobs = {
      ...doc,
      master: { ...doc.master, tiltDb: 1.5, loudnessTrimDb: -5.7 },
    };
    renderWithContext(<Mixer />, { services: mockServices(withKnobs) });

    expect(screen.getByRole("slider", { name: "TILT" })).toHaveAttribute("aria-valuenow", "1.5");
    expect(screen.getByRole("slider", { name: "TRIM" })).toHaveAttribute("aria-valuenow", "-5.7");
  });

  it("TILT/TRIM read 0 on a project that never touched the sound-quality pass", () => {
    const doc = createProjectFromTemplate("house");
    renderWithContext(<Mixer />, { services: mockServices(doc) });

    expect(screen.getByRole("slider", { name: "TILT" })).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByRole("slider", { name: "TRIM" })).toHaveAttribute("aria-valuenow", "0");
  });
});
