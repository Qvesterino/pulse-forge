import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
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
  renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, {
    services,
  });
  const order = () => store.getDoc().tracks.map((track) => track.id);
  const undoDepth = () => store.undoStackLength;
  return { store, order, undoDepth };
}

describe("track reorder keyboard shortcuts", () => {
  it("Alt+Shift+ArrowDown moves the selected track down", () => {
    const { order } = appHarness();
    const before = order();
    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true, shiftKey: true });
    expect(order()).toEqual([before[1], before[0], ...before.slice(2)]);
  });

  it("Alt+Shift+ArrowUp moves it back up", () => {
    const { order } = appHarness();
    const before = order();
    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true, shiftKey: true });
    expect(order()).toEqual(before);
  });

  it("is a no-op at the top edge — no command, no undo entry", () => {
    const { order, undoDepth } = appHarness();
    const before = order();
    const depthBefore = undoDepth();
    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true, shiftKey: true });
    expect(order()).toEqual(before);
    expect(undoDepth()).toBe(depthBefore);
  });

  it("Ctrl+Shift+D duplicates the selected track with its FX", () => {
    const { store, order } = appHarness();
    const before = order();
    const first = store.getDoc().tracks[0]!;
    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "D", ctrlKey: true, shiftKey: true });
    const tracks = store.getDoc().tracks;
    expect(tracks.length).toBe(before.length + 1);
    expect(tracks[1]!.name).toBe(`${first.name} copy`);
    expect(tracks[1]!.effects.map((fx) => fx.type)).toEqual(first.effects.map((fx) => fx.type));
  });
});

describe("command palette exposure", () => {
  it("lists the track actions with keywords", () => {
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
