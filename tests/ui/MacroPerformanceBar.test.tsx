import { describe, expect, it, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MacroPerformanceBar } from "../../src/ui/MacroPerformanceBar";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

describe("MacroPerformanceBar", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("collapses the fader grid and remembers the choice", async () => {
    const user = userEvent.setup();
    const doc = createProjectFromTemplate("house");
    renderWithContext(<MacroPerformanceBar />, { services: mockServices(doc) });

    const toggle = screen.getByRole("button", { name: "MACROS" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".mixer-performance-grid")).not.toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".mixer-performance-grid")).toBeNull();
    expect(localStorage.getItem("pf-macros-collapsed")).toBe("1");
  });

  it("starts collapsed when previously collapsed", () => {
    localStorage.setItem("pf-macros-collapsed", "1");
    const doc = createProjectFromTemplate("house");
    renderWithContext(<MacroPerformanceBar />, { services: mockServices(doc) });

    expect(screen.getByRole("button", { name: "MACROS" })).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".mixer-performance-grid")).toBeNull();
  });
});
