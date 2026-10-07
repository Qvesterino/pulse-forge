import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";
import { TsarPanel } from "../../src/ui/TsarPanel";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { createInstrumentTrackModel } from "../../src/project-model/schema";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * T4 — TSAR PANEL (docs/TSAR-ROADMAP.md). The panel contract:
 *  - with no TSAR track it says so instead of rendering dead controls;
 *  - with a TSAR track it renders the source/matrix surfaces;
 *  - every control commits through the store (a command), never a direct write;
 *  - the factory browser filters and applies via `applyInstrumentPreset`.
 */

function tsarDoc(): ProjectDocument {
  const base = createProjectFromTemplate("empty");
  const track = createInstrumentTrackModel("tsar", 1);
  track.id = "tsar-ui-track";
  track.name = "TSAR Lead";
  return { ...base, tracks: [track] };
}

describe("TsarPanel", () => {
  it("explains the empty case when the project has no TSAR track", () => {
    renderWithContext(<TsarPanel />, { services: mockServices(createProjectFromTemplate("empty")) });
    expect(screen.getByRole("region", { name: "TSAR engine" })).toBeInTheDocument();
    expect(screen.getByText(/No TSAR track in this project/)).toBeInTheDocument();
  });

  it("renders the source surfaces for a TSAR track", () => {
    renderWithContext(<TsarPanel />, { services: mockServices(tsarDoc()) });
    expect(screen.getByText("SOURCE A")).toBeInTheDocument();
    expect(screen.getByText("SOURCE B")).toBeInTheDocument();
    expect(screen.getByText("MOD MATRIX")).toBeInTheDocument();
    expect(screen.getByText("SAMPLE FORGE")).toBeInTheDocument();
    expect(screen.getByLabelText("Forge target source")).toBeInTheDocument();
  });

  it("commits a parameter through the store as a command", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    // The mod slot selects are commands: change slot 1's source to ENV.
    const srcSelect = screen.getByLabelText("Mod 1 source");
    await user.selectOptions(srcSelect, "1");
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const command = executeSpy.mock.calls[0]![0] as { type: string };
    expect(command.type).toBe("setInstrumentParam");
  });

  it("filters the factory bank and applies a preset as a command", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    // The bank is 48 presets; filtering narrows the visible list.
    const list = document.querySelector(".tsar-preset-list")!;
    const allButtons = list.querySelectorAll(".tsar-preset");
    expect(allButtons.length).toBeGreaterThan(10);

    const filter = screen.getByLabelText("Filter TSAR presets");
    fireEvent.change(filter, { target: { value: "phonk" } });
    const phonk = [...list.querySelectorAll<HTMLButtonElement>(".tsar-preset")];
    expect(phonk.length).toBeGreaterThan(0);
    expect(phonk.length).toBeLessThan(allButtons.length);

    await user.click(phonk[0]!);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const command = executeSpy.mock.calls[0]![0] as { type: string };
    expect(command.type).toBe("applyInstrumentPreset");
  });

  it("switching a mod destination is a distinct command (matrix is wired)", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });
    await user.selectOptions(screen.getByLabelText("Mod 2 destination"), "5"); // AMP
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});
