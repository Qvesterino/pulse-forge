import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PresetBrowser } from "../../src/ui/PresetBrowser";
import { FACTORY_PRESETS } from "../../src/presets/factory";
import { getPresetMetadata } from "../../src/presets/catalog";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices, renderWithContext } from "../helpers";

describe("PresetBrowser audition workflow", () => {
  it("previews without mutating the project and applies through one command", async () => {
    const user = userEvent.setup();
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((candidate) => candidate.kind === "instrument");
    expect(track?.kind).toBe("instrument");
    if (!track || track.kind !== "instrument") throw new Error("instrument fixture missing");
    const preset = FACTORY_PRESETS.find((candidate) => candidate.instrument === track.instrument);
    expect(preset).toBeDefined();
    if (!preset) throw new Error("preset fixture missing");

    const { services } = renderWithContext(<PresetBrowser track={track} />, { services: mockServices(doc) });
    const previewButton = screen.getByRole("button", { name: `Preview ${preset.name}` });

    await user.click(previewButton);

    expect(services.engine.previewInstrumentPreset).toHaveBeenCalledWith(track.id, preset);
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(services.library.recordPreset).not.toHaveBeenCalled();
    expect(track.presetId).not.toBe(preset.id);
    expect(previewButton).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: `Apply ${preset.name}` }));

    expect(services.engine.stopPreview).toHaveBeenCalled();
    expect(services.store.execute).toHaveBeenCalledTimes(1);
    expect((services.store.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      type: "applyInstrumentPreset",
    });
    expect(services.library.recordPreset).toHaveBeenCalledWith(preset.id);
  });

  it("stops an active audition without applying the preset", async () => {
    const user = userEvent.setup();
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((candidate) => candidate.kind === "instrument");
    if (!track || track.kind !== "instrument") throw new Error("instrument fixture missing");
    const preset = FACTORY_PRESETS.find((candidate) => candidate.instrument === track.instrument);
    if (!preset) throw new Error("preset fixture missing");

    const { services } = renderWithContext(<PresetBrowser track={track} />, { services: mockServices(doc) });
    const previewButton = screen.getByRole("button", { name: `Preview ${preset.name}` });
    await user.click(previewButton);
    await user.keyboard("{Escape}");

    expect(services.engine.stopPreview).toHaveBeenCalledTimes(1);
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(services.library.recordPreset).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: `Preview ${preset.name}` })).toHaveAttribute("aria-pressed", "false");
  });

  it("filters the catalog by curated role and energy metadata", async () => {
    const user = userEvent.setup();
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((candidate) => candidate.kind === "instrument");
    if (!track || track.kind !== "instrument") throw new Error("instrument fixture missing");
    const presets = FACTORY_PRESETS.filter((candidate) => candidate.instrument === track.instrument);
    const preset = presets[0];
    if (!preset) throw new Error("preset fixture missing");
    const metadata = getPresetMetadata(preset);
    const { services } = renderWithContext(<PresetBrowser track={track} />, { services: mockServices(doc) });

    const roleFilter = screen.getByRole("button", { name: `ROLE: ${metadata.useCase.toUpperCase()}` });
    await user.click(roleFilter);
    expect(roleFilter).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: `Apply ${preset.name}` })).toBeInTheDocument();

    const energyFilter = screen.getByRole("button", { name: `ENERGY: ${metadata.energy.toUpperCase()}` });
    await user.click(energyFilter);
    expect(energyFilter).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: `Apply ${preset.name}` })).toBeInTheDocument();
    expect(services.store.execute).not.toHaveBeenCalled();
  });
});
