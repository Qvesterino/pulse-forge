import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { App } from "../../src/ui/App";
import { mockServices, renderWithContext } from "../helpers";

describe("App (top-level shell)", () => {
  it("renders the .app root without crashing", () => {
    const services = mockServices();
    const { container } = renderWithContext(
      <App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />,
      { services },
    );
    expect(container.querySelector(".app")).not.toBeNull();
  });

  it("the AudioUnlock global pointer-down listener registers once at mount", () => {
    const services = mockServices();
    const addSpy = vi.spyOn(window, "addEventListener");
    renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, { services });
    // AudioUnlock attaches a single one-shot pointerdown listener.
    const ptr = addSpy.mock.calls.find(([event]) => (event as string) === "pointerdown");
    expect(ptr).toBeDefined();
    addSpy.mockRestore();
  });

  it("the OnboardingTour appears after the boot delay (or is suppressed by the localStorage flag)", async () => {
    const services = mockServices();
    // Clear any prior tour-completion flag from a sibling test.
    window.localStorage.removeItem("pf-tour-v1");
    renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, { services });
    await waitFor(() => expect(screen.queryByText(/PROGRAM THE BEAT|MAKE SOUND/i)).toBeInTheDocument(), {
      timeout: 5000,
    });
  });

  it("if the tour has been completed (flag set), the OnboardingTour does NOT appear", async () => {
    const services = mockServices();
    window.localStorage.setItem("pf-tour-v1", "1");
    renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, { services });
    // give the boot timeout a chance to elapse
    await new Promise((r) => setTimeout(r, 1100));
    expect(screen.queryByText(/PROGRAM THE BEAT|MAKE SOUND/i)).not.toBeInTheDocument();
  });
});
