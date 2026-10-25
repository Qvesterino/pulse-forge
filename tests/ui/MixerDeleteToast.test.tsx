import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Mixer } from "../../src/ui/Mixer";
import { mockServices, renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ProjectStore } from "../../src/store/ProjectStore";
import { setBpm } from "../../src/commands/commands";
import type { Services } from "../../src/services";

function mixerWithRealStore() {
  const doc = createProjectFromTemplate("house");
  const store = new ProjectStore(doc);
  const services = { ...mockServices(doc), store } as unknown as Services;
  (services.engine as unknown as { previewTrackGain: unknown }).previewTrackGain = vi.fn();
  return { services, store };
}

describe("Mixer — track delete undo toast", () => {
  it("shows an UNDO toast after deleting a track and restores it", async () => {
    const user = userEvent.setup();
    const { services, store } = mixerWithRealStore();
    const first = store.getDoc().tracks[0]!;
    renderWithContext(<Mixer />, { services });

    await user.click(screen.getAllByTitle("Delete track")[0]!);

    expect(await screen.findByText(`Deleted “${first.name}”`)).toBeInTheDocument();
    expect(store.getDoc().tracks.some((track) => track.id === first.id)).toBe(false);
    expect(store.getDoc().tracks.length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "UNDO" }));

    expect(store.getDoc().tracks.some((track) => track.id === first.id)).toBe(true);
    expect(screen.queryByText(`Deleted “${first.name}”`)).not.toBeInTheDocument();
  });

  it("never reverts a newer edit from a stale toast", async () => {
    const user = userEvent.setup();
    const { services, store } = mixerWithRealStore();
    const survivor = store.getDoc().tracks[1]!;
    renderWithContext(<Mixer />, { services });

    await user.click(screen.getAllByTitle("Delete track")[0]!);
    expect(await screen.findByText(/Deleted/)).toBeInTheDocument();

    services.store.execute(setBpm(store.getDoc(), 140));
    expect(store.getDoc().bpm).toBe(140);

    await user.click(screen.getByRole("button", { name: "UNDO" }));

    expect(store.getDoc().bpm).toBe(140);
    expect(store.getDoc().tracks.some((track) => track.id === survivor.id)).toBe(true);
    expect(screen.queryByText(/Deleted/)).not.toBeInTheDocument();
  });
});
