import { describe, expect, it, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnboardingTour } from "../../src/ui/OnboardingTour";
import { mockServices, renderWithContext } from "../helpers";

describe("OnboardingTour", () => {
  beforeEach(() => {
    window.localStorage.removeItem("pf-tour-v1");
    window.localStorage.removeItem("pf-transfer-tour-v1");
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
    // Advance through the whole first-song route and pin its core work path.
    await user.click(screen.getByRole("button", { name: "NEXT" }));
    await user.click(screen.getByRole("button", { name: "NEXT" }));
    expect(screen.getByText(/3\/4 — ARRANGE & MIX/)).toBeInTheDocument();
    expect(screen.getByText(/Switch between PATTERN and SONG/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "NEXT" }));
    expect(screen.getByText(/4\/4 — SAVE & EXPORT/)).toBeInTheDocument();
    expect(screen.getByText(/Press Ctrl\+S to save now/)).toBeInTheDocument();
    const forge = screen.getByRole("button", { name: /FORGE/ });
    await user.click(forge);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Onboarding tour" })).not.toBeInTheDocument());
    expect(window.localStorage.getItem("pf-tour-v1")).toBe("1");
  });

  it("does not show drum-programming instructions for a transferred DAW project", async () => {
    const user = userEvent.setup();
    const doc = mockServices().store.getDoc();
    doc.transferOrigin = { version: 1, kind: "aligned-audio-midi", sourceDaw: "cubase" };
    window.localStorage.setItem("pf-tour-v1", "1");

    renderWithContext(<OnboardingTour sourceDaw={doc.transferOrigin.sourceDaw} />, { services: mockServices(doc) });

    await waitFor(() => expect(screen.getByText(/1\/4 — CUBASE TO KYX/)).toBeInTheDocument());
    expect(screen.getByText(/Your audio lanes start together at bar 1/)).toBeInTheDocument();
    expect(screen.queryByText(/MAKE SOUND|PROGRAM THE BEAT/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "NEXT" }));
    expect(
      screen.getByText(/song clips in the arrangement; use the drum grid to build new patterns/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "NEXT" }));
    expect(screen.getByText(/Open the command palette with Ctrl\+K/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "NEXT" }));
    expect(screen.getByText(/Save this KYX project with Ctrl\+S/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /LET'S FORGE/ }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Onboarding tour" })).not.toBeInTheDocument());
    expect(window.localStorage.getItem("pf-tour-v1")).toBe("1");
    expect(window.localStorage.getItem("pf-transfer-tour-v1")).toBe("1");
  });
});
