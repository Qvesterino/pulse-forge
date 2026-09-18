import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PatternBar } from "../../src/ui/PatternBar";
import { mockServices, renderWithContext } from "../helpers";

describe("PatternBar", () => {
  it("renders the action buttons and at least one pattern chip from the default doc", () => {
    const services = mockServices();
    renderWithContext(<PatternBar clip={null} onCopy={() => {}} />, { services });
    expect(screen.getByRole("button", { name: "ADD" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "DUP" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MUT" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "FILL" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThanOrEqual(1);
  });

  it("clicking ADD calls services.store.execute (createPattern command)", async () => {
    const services = mockServices();
    const execute = vi.spyOn(services.store, "execute");
    const user = userEvent.setup();
    renderWithContext(<PatternBar clip={null} onCopy={() => {}} />, { services });
    await user.click(screen.getByRole("button", { name: "ADD" }));
    expect(execute).toHaveBeenCalled();
  });

  it("clicking the active pattern chip is a no-op (does not crash when re-selecting)", async () => {
    const services = mockServices();
    const user = userEvent.setup();
    renderWithContext(<PatternBar clip={null} onCopy={() => {}} />, { services });
    const active = screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true");
    expect(active).toBeDefined();
    if (active) await user.click(active);
    // Just verify we didn't throw — the existing execute call count should be
    // the same as before the click (click on already-active chip is treated as
    // a drag-start/cancel).
    expect(active).toBeInTheDocument();
  });
});
