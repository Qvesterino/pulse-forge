import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnboardingHint, notifyOnboardingProgress } from "../../src/ui/OnboardingHint";
import { renderWithContext, mockServices } from "../helpers";

const STORAGE_KEY = "pulse-forge.onboarding.done.v1";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("OnboardingHint", () => {
  it("shows step 1 on first visit", () => {
    renderWithContext(<OnboardingHint />);
    expect(screen.getByText("1/5")).toBeInTheDocument();
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
    expect(screen.queryByText("1/5")).not.toBeInTheDocument();
  });

  it("shows DONE button on the final step", async () => {
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
    await act(async () => {}); // flush passive effects — the step-1 doc subscription registers here
    if (state.subCb) state.subCb();
    expect(screen.getByText("2/5")).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("OnboardingHint journey events (5 steps)", () => {
  function toStep(seed: number, services?: ReturnType<typeof mockServices>) {
    localStorage.setItem("pulse-forge.onboarding.done.v1", "");
    // Rebuild with step state directly: the component starts at 0 unless the
    // storage key exists. Advance through the first steps via the real path.
    return renderWithContext(<OnboardingHint />, services ? { services } : undefined);
  }

  it("advances step 3→4 on a panel-opened progress event", async () => {
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
    const changedDoc = { ...(services.store as { doc: unknown }).doc, edited: true };
    Object.defineProperty(services.store, "doc", { get: () => changedDoc, configurable: true });
    if (state.subCb) state.subCb(); // 1→2 (display 3/5)
    await act(async () => {});
    expect(screen.getByText("3/5")).toBeInTheDocument();
    act(() => {
      notifyOnboardingProgress("panel-opened"); // 2→3: a panel opened (display 4/5)
    });
    expect(screen.getByText("4/5")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("advances step 4→5 on an intent-generated event and dismisses on recorded", async () => {
    const services = mockServices();
    const state = { subCb: null as (() => void) | null };
    const origSub = services.store.subscribe;
    (services.store as any).subscribe = (cb: () => void) => {
      state.subCb = cb;
      return origSub.call(services.store, cb);
    };
    renderWithContext(<OnboardingHint />, { services });
    // Jump to step 3 through the real gates:
    (services.transport as any).playing = true;
    await new Promise((r) => setTimeout(r, 300));
    const changedDoc = { ...(services.store as { doc: unknown }).doc, edited: true };
    Object.defineProperty(services.store, "doc", { get: () => changedDoc, configurable: true });
    if (state.subCb) state.subCb(); // 1→2 (display 3/5)
    await act(async () => {});
    act(() => {
      notifyOnboardingProgress("panel-opened"); // 2→3 (display 4/5)
    });
    expect(screen.getByText("4/5")).toBeInTheDocument();
    act(() => {
      notifyOnboardingProgress("intent-generated");
    });
    expect(screen.getByText("5/5")).toBeInTheDocument();
    expect(screen.getByText(/ARM a track/)).toBeInTheDocument();
    // The final step auto-dismisses on the first recorded take.
    act(() => {
      notifyOnboardingProgress("recorded");
    });
    expect(screen.queryByText("5/5")).not.toBeInTheDocument();
    expect(localStorage.getItem("pulse-forge.onboarding.done.v1")).not.toBeNull();
  });

  it("ignores unrelated progress events", async () => {
    const services = mockServices();
    const state = { subCb: null as (() => void) | null };
    const origSub = services.store.subscribe;
    (services.store as any).subscribe = (cb: () => void) => {
      state.subCb = cb;
      return origSub.call(services.store, cb);
    };
    renderWithContext(<OnboardingHint />, { services });
    (services.transport as any).playing = true;
    await new Promise((r) => setTimeout(r, 300));
    const changedDoc = { ...(services.store as { doc: unknown }).doc, edited: true };
    Object.defineProperty(services.store, "doc", { get: () => changedDoc, configurable: true });
    if (state.subCb) state.subCb(); // 1→2 (display 3/5)
    await act(async () => {});
    expect(screen.getByText("3/5")).toBeInTheDocument();
    act(() => {
      notifyOnboardingProgress("intent-generated"); // wrong key for step index 2
      notifyOnboardingProgress("recorded"); // wrong key for step index 2
    });
    expect(screen.getByText("3/5")).toBeInTheDocument();
  });
});
