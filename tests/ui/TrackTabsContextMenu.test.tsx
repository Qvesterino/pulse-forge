import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrackTabs } from "../../src/ui/TrackTabs";
import { mockServices, renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ProjectStore } from "../../src/store/ProjectStore";
import type { Services } from "../../src/services";

function tabsHarness() {
  const doc = createProjectFromTemplate("house");
  const store = new ProjectStore(doc);
  const services = { ...mockServices(doc), store } as unknown as Services;
  const view = renderWithContext(<TrackTabs selectedTrackId={doc.tracks[0]!.id} onSelectTrack={() => {}} />, {
    services,
  });
  const tab = (index: number) => view.container.querySelectorAll<HTMLButtonElement>(".track-tab")[index]!;
  return { services, store, view, tab, order: () => store.getDoc().tracks.map((track) => track.id) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TrackTabs — track actions context menu", () => {
  it("moves a track down / up from the tab menu", async () => {
    const user = userEvent.setup();
    const { tab, order } = tabsHarness();
    const before = order();

    fireEvent.contextMenu(tab(0));
    await user.click(screen.getByRole("menuitem", { name: "Move down" }));
    expect(order()).toEqual([before[1], before[0], ...before.slice(2)]);

    fireEvent.contextMenu(tab(0));
    await user.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(order()).toEqual(before);
  });

  it("disables Move up at the top of the stack and Move down at the bottom", async () => {
    const user = userEvent.setup();
    const { tab, order } = tabsHarness();
    const last = order().length - 1;

    fireEvent.contextMenu(tab(0));
    expect(screen.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
    await user.keyboard("{Escape}");
    fireEvent.contextMenu(tab(last));
    expect(screen.getByRole("menuitem", { name: "Move down" })).toBeDisabled();
  });

  it("duplicates a track with its FX from the tab menu", async () => {
    const user = userEvent.setup();
    const { store, order } = tabsHarness();
    const first = store.getDoc().tracks[0]!;

    fireEvent.contextMenu(tab(0));
    await user.click(screen.getByRole("menuitem", { name: /Duplicate/ }));

    const tracks = store.getDoc().tracks;
    expect(tracks.length).toBe(order().length + 1);
    expect(tracks[1]!.name).toBe(`${first.name} copy`);
    expect(tracks[1]!.effects.map((fx) => fx.type)).toEqual(first.effects.map((fx) => fx.type));
    expect(tracks[1]!.id).not.toBe(first.id);
  });

  it("deletes only after the confirm dialog accepts, and never on cancel", async () => {
    const user = userEvent.setup();
    const { store, tab, order } = tabsHarness();
    const before = order();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.contextMenu(tab(0));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(order()).toEqual(before);

    confirmSpy.mockReturnValue(true);
    fireEvent.contextMenu(tab(0));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(order().some((id) => id === before[0])).toBe(false);
  });

  it("renames from the tab menu", async () => {
    const user = userEvent.setup();
    const { store, tab } = tabsHarness();
    const first = store.getDoc().tracks[0]!;

    fireEvent.contextMenu(tab(0));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = screen.getByLabelText("Track name") as HTMLInputElement;
    expect(input.value).toBe(first.name);
    await user.clear(input);
    await user.type(input, "Renamed from menu");
    fireEvent.blur(input);
    expect(store.getDoc().tracks.find((track) => track.id === first.id)!.name).toBe("Renamed from menu");
  });
});
