import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Mixer } from "../../src/ui/Mixer";
import { ServicesContext, SelectionContext } from "../../src/ui/context";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";

/**
 * §13 "deletion of the currently controlled object" — the mixer's own delete
 * button removes the very track the mixer strip is rendering. Nothing else in
 * the suite covers track deletion at all.
 *
 * The invariant under test is "every id in the selection names a live object".
 * It matters because `ArrangementPanel.bounceZoneToClick` (ArrangementPanel.tsx:2107)
 * forwards `selection.trackIds` into `buildBounceZoneDoc` WITHOUT filtering
 * against the live tracks, and `buildBounceZoneDoc` resolves the ids through
 * `buildStemProject(doc, t => trackIds.includes(t.id))` — a dead id matches
 * nothing, so nothing throws and the zone bounces silence while the UI reports
 * success. (The keyboard shortcut at App.tsx:1186 *does* filter; the button
 * and the shortcut disagree, which is why the button is the one that breaks.)
 */
function renderMixerWithRealStores(doc: ReturnType<typeof createProjectFromTemplate>, selectedTrackIds: string[]) {
  const project = new ProjectStore(doc);
  const selection = new SelectionStore();
  selection.setTracks(selectedTrackIds);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  const utils = render(
    createElement(
      ServicesContext.Provider,
      { value: services },
      createElement(SelectionContext.Provider, { value: selection }, createElement(Mixer, null)),
    ),
  );
  return { ...utils, project, selection };
}

/** Clicks the `×` delete button on the strip rendering `trackName`. */
async function clickDelete(user: ReturnType<typeof userEvent.setup>, trackName: string) {
  const strip = screen.getByText(trackName).closest(".channel-strip")!;
  const deleteButton = strip.querySelector<HTMLButtonElement>(".btn-danger")!;
  expect(deleteButton).not.toBeNull();
  await user.click(deleteButton);
}

describe("Mixer: deleting a track leaves no dead reference in the selection", () => {
  it("drops the deleted track from the selection", async () => {
    const doc = createProjectFromTemplate("house");
    const victim = doc.tracks[1]!;
    const user = userEvent.setup();
    const { project, selection } = renderMixerWithRealStores(doc, [victim.id]);

    expect(selection.getState().trackIds).toEqual([victim.id]);
    await clickDelete(user, victim.name);

    expect(project.getDoc().tracks.some((t) => t.id === victim.id)).toBe(false);
    expect(selection.getState().trackIds).toEqual([]);
  });

  it("keeps the other selected tracks when one of several is deleted", async () => {
    const doc = createProjectFromTemplate("house");
    const [a, b, c] = doc.tracks;
    const user = userEvent.setup();
    const { project, selection } = renderMixerWithRealStores(doc, [a!.id, b!.id, c!.id]);

    await clickDelete(user, b!.name);

    // Pruning must remove ONLY the deleted id — clearing the whole selection
    // would throw away the user's other two picks.
    expect(project.getDoc().tracks.some((t) => t.id === b!.id)).toBe(false);
    expect(selection.getState().trackIds).toEqual([a!.id, c!.id]);
  });

  it("drops the deleted track's note selection so no phantom pattern key can be written", async () => {
    const doc = createProjectFromTemplate("house");
    const victim = doc.tracks.find((t) => t.kind !== "drum" && (doc.patterns[0]?.notes?.[t.id] ?? []).length > 0)!;
    const user = userEvent.setup();
    const { project, selection } = renderMixerWithRealStores(doc, [victim.id]);

    const activeId = project.getDoc().activePatternId;
    const note = project.getDoc().patterns.find((p) => p.id === activeId)!.notes![victim.id][0]!;
    selection.setNotes({ trackId: victim.id, noteIds: [note.id] }, "replace");
    expect(selection.getState().noteSelections).toHaveLength(1);

    await clickDelete(user, victim.name);

    // A surviving entry keeps ContextMenu's `hasNotes` true, so its delete
    // action would run `deleteNotes(doc, <deleted id>, …)`. `activeTrackNotes`
    // returns `[]` for an unknown track so nothing throws, but
    // `withTrackNotes` still writes `notes[<deleted id>] = []` back into the
    // pattern — a phantom key in every save.
    expect(selection.getState().noteSelections).toEqual([]);

    const after = project.getDoc().patterns.find((p) => p.id === activeId)!;
    expect(after.notes?.[victim.id]).toBeUndefined();
  });

  it("a zone bounce after the delete resolves to real audio, not an empty stem", async () => {
    const doc = createProjectFromTemplate("house");
    const victim = doc.tracks[1]!;
    const user = userEvent.setup();
    const { project, selection } = renderMixerWithRealStores(doc, [victim.id]);

    await clickDelete(user, victim.name);

    // Replay the exact target resolution `bounceZoneToClick` performs
    // (ArrangementPanel.tsx:2106-2107): bounceable excludes groups, and an
    // empty selection falls back to the first bounceable track. With the dead
    // id still present the guard is `length > 0` and the fallback never runs,
    // so the ids resolve to zero live tracks and the bounce renders silence.
    const after = project.getDoc();
    const bounceable = after.tracks.filter((t) => t.kind !== "group");
    const selected = selection.getState().trackIds;
    const resolved = selected.length > 0 ? selected : bounceable.slice(0, 1).map((t) => t.id);

    expect(resolved.length).toBeGreaterThan(0);
    for (const id of resolved) expect(after.tracks.some((t) => t.id === id)).toBe(true);
  });
});
