import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AudioUnlock } from "../../src/ui/AudioUnlock";
import { mockServices, renderWithContext } from "../helpers";

describe("AudioUnlock", () => {
  it("renders nothing while the AudioContext is running (or no coarse pointer)", () => {
    const services = mockServices();
    // jsdom has no real matchMedia — matchMedia()?.matches returns undefined,
    // coerced to false, so blocked stays false.
    renderWithContext(<AudioUnlock />, { services });
    expect(screen.queryByRole("button", { name: /TAP TO ENABLE AUDIO/ })).not.toBeInTheDocument();
  });

  it("renders the unlock banner when context is suspended on a coarse-pointer device", () => {
    const services = mockServices();
    const fakeCtx = { state: "suspended" } as unknown as AudioContext;
    Object.defineProperty(services.engine, "context", {
      value: fakeCtx,
      writable: true,
      configurable: true,
    });
    // Stub matchMedia to claim this is a coarse-pointer (touch) device.
    const matchMedia = vi.fn(() => ({ matches: true, media: "", addListener: () => {}, removeListener: () => {} }));
    Object.defineProperty(window, "matchMedia", {
      value: matchMedia,
      writable: true,
      configurable: true,
    });

    renderWithContext(<AudioUnlock />, { services });
    expect(screen.getByRole("button", { name: /TAP TO ENABLE AUDIO/ })).toBeInTheDocument();
  });

  it("clicking the banner calls engine.ensureContext", async () => {
    const services = mockServices();
    const fakeCtx = { state: "suspended" } as unknown as AudioContext;
    Object.defineProperty(services.engine, "context", {
      value: fakeCtx,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "matchMedia", {
      value: () => ({ matches: true, media: "", addListener: () => {}, removeListener: () => {} }),
      writable: true,
      configurable: true,
    });

    const user = userEvent.setup();
    renderWithContext(<AudioUnlock />, { services });
    await user.click(screen.getByRole("button", { name: /TAP TO ENABLE AUDIO/ }));
    expect(services.engine.ensureContext).toHaveBeenCalled();
  });

  it("registers a one-shot pointerdown listener on the window at mount", () => {
    const services = mockServices();
    const addSpy = vi.spyOn(window, "addEventListener");
    renderWithContext(<AudioUnlock />, { services });
    expect(addSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), expect.objectContaining({ once: true }));
    addSpy.mockRestore();
  });
});
