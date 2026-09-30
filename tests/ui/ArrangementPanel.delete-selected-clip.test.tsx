import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices } from "../helpers";
import { renderWithContext } from "../helpers";
import type { Services } from "../../src/services";

/**
 * §13 "deletion of the currently controlled object" — for arrangement clips.
 *
 * The arrangement has two delete paths and they disagreed:
 *  - the context-menu / ripple path clears the selection after deleting
 *    (ArrangementPanel.tsx:1898: `if (selectedClipId && ids.includes(...)) setSelectedClipId(null)`);
 *  - the DEL button executed `deleteArrangementClip` and left `selectedClipId`
 *    pointing at the clip it had just removed.
 *
 * The visible consequence is the DEL button's own disabled contract
 * (`disabled={!selectedClipId}`): a dead id left it enabled over a clip that
 * no longer exists, so every further press re-issued the delete for the same
 * removed id and the button could never return to its resting state.
 *
 * A real ProjectStore is used so the document actually changes and the panel
 * re-renders — the panel-level specs in `ArrangementPanel.test.tsx` render over
 * a mock store, where the DOM never updates after a command.
 */
function renderLiveArrangement() {
  const doc = createProjectFromTemplate("house");
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  const utils = renderWithContext(<ArrangementPanel />, { services });
  return { ...utils, project, doc };
}

/**
 * The clip DEL button, anchored on its sibling DUP — the panel has more than
 * one control named "DEL", and DUP is unique to the clip toolbar.
 */
const delButton = (): HTMLButtonElement => {
  const dup = screen.getByRole("button", { name: "DUP" });
  const del = dup.nextElementSibling as HTMLButtonElement | null;
  expect(del?.textContent).toBe("DEL");
  return del as HTMLButtonElement;
};

describe("§13 arrangement DEL button", () => {
  it("is disabled with nothing selected", () => {
    renderLiveArrangement();
    expect(delButton()).toBeDisabled();
  });

  it("stops targeting the clip it just deleted", async () => {
    const user = userEvent.setup();
    const { project, doc } = renderLiveArrangement();

    const clip = doc.arrangement.clips[0]!;
    // Select the clip the way the timeline does — `.arr-clip`'s onClick sets
    // `selectedClipId`.
    const clipEl = document.querySelector(".arr-clip");
    expect(clipEl).not.toBeNull();
    await user.click(clipEl!);
    expect(delButton()).not.toBeDisabled();

    await user.click(delButton());

    // The clip is really gone…
    expect(project.getDoc().arrangement.clips.some((c) => c.id === clip.id)).toBe(false);
    // …and the button is back at rest instead of still aiming at a dead id.
    expect(delButton()).toBeDisabled();
  });
});
