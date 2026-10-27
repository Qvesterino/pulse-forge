import { afterEach, describe, expect, it } from "vitest";
import { cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Mixer } from "../../src/ui/Mixer";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { renderWithContext, mockServices } from "../helpers";
import type { Services } from "../../src/services";

/**
 * MIXER MUTE / SOLO GESTURE GATE (seam: mixer-mute-solo)
 *
 * The seam ledger listed this OPEN: no spec clicked these buttons at all —
 * `mixer-batch.test.ts` is command-level only, so the wiring between the strip
 * button and `setTrackParams` was unguarded. These specs click the REAL strip
 * against a REAL `ProjectStore` and assert the negatives: Solo must not touch
 * Mute (and vice versa), and a second click must return the flag to false
 * instead of re-asserting it.
 */

function setup() {
  const doc = createProjectFromTemplate("house");
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  renderWithContext(<Mixer />, { services });
  return { project, trackId: doc.tracks[0]!.id };
}

/** The real channel strip of `trackId`, found through its name input. */
function stripOf(trackId: string): HTMLElement {
  const nameInput = document.querySelector(`[aria-label="Track ${trackId} name"]`);
  expect(nameInput, "track strip did not render — the probe measured nothing").not.toBeNull();
  return nameInput!.closest(".channel-strip") as HTMLElement;
}

function trackOf(project: ProjectStore, trackId: string) {
  const track = project.doc.tracks.find((t) => t.id === trackId);
  expect(track, "track vanished from the document").toBeDefined();
  return track!;
}

afterEach(() => cleanup());

describe("mixer mute / solo gesture (seam: mixer-mute-solo)", () => {
  it("the strip M button toggles mute through exactly one command", async () => {
    const { project, trackId } = setup();
    const user = userEvent.setup();
    const strip = stripOf(trackId);

    await user.click(within(strip).getByTitle("Mute track"));

    expect(trackOf(project, trackId).mute).toBe(true);
    expect(project.undoStackLength).toBe(1);
    // The button reflects the state (the at-a-glance LED class).
    expect(within(strip).getByTitle("Mute track").className).toContain("active-mute");
  });

  it("NEGATIVE: Solo does not touch Mute, and Mute does not touch Solo", async () => {
    const { project, trackId } = setup();
    const user = userEvent.setup();
    const strip = stripOf(trackId);

    await user.click(within(strip).getByTitle("Mute track"));
    await user.click(within(strip).getByTitle("Solo track"));

    const track = trackOf(project, trackId);
    expect(track.mute, "solo must not clear or set mute").toBe(true);
    expect(track.solo).toBe(true);

    await user.click(within(strip).getByTitle("Mute track"));
    const after = trackOf(project, trackId);
    expect(after.mute).toBe(false);
    expect(after.solo, "un-muting must not clear solo").toBe(true);
  });

  it("a second M click returns the flag to false (toggle, not assert)", async () => {
    const { project, trackId } = setup();
    const user = userEvent.setup();
    const strip = stripOf(trackId);

    await user.click(within(strip).getByTitle("Mute track"));
    expect(trackOf(project, trackId).mute).toBe(true);
    await user.click(within(strip).getByTitle("Mute track"));
    expect(trackOf(project, trackId).mute).toBe(false);
    expect(project.undoStackLength).toBe(2);
  });

  it("M/S announce the track and their pressed state to assistive tech (CF-02)", async () => {
    const { project, trackId } = setup();
    const user = userEvent.setup();
    const strip = stripOf(trackId);
    const trackName = trackOf(project, trackId).name;

    const mute = within(strip).getByTitle("Mute track");
    const solo = within(strip).getByTitle("Solo track");
    // A screen reader hears "Mute <track> button", not "M button", and the
    // pressed state is exposed rather than carried only by a CSS class.
    expect(mute).toHaveAttribute("aria-label", `Mute ${trackName}`);
    expect(solo).toHaveAttribute("aria-label", `Solo ${trackName}`);
    expect(mute).toHaveAttribute("aria-pressed", "false");
    expect(solo).toHaveAttribute("aria-pressed", "false");

    await user.click(mute);
    await user.click(solo);
    expect(within(strip).getByTitle("Mute track")).toHaveAttribute("aria-pressed", "true");
    expect(within(strip).getByTitle("Solo track")).toHaveAttribute("aria-pressed", "true");
  });
});
