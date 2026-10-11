import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addArrangementClip } from "../../src/commands/arrangement";
import { addAudioClip } from "../../src/commands/audioClips";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";

/**
 * §35 MEMORY AND CLEANUP — "repeated mount/unmount … listeners … must not
 * leak. Memory should stabilise after equivalent repeated workflows."
 *
 * Reading the effects and seeing a `return () => …` is not evidence that the
 * counts balance; it is evidence that someone wrote a cleanup. This measures
 * the balance: every `addEventListener` the panel makes must be matched by a
 * `removeEventListener`, and every `setInterval` by a `clearInterval`, across
 * repeated mount/unmount cycles — including one that unmounts **mid-gesture**,
 * which is the cycle most likely to strand a live capture.
 */

interface Balance {
  windowAdded: number;
  windowRemoved: number;
  docAdded: number;
  docRemoved: number;
  intervals: number;
  clearedIntervals: number;
}

function instrument(): Balance {
  const balance: Balance = {
    windowAdded: 0,
    windowRemoved: 0,
    docAdded: 0,
    docRemoved: 0,
    intervals: 0,
    clearedIntervals: 0,
  };
  // Bind the originals BEFORE spying. Delegating through
  // `EventTarget.prototype` fails in jsdom ("not a valid instance of
  // EventTarget"), and an unbalanced spy would make every count here fiction.
  const winAdd = window.addEventListener.bind(window);
  const winRemove = window.removeEventListener.bind(window);
  const docAdd = document.addEventListener.bind(document);
  const docRemove = document.removeEventListener.bind(document);
  const rawSetInterval = globalThis.setInterval.bind(globalThis);
  const rawClearInterval = globalThis.clearInterval.bind(globalThis);

  vi.spyOn(window, "addEventListener").mockImplementation((type: string, listener: never, options?: never) => {
    balance.windowAdded++;
    return winAdd(type, listener, options);
  });
  vi.spyOn(window, "removeEventListener").mockImplementation((type: string, listener: never, options?: never) => {
    balance.windowRemoved++;
    return winRemove(type, listener, options);
  });
  vi.spyOn(document, "addEventListener").mockImplementation((type: string, listener: never, options?: never) => {
    balance.docAdded++;
    return docAdd(type, listener, options);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation((type: string, listener: never, options?: never) => {
    balance.docRemoved++;
    return docRemove(type, listener, options);
  });
  vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: never, timeout?: never, ...args: never[]) => {
    balance.intervals++;
    return rawSetInterval(handler, timeout, ...args);
  }) as never);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(((id: never) => {
    balance.clearedIntervals++;
    return rawClearInterval(id);
  }) as never);
  return balance;
}

const withClip = () => {
  let doc = createProjectFromTemplate("house");
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] } };
  doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 8).execute(doc);
  const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
  doc = addAudioClip(doc, trackId, "leak-buf", 0, 2, {}).execute(doc);
  return doc;
};

function mountOnce() {
  const doc = withClip();
  const store = new ProjectStore(doc);
  const services = { ...mockServices(doc), store } as unknown as Services;
  const selectionStore = new SelectionStore();
  selectionStore.setClips([doc.arrangement.clips[0]!.id]);
  render(
    createElement(
      ServicesContext.Provider,
      { value: services },
      createElement(
        SelectionContext.Provider,
        { value: selectionStore },
        createElement(ArrangementPanel) as ReactElement,
      ),
    ),
  );
  return store;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("§35 mount/unmount balance", () => {
  it("CONTROL: a single cycle adds and removes the same number of window listeners", () => {
    const balance = instrument();
    mountOnce();
    expect(balance.windowAdded, "the panel must register window listeners").toBeGreaterThan(0);
    cleanup();
    expect(balance.windowRemoved, "every window listener must be released").toBe(balance.windowAdded);
  });

  it("five mount/unmount cycles do not accumulate listeners", () => {
    const perCycle: { added: number; removed: number }[] = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      const balance = instrument();
      mountOnce();
      cleanup();
      perCycle.push({ added: balance.windowAdded, removed: balance.windowRemoved });
    }
    for (const cycle of perCycle) {
      expect(cycle.removed, "cycle must balance its own registrations").toBe(cycle.added);
    }
    const counts = perCycle.map((c) => c.added);
    expect(new Set(counts).size, `listener registration varied across cycles: ${counts.join(",")}`).toBe(1);
  });

  it("five mount/unmount cycles do not accumulate document listeners or intervals", () => {
    const perCycle: Balance[] = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      const balance = instrument();
      mountOnce();
      cleanup();
      perCycle.push(balance);
    }
    for (const cycle of perCycle) {
      expect(cycle.docRemoved).toBe(cycle.docAdded);
      expect(cycle.clearedIntervals, "every interval must be cleared").toBe(cycle.intervals);
    }
  });

  it("unmounting MID-GESTURE releases the capture listeners the gesture armed", () => {
    // The capture is armed and the element holds the pointer when the panel
    // disappears; the terminator has to fire on unmount or the panel strands a
    // window listener that routes orphaned pointerups into a dead component.
    const clean = instrument();
    mountOnce();
    cleanup();
    const cleanCount = clean.windowAdded;

    vi.restoreAllMocks();
    const mid = instrument();
    mountOnce();
    const clip = document.querySelector(".arr-clip");
    if (clip) {
      fireEvent.pointerDown(clip, { button: 0, clientX: 40, pointerId: 1 });
      act(() => {
        fireEvent.pointerMove(clip, { clientX: 90, pointerId: 1 });
      });
    }
    cleanup();
    // Arming a live capture registers EXTRA listeners (the guard's
    // pointermove/pointerup routing), so the counts are not expected to match
    // a clean mount — but every one of them has to come back.
    expect(mid.windowAdded, "a live capture should arm its own routing").toBeGreaterThan(cleanCount);
    expect(mid.windowRemoved, "a mid-gesture unmount must release everything it armed").toBe(mid.windowAdded);
  });
});
