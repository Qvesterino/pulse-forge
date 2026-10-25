import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { App } from "../../src/ui/App";
import { buildPaletteActions, filterActions } from "../../src/ui/commandPalette";
import { mockServices, renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ProjectStore } from "../../src/store/ProjectStore";
import type { Services } from "../../src/services";

function appHarness() {
  const doc = createProjectFromTemplate("house");
  const store = new ProjectStore(doc);
  const services = { ...mockServices(doc), store } as unknown as Services;
  const view = renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, {
    services,
  });
  const tab = (index: number) => view.container.querySelectorAll<HTMLButtonElement>(".track-tab")[index]!;
  const order = () => store.getDoc().tracks.map((track) => track.id);
  const undoDepth = () => store.undoStackLength;
  return { tab, order, undoDepth };
}

describe("track reorder keyboard shortcuts", () => {
  it("Alt+Shift+ArrowDown moves the selected track down", () => {
    const { tab, order } = appHarness();
    const before = order();
    fireEvent.click(tab(1));
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true, shiftKey: true });
    expect(order()).toEqual([before[0], before[2], before[1], ...before.slice(3)]);
  });

  it("Alt+Shift+ArrowUp moves it back up", () => {
    const { tab, order } = appHarness();
    const before = order();
    fireEvent.click(tab(1));
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true, shiftKey: true });
    expect(order()).toEqual(before);
  });

  it("is a no-op at the top edge — no command, no undo entry", () => {
    const { tab, order, undoDepth } = appHarness();
    const before = order();
    const depthBefore = undoDepth();
    fireEvent.click(tab(0));
    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true, shiftKey: true });
    expect(order()).toEqual(before);
    expect(undoDepth()).toBe(depthBefore);
  });

  it("is a no-op at the bottom edge", () => {
    const { tab, order, undoDepth } = appHarness();
    const before = order();
    const depthBefore = undoDepth();
    fireEvent.click(tab(before.length - 1));
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true, shiftKey: true });
    expect(order()).toEqual(before);
    expect(undoDepth()).toBe(depthBefore);
  });

  it("Ctrl+Shift+D duplicates the selected track with its FX", () => {
    const { tab, order } = appHarness();
    const before = order();
    const firstName = order()[0]!;
    fireEvent.click(tab(0));
    fireEvent.keyDown(window, { key: "D", ctrlKey: true, shiftKey: true });
    const tracks = order();
    expect(tracks.length).toBe(before.length + 1);
    // The duplicate lands right after its source.
    expect(tracks[1]).not.toBe(firstName);
    expect(tracks.slice(2)).toEqual(before.slice(1));
  });
});

describe("command palette exposure", () => {
  it("lists the track actions so they are searchable", () => {
    const deps = {
      runShortcut: () => {},
      snapshotNow: () => {},
      openGallery: () => {},
      toggleHistoryPanel: () => {},
      toggleDiagnostics: () => {},
    };
    const actions = buildPaletteActions(deps);
    for (const needle of ["move selected track up", "move selected track down", "duplicate selected track"]) {
      expect(filterActions(actions, needle).length).toBeGreaterThan(0);
    }
  });
});
