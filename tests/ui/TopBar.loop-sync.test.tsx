import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { TopBar } from "../../src/ui/TopBar";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { Services } from "../../src/services";

/**
 * §5 "synchronization with external changes" + "the UI must not behave as a
 * second independent source of truth".
 *
 * The LOOP button keeps its value in local React state (`TopBar.tsx:109`),
 * which would be a second source of truth for transport state — except that a
 * shared rAF bus re-reads `transport.loopEnabled` every frame
 * (`TopBar.tsx:178-191`). That sync only works if the bus runs while the
 * transport is STOPPED, so this test drives an external `setLoop` with nothing
 * playing.
 */
/**
 * The shared `mockServices` transport is a hand-written stub with no
 * `setLoop` / `clearLoop`, so it cannot express "another surface changed the
 * loop". Extend the stub locally rather than editing the shared helper.
 */
function servicesWithRealLoopApi(doc: ReturnType<typeof createProjectFromTemplate>) {
  const services = mockServices(doc) as unknown as Services;
  const t = services.transport as unknown as Record<string, unknown>;
  let enabled = false;
  let start = 0;
  let end = 0;
  Object.defineProperties(t, {
    loopEnabled: { get: () => enabled, configurable: true },
    loopStart: { get: () => start, configurable: true },
    loopEnd: { get: () => end, configurable: true },
  });
  t.setLoop = (nextEnabled: boolean, nextStart: number, nextEnd: number) => {
    enabled = nextEnabled;
    start = Math.max(0, Math.floor(nextStart));
    end = nextEnd > 0 ? Math.max(start, Math.floor(nextEnd)) : 0;
  };
  t.clearLoop = () => {
    enabled = false;
    start = 0;
    end = 0;
  };
  return services;
}

describe("§5 TopBar loop is not a second source of truth", () => {
  it("reflects a loop change made outside the button, with the transport stopped", async () => {
    const services = servicesWithRealLoopApi(createProjectFromTemplate("house"));
    renderWithContext(<TopBar />, { services });

    const loopButton = screen.getByRole("button", { name: "Toggle loop region" });
    expect(loopButton).toHaveAttribute("aria-pressed", "false");

    // Another surface writes the transport directly — no click, no command.
    services.transport.setLoop(true, 2, 6);

    // The shared rAF bus must still be ticking with playback stopped.
    await waitFor(() => expect(loopButton).toHaveAttribute("aria-pressed", "true"));
    expect(loopButton.className).toContain("active");
  });

  it("returns to false when the loop is cleared externally", async () => {
    const services = servicesWithRealLoopApi(createProjectFromTemplate("house"));
    renderWithContext(<TopBar />, { services });

    const loopButton = screen.getByRole("button", { name: "Toggle loop region" });
    services.transport.setLoop(true, 2, 6);
    await waitFor(() => expect(loopButton).toHaveAttribute("aria-pressed", "true"));

    services.transport.clearLoop();
    await waitFor(() => expect(loopButton).toHaveAttribute("aria-pressed", "false"));
  });
});
