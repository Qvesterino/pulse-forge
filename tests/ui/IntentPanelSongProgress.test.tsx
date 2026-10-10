import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { mockServices, renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

/**
 * FULL-SONG PROGRESS TELEMETRY (2026-10-10) — buildSong reported sections
 * as prose in the status line only; a multi-section song build (the longest
 * interactive wait in the product) showed an undifferentiated spinner. The
 * panel now receives the STRUCTURED progress ({ done, total, label })
 * alongside the text and renders a real progress bar with the section
 * counter while the build runs, tearing it down when the draft lands or
 * the build fails.
 *
 * The test drives the REAL deterministic engine (no mocks): the progressbar
 * must appear mid-build and be gone once the build settles.
 */
describe("IntentPanel — full-song progress telemetry", () => {
  it("renders the section progress bar during a song build and tears it down after", async () => {
    const doc = createProjectFromTemplate("house");
    renderWithContext(<IntentPanel />, { services: mockServices(doc) });

    const textarea = screen.getByLabelText(/Intent description/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "house 124" } });

    const songButton = screen.getByRole("button", { name: /♪ SONG/ });
    fireEvent.click(songButton);

    // MID-BUILD: the structured progress surfaces as a real progressbar —
    // a section counter plus the section label, never stuck at zero total.
    await waitFor(
      () => {
        const bar = screen.queryByRole("progressbar", { name: /Building song/i });
        expect(bar).not.toBeNull();
        const now = Number(bar!.getAttribute("aria-valuenow"));
        const total = Number(bar!.getAttribute("aria-valuemax"));
        expect(total).toBeGreaterThan(0);
        expect(now).toBeGreaterThanOrEqual(1);
        expect(now).toBeLessThanOrEqual(total);
      },
      { timeout: 20000 },
    );

    // TEARDOWN: once the build settles (draft installed or preview failed —
    // jsdom has no audio stack), the bar is gone and the panel is interactive.
    await waitFor(
      () => {
        expect(screen.queryByRole("progressbar", { name: /Building song/i })).toBeNull();
        const songButton2 = screen.getByRole("button", { name: /♪ SONG/ }) as HTMLButtonElement;
        expect(songButton2.disabled).toBe(false);
      },
      { timeout: 30000 },
    );
  }, 60000);
});
