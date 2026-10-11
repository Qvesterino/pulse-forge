import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addArrangementClip } from "../../src/commands/arrangement";
import { addAudioClip } from "../../src/commands/audioClips";
import { setClipsLocked } from "../../src/commands/clipGroups";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * §29 LOCKING — the block (multi-select) drag.
 *
 * `assertClipEditable` is the command-level choke point for the lock, and the
 * panel's SINGLE-clip drag routes through it (the factory throws, the commit
 * is refused). The BLOCK drag does not: it builds the next document by hand
 * (`nextDoc` from a mapped spread) so a locked clip in the selection moves
 * anyway — the one gesture where the guard is bypassed rather than obeyed.
 *
 * The policy pinned here is REFUSE THE GESTURE, not "skip the locked clip":
 * a block move's whole meaning is that its members keep their relative
 * spacing, and a partial move silently produces a layout the user did not ask
 * for. (The keyboard nudge skips instead — that is not a contradiction: a
 * nudge moves each clip independently, so dropping one loses no spacing.)
 */

const domRect = (left: number, width: number) =>
  ({ left, top: 0, width, height: 40, right: left + width, bottom: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

/** Two packed scene clips (the house template's, plus one after it). */
function twoClips(lockSecond: boolean): { doc: ProjectDocument; ids: string[] } {
  let doc = createProjectFromTemplate("house");
  const sceneId = doc.scenes[0]!.id;
  const bar = doc.arrangement.clips.reduce((m, c) => Math.max(m, c.startBar + c.lengthBars), 0);
  doc = addArrangementClip(doc, sceneId, bar, 4).execute(doc);
  let ids = doc.arrangement.clips.map((c) => c.id);
  if (lockSecond) {
    doc = setClipsLocked(doc, [ids[1]!], true).execute(doc);
  }
  ids = doc.arrangement.clips.map((c) => c.id);
  return { doc, ids };
}

function mount(doc: ProjectDocument, selectIds: string[]) {
  const store = new ProjectStore(doc);
  const services = { ...mockServices(doc), store } as unknown as Services;
  const selectionStore = new SelectionStore();
  selectionStore.setClips(selectIds);
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
  const lane = document.querySelector(".arr-lane")!;
  const clips = [...document.querySelectorAll<HTMLElement>(".arr-clip")];
  vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 4_000_000));
  for (const el of clips) vi.spyOn(el, "getBoundingClientRect").mockReturnValue(domRect(0, 100));
  return { store, lane, clips };
}

function dragBlock(clips: HTMLElement[], from: number) {
  fireEvent.pointerDown(clips[from]!, { button: 0, clientX: 40, pointerId: 1 });
  act(() => {
    fireEvent.pointerMove(clips[from]!, { clientX: 240, pointerId: 1 });
  });
  fireEvent.pointerUp(clips[from]!, { pointerId: 1 });
}

const starts = (store: ProjectStore) => Object.fromEntries(store.doc.arrangement.clips.map((c) => [c.id, c.startBar]));

const errorText = () => document.querySelector(".arr-error")?.textContent ?? "";

/** Two packed audio clips on one track. */
function twoAudioClips(lockSecond: boolean): { doc: ProjectDocument; ids: string[] } {
  let doc = createProjectFromTemplate("house");
  const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
  doc = addAudioClip(doc, trackId, "lock-buf", 0, 2, {}).execute(doc);
  doc = addAudioClip(doc, trackId, "lock-buf", 4, 2, {}).execute(doc);
  if (lockSecond) doc = setClipsLocked(doc, [doc.arrangement.audioClips![1]!.id], true).execute(doc);
  return { doc, ids: doc.arrangement.audioClips!.map((c) => c.id) };
}

const audioStarts = (store: ProjectStore) =>
  Object.fromEntries((store.doc.arrangement.audioClips ?? []).map((c) => [c.id, c.startBar]));

afterEach(() => cleanup());

describe("§29 clip lock — block drag", () => {
  it("CONTROL: an unlocked block drag moves every selected clip", () => {
    const { doc, ids } = twoClips(false);
    const before = doc.arrangement.clips.map((c) => c.startBar);
    const { store, clips } = mount(doc, ids);
    expect(clips.length, "expected two rendered scene clips").toBe(2);
    dragBlock(clips, 0);
    const after = ids.map((id) => store.doc.arrangement.clips.find((c) => c.id === id)!.startBar);
    expect(after, "the block must move together").toEqual(before.map((b) => b + 7));
    expect(store.doc.arrangement.clips.map((c) => c.id).sort()).toEqual([...ids].sort());
  });

  it("a block drag refuses to move a LOCKED member of the selection", () => {
    const { doc, ids } = twoClips(true);
    const before = starts(new ProjectStore(doc));
    const { store, clips } = mount(doc, ids);
    expect(clips.length).toBe(2);
    dragBlock(clips, 0);
    expect(starts(store), "no selected clip may move while one of them is locked").toEqual(before);
    expect(errorText(), "the refusal must be visible, not silent").toMatch(/lock/i);
  });

  it("the refusal costs no undo entry", () => {
    const { doc, ids } = twoClips(true);
    const { store, clips } = mount(doc, ids);
    const canUndoBefore = store.canUndo;
    dragBlock(clips, 0);
    expect(store.canUndo, "a refused gesture must not be undoable").toBe(canUndoBefore);
  });

  it("unlocking the member makes the same gesture work again", () => {
    const { doc, ids } = twoClips(true);
    const before = doc.arrangement.clips.map((c) => c.startBar);
    const unlocked = setClipsLocked(doc, [ids[1]!], false).execute(doc);
    const { store, clips } = mount(unlocked, ids);
    expect(clips.length).toBe(2);
    dragBlock(clips, 0);
    const after = store.doc.arrangement.clips.map((c) => c.startBar);
    expect(after, "with nothing locked the same gesture must move the block").toEqual(before.map((b) => b + 7));
  });
});

describe("§29 clip lock — audio block drag", () => {
  function mountAudio(doc: ProjectDocument, selectIds: string[]) {
    const store = new ProjectStore(doc);
    const services = { ...mockServices(doc), store } as unknown as Services;
    const selectionStore = new SelectionStore();
    selectionStore.setClips(selectIds);
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
    const lane = document.querySelector(".arr-lane")!;
    const clips = [...document.querySelectorAll<HTMLElement>(".arr-audio-clip")];
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 4_000_000));
    for (const el of clips) vi.spyOn(el, "getBoundingClientRect").mockReturnValue(domRect(0, 100));
    return { store, clips };
  }

  it("CONTROL: an unlocked audio block drag moves both clips", () => {
    const { doc, ids } = twoAudioClips(false);
    const before = (doc.arrangement.audioClips ?? []).map((c) => c.startBar);
    const { store, clips } = mountAudio(doc, ids);
    expect(clips.length, "expected two rendered audio clips").toBe(2);
    dragBlock(clips, 0);
    const after = (store.doc.arrangement.audioClips ?? []).map((c) => c.startBar);
    expect(after[0]!).toBeGreaterThan(before[0]!);
    expect(after[1]!).toBeGreaterThan(before[1]!);
  });

  it("an audio block drag refuses to move a LOCKED member", () => {
    const { doc, ids } = twoAudioClips(true);
    const before = audioStarts(new ProjectStore(doc));
    const { store, clips } = mountAudio(doc, ids);
    expect(clips.length).toBe(2);
    dragBlock(clips, 0);
    expect(audioStarts(store)).toEqual(before);
    expect(errorText()).toMatch(/lock/i);
  });
});
