import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnboardingHint } from "../../src/ui/OnboardingHint";
import { renderWithContext, mockServices } from "../helpers";

const STORAGE_KEY = "pulse-forge.onboarding.done.v1";

beforeEach(() => {
  localStorage.clear();
});

describe("OnboardingHint", () => {
  it("shows step 1 on first visit", () => {
    renderWithContext(<OnboardingHint />);
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(screen.getByText(/Press SPACE/)).toBeInTheDocument();
  });

  it("hides onboarding if already completed", () => {
    localStorage.setItem(STORAGE_KEY, "done");
    const { container } = renderWithContext(<OnboardingHint />);
    expect(container.innerHTML).toBe("");
  });

  it("dismisses on × click", async () => {
    const user = userEvent.setup();
    renderWithContext(<OnboardingHint />);
    await user.click(screen.getByLabelText("Dismiss onboarding"));
    renderWithContext(<OnboardingHint />);
    expect(screen.queryByText("1/3")).not.toBeInTheDocument();
  });

  it("shows DONE button on step 3", async () => {
    vi.useFakeTimers();
    const services = mockServices();
    const state = { subCb: null as (() => void) | null };
    const origSub = services.store.subscribe;
    (services.store as any).subscribe = (cb: () => void) => {
      state.subCb = cb;
      return origSub.call(services.store, cb);
    };
    renderWithContext(<OnboardingHint />, { services });
    (services.transport as any).playing = true;
    await vi.advanceTimersByTimeAsync(500);
    if (state.subCb) state.subCb();
    expect(screen.getByText("2/3")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
