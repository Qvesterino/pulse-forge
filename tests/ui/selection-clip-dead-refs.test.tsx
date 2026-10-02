import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { ServicesContext } from "../../src/ui/context";
import { SelectionContext } from "../../src/ui/context";
import { addArrangementClip } from "../../src/commands/commands";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";

/**
 * INVARIANT: every id in the selection names a live object.
 *
 * The selection is UI state; document commands are pure
 * `ProjectDocument → Command`, so neither can see the other and a destructive
 * clip action has to drop the dead ids at its own call site. The track half of
 * this contract already exists (`SelectionStore.pruneTrack` /
 * `retainTracks`, covered by tests/selection-store-dead-refs.test.ts).
 *
 * The clip half did not. `App.tsx`'s keyboard Delete calls
 * `selectionStore.clear()`, but the context menu, the DEL buttons and
 * `deleteClipsWithToast` all clear only the local `selectedClipId` /
 * `selectedAudioClipId` — `selection.clipIds` keeps naming a clip that is gone.
 *
 * A real ProjectStore is used so the document actually changes and the panel
 * re-renders, matching the sibling delete-selected-clip spec.
 */
function renderLiveArrangement(): {
  project: ProjectStore;
  selectionStore: SelectionStore;
  services: Services;
} {
  const doc = createProjectFromTemplate("house");
  const project = new ProjectStore(doc);
  const selectionStore = new SelectionStore();
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  render(
    createElement(
      ServicesContext.Provider,
      { value: services },
      createElement(SelectionContext.Provider, { value: selectionStore }, createElement(ArrangementPanel) as ReactElement),
    ),
  );
  return { project, selectionStore, services };
}

/** Clip ids that the project document still contains. */
function liveClipIds(project: ProjectStore): Set<string> {
  const doc = project.getDoc();
  return new Set([
    ...doc.arrangement.clips.map((c) => c.id),
    ...(doc.arrangement.audioClips ?? []).map((c) => c.id),
  ]);
}

const delButton = (): HTMLButtonElement => {
  const dup = screen.getByRole("button", { name: "DUP" });
  const del = dup.nextElementSibling as HTMLButtonElement | null;
  expect(del?.textContent).toBe("DEL");
  return del as HTMLButtonElement;
};

describe("§13 selection clipIds after the DEL button", () => {
  it("does not keep a clip id in the selection after deleting that clip", async () => {
    const user = userEvent.setup();
    const { project, selectionStore } = renderLiveArrangement();

    const clip = project.getDoc().arrangement.clips[0]!;
    const clipEl = document.querySelector(".arr-clip");
    expect(clipEl).not.toBeNull();
    await user.click(clipEl!);
    expect(delButton()).not.toBeDisabled();

    // Put the id in the SHARED selection, exactly as the timeline's own
    // pointer handlers do (ArrangementPanel beginDrag → setClips([clipId])).
    selectionStore.setClips([clip.id]);
    expect(selectionStore.getState().clipIds).toEqual([clip.id]);

    await user.click(delButton());

    // The clip is really gone from the document…
    expect(liveClipIds(project).has(clip.id)).toBe(false);
    // …so the selection must not still be pointing at it.
    const stale = selectionStore.getState().clipIds.filter((id) => !liveClipIds(project).has(id));
    expect(stale, "selection kept a dead clip id after delete").toEqual([]);
  });

  it("keeps a still-live sibling in a multi-clip selection", async () => {
    const user = userEvent.setup();
    const { project, selectionStore } = renderLiveArrangement();

    // The stock template ships a single clip; add a second at the first free
    // bar so the selection genuinely spans one doomed and one surviving id.
    // Arrangement clips are no-overlap, so the bar is computed, not guessed.
    const base = project.getDoc();
    const sceneId = base.scenes[0].id;
    const firstFreeBar = base.arrangement.clips.reduce(
      (max, c) => Math.max(max, c.startBar + c.lengthBars),
      0,
    );
    project.execute(addArrangementClip(base, sceneId, firstFreeBar));
    const clips = project.getDoc().arrangement.clips;
    expect(clips.length).toBeGreaterThanOrEqual(2);
    const [first, second] = clips;
    selectionStore.setClips([first!.id, second!.id]);

    const clipEl = document.querySelector(".arr-clip");
    await user.click(clipEl!);
    await user.click(delButton());

    // Only the deleted id goes; the untouched sibling stays selected.
    const remaining = selectionStore.getState().clipIds;
    expect(remaining).not.toContain(first!.id);
    expect(remaining.filter((id) => !liveClipIds(project).has(id))).toEqual([]);
  });
});
