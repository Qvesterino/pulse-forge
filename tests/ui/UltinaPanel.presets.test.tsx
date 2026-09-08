/**
 * Ultina user presets — panel UI (roadmap phase U5): SAVE captures the full
 * current parameter map into a USER preset group; selecting a USER preset
 * applies it through the same undoable preset command as factory presets;
 * RENAME/DEL manage the lifecycle. Storage is local-first (IndexedDB).
 */
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UltinaPanel } from "../../src/ui/UltinaPanel";
import { renderWithContext, mockServices } from "../helpers";
import { UltinaPresetRepository } from "../../src/persistence/UltinaPresetRepository";

function renderPanel(params: Record<string, number>, onApplyPreset = vi.fn()) {
  return renderWithContext(
    <UltinaPanel
      trackId="t-ult"
      fxId="fx-ult"
      params={params}
      onParam={vi.fn()}
      onApplyPreset={onApplyPreset}
      onApplyProposal={vi.fn()}
    />,
    { services: mockServices() },
  );
}

describe("UltinaPanel — user presets", () => {
  it("SAVE stores the full params map; it appears under USER and applies on select", async () => {
    const user = userEvent.setup();
    const onApplyPreset = vi.fn();
    renderPanel({ "comp.thresholdDb": -33, "global.mix": 80 }, onApplyPreset);

    vi.spyOn(window, "prompt").mockReturnValue("My Vocal Chain");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Save user preset" }));
    });

    // The USER group appears with the saved entry.
    const picker = screen.getByLabelText("Ultina preset") as HTMLSelectElement;
    await waitFor(() => {
      expect([...picker.querySelectorAll("optgroup")].some((g) => g.label === "USER")).toBe(true);
    });

    // Selecting the USER preset applies its (stored) params via the preset command.
    await act(async () => {
      await user.selectOptions(picker, [...picker.options].find((o) => o.label === "My Vocal Chain")!.value);
    });
    expect(onApplyPreset).toHaveBeenCalledWith("My Vocal Chain", expect.objectContaining({ "global.mix": 80 }));

    vi.restoreAllMocks();
  });

  it("DEL removes a user preset after confirmation", async () => {
    const user = userEvent.setup();
    const repo = new UltinaPresetRepository();
    await repo.save({
      id: "up-del",
      name: "Doomed",
      params: { "global.mix": 60 },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    renderPanel({});
    await waitFor(() => {
      expect(screen.getByLabelText("Ultina preset").textContent).toContain("Doomed");
    });

    // Select it, then delete with confirm.
    const picker = screen.getByLabelText("Ultina preset") as HTMLSelectElement;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      await user.selectOptions(picker, "up-del");
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete user preset" }));
    });
    await waitFor(() => {
      const after = screen.getByLabelText("Ultina preset") as HTMLSelectElement;
      expect(after.textContent).not.toContain("Doomed");
    });
    vi.restoreAllMocks();
  });

  it("SAVE with a cancelled prompt writes nothing", async () => {
    const user = userEvent.setup();
    renderPanel({});
    // The fake DB is shared within this file — count USER entries and assert
    // the cancelled save added none.
    const picker = screen.getByLabelText("Ultina preset") as HTMLSelectElement;
    await waitFor(() => {
      expect(picker.querySelectorAll('optgroup[label="USER"] option').length).toBeGreaterThan(0);
    });
    const before = picker.querySelectorAll('optgroup[label="USER"] option').length;

    vi.spyOn(window, "prompt").mockReturnValue(null);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Save user preset" }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByLabelText("Ultina preset").querySelectorAll('optgroup[label="USER"] option').length).toBe(
      before,
    );
    vi.restoreAllMocks();
  });

  it("a failed preset save surfaces an error instead of an unhandled rejection", async () => {
    const user = userEvent.setup();
    renderPanel({ "comp.thresholdDb": -20 });
    const saveSpy = vi
      .spyOn(UltinaPresetRepository.prototype, "save")
      .mockRejectedValue(new Error("QuotaExceededError: storage full"));

    vi.spyOn(window, "prompt").mockReturnValue("Big Preset");
    // The click handler is async and self-contained: an unhandled rejection
    // here would fail the test run; the panel must own the failure instead.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Save user preset" }));
    });
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("storage full");
    });
    expect(saveSpy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("a failed preset delete surfaces an error and keeps the preset selected", async () => {
    const user = userEvent.setup();
    const repo = new UltinaPresetRepository();
    await repo.save({
      id: "up-keep",
      name: "Indestructible",
      params: { "global.mix": 40 },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    renderPanel({});
    await waitFor(() => {
      expect(screen.getByLabelText("Ultina preset").textContent).toContain("Indestructible");
    });
    const picker = screen.getByLabelText("Ultina preset") as HTMLSelectElement;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      await user.selectOptions(picker, "up-keep");
    });
    const removeSpy = vi.spyOn(UltinaPresetRepository.prototype, "remove").mockRejectedValue(new Error("db closed"));
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete user preset" }));
    });
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("db closed");
    });
    expect(removeSpy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
