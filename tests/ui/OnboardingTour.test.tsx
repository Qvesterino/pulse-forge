import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnboardingTour } from "../../src/ui/OnboardingTour";
import { mockServices, renderWithContext } from "../helpers";

describe("OnboardingTour", () => {
  beforeEach(() => {
    window.localStorage.removeItem("pf-tour-v1");
    // Defer cleanup of `tourActive` between tests would require re-importing
    // the module — instead each test waits on the initial 600 ms timeout.
    vi.useRealTimers();
  });

  it("renders nothing when the tour has already been completed (localStorage flag)", () => {
    window.localStorage.setItem("pf-tour-v1", "1");
    renderWithContext(<OnboardingTour />, { services: mockServices() });
    expect(screen.queryByRole("dialog", { name: "Onboarding tour" })).not.toBeInTheDocument();
  });

  it("appears on first run after the boot delay and shows the first step", async () => {
    renderWithContext(<OnboardingTour />, { services: mockServices() });
    expect(screen.queryByText(/MAKE SOUND/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/1\/4 — MAKE SOUND/)).toBeInTheDocument());
  });

  it("NEXT advances to the next tour step", async () => {
    const user = userEvent.setup();
    renderWithContext(<OnboardingTour />, { services: mockServices() });
    await waitFor(() => expect(screen.getByRole("button", { name: "NEXT" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "NEXT" }));
    expect(screen.getByText(/2\/4 — PROGRAM THE BEAT/)).toBeInTheDocument();
  });

  it("SKIP closes the tour, persists the flag, and flushes the save service", async () => {
    const services = mockServices();
    const user = userEvent.setup();
    renderWithContext(<OnboardingTour />, { services });
    await waitFor(() => expect(screen.getByRole("button", { name: "Skip tour" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Skip tour" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Onboarding tour" })).not.toBeInTheDocument());
    expect(window.localStorage.getItem("pf-tour-v1")).toBe("1");
    expect(services.flushSave).toHaveBeenCalled();
  });

  it("the final step offers a LET'S FORGE button that closes the tour", async () => {
    const user = userEvent.setup();
    renderWithContext(<OnboardingTour />, { services: mockServices() });
    await waitFor(() => expect(screen.getByRole("button", { name: "NEXT" })).toBeInTheDocument());
    // Advance through 3 NEXT clicks (steps 1→2→3→4).
    for (let i = 0; i < 3; i++) {
      act(() => {
        // userEvent awaits, so each click only fires after the previous one
        // is committed by React.
      });
    }
    // We cannot await sequentially inside a sync loop deterministically;
    // instead click manually three times.
    await user.click(screen.getByRole("button", { name: "NEXT" }));
    await user.click(screen.getByRole("button", { name: "NEXT" }));
    await user.click(screen.getByRole("button", { name: "NEXT" }));
    const forge = screen.getByRole("button", { name: /FORGE/ });
    await user.click(forge);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Onboarding tour" })).not.toBeInTheDocument());
    expect(window.localStorage.getItem("pf-tour-v1")).toBe("1");
  });
});
