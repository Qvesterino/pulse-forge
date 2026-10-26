import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import type { ProjectDocument } from "../src/project-model/types";
import { createProjectFromTemplate } from "../src/project-model/templates";

/**
 * AN UNDO WITH NOTHING TO UNDO MUST SAY SO (audit S-5).
 *
 * The undo history is per-session — like every DAW: Logic, Cubase and
 * Ableton all start a fresh history when a project is opened. So after a
 * reload Ctrl+Z had nothing to undo. It did it SILENTLY: the key press
 * vanished, the app looked broken, and the user could not tell a limitation
 * from a fault.
 *
 * Two things have to hold:
 *
 * 1. THE EMPTY UNDO IS ANNOUNCED. The store owns the truth (it knows the
 *    stack is empty), so the store announces it — seven call sites must not
 *    each invent their own wording.
 * 2. A REAL UNDO STAYS SILENT. An announcement on every undo would be noise,
 *    and the toast's dedupe key (the undo stack's length) only changes when
 *    something actually happened.
 */
function storeWithHistory(): { store: ProjectStore; doc: ProjectDocument } {
  const doc = createProjectFromTemplate("house");
  const store = new ProjectStore(doc);
  return { store, doc };
}

describe("the store announces an undo that had nothing to undo", () => {
  it("an empty history says so — with the reason", () => {
    const { store } = storeWithHistory();

    expect(store.notice).toBeNull();
    store.undo();

    expect(store.notice).not.toBeNull();
    expect(store.notice?.text).toBe("Nothing to undo");
    expect(store.notice?.detail).toMatch(/per-session/);
  });

  it("an empty redo says so too", () => {
    const { store } = storeWithHistory();

    store.redo();

    expect(store.notice?.text).toBe("Nothing to redo");
  });

  it("the notice says WHERE the previous session's work is — the user has to be pointed at it", () => {
    const { store } = storeWithHistory();

    store.undo();

    expect(store.notice?.detail).toMatch(/project screen/);
  });

  it("two empty undos are TWO events — the toast must not swallow the second", () => {
    const { store } = storeWithHistory();

    store.undo();
    const first = store.notice?.id;
    store.undo();
    const second = store.notice?.id;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});

describe("a real undo stays silent", () => {
  it("the notice is not raised when the undo actually did something", () => {
    const { store, doc } = storeWithHistory();
    store.execute({
      type: "test",
      label: "Add Track",
      execute: (d) => ({ ...d, name: "Renamed" }),
      undo: (d) => ({ ...d, name: doc.name }),
    });
    store.undo();

    expect(store.notice, "a working undo must not cry wolf").toBeNull();
  });

  it("the document is back where it was", () => {
    const { store, doc } = storeWithHistory();
    store.execute({
      type: "test",
      label: "Add Track",
      execute: (d) => ({ ...d, name: "Renamed" }),
      undo: (d) => ({ ...d, name: doc.name }),
    });
    store.undo();

    expect(store.getDoc().name).toBe(doc.name);
  });
});
