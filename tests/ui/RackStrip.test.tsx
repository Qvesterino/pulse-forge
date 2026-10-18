import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RackStrip } from "../../src/ui/RackStrip";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { DrumTrack } from "../../src/project-model/types";

// The pad GRID is gone: the sequencer row is the one channel list (see
// 57-row-pitch.css and STUDIO-OPTIMIZATION-PLAN.md §2.1). These five tests used
// to assert pad count, pad name, index numbers, click-to-select and the
// selected class against `.pad` elements in this component.
//
// They were NOT deleted outright. Every behaviour they named still exists —
// it moved to the row label — and no other test covered it, so removing them
// would have left pad naming, indexing and selection unguarded. The equivalent
// assertions now live in tests/ui/Sequencer.test.tsx against `.sequencer-row`,
// which is where the affordances actually render now.
//
// What genuinely stayed HERE is everything with no duplicate: the track tabs,
// Note Repeat, 16 LEVELS, KIT and KEYS all live in the rack header, and the
// QWERTY pad trigger is a window-level listener built from track.pads +
// padKeys — independent of any rendered element.
describe("RackStrip", () => {
  function drumTrack() {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "drum") as DrumTrack;
    return { doc, track };
  }

  it("keeps keymap sharing inside the KEYS menu, not as always-visible chrome", async () => {
    const user = userEvent.setup();
    const { doc, track } = drumTrack();
    renderWithContext(<RackStrip track={track} selectedPadId="" onSelectPad={vi.fn()} />, {
      services: mockServices(doc),
    });
    expect(screen.queryByRole("menuitem", { name: "Copy BINDS code" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "KEYS" }));
    expect(screen.getByRole("menuitem", { name: "Copy BINDS code" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Install from code…" })).toBeInTheDocument();
  });

  it("code install opens the in-app dialog, not a native prompt", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    const { doc, track } = drumTrack();
    renderWithContext(<RackStrip track={track} selectedPadId="" onSelectPad={vi.fn()} />, {
      services: mockServices(doc),
    });

    await user.click(screen.getByRole("button", { name: "KEYS" }));
    await user.click(screen.getByRole("menuitem", { name: "Install from code…" }));

    // The dialog is reachable from the test; the native prompt is not used.
    expect(screen.getByRole("dialog", { name: "INSTALL BINDS" })).toBeInTheDocument();
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("saving a kit opens the naming dialog instead of a native prompt", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    const { doc, track } = drumTrack();
    renderWithContext(<RackStrip track={track} selectedPadId="" onSelectPad={vi.fn()} />, {
      services: mockServices(doc),
    });

    await user.click(screen.getByRole("button", { name: "KIT" }));
    await user.click(screen.getByRole("menuitem", { name: /Save current/ }));

    const dialog = screen.getByRole("dialog", { name: "SAVE KIT" });
    expect(dialog).toBeInTheDocument();
    expect((screen.getByLabelText("Kit name") as HTMLInputElement).value).toMatch(/^Kit /);
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("renders the leading slot (track tabs) inside its header row", () => {
    const { doc, track } = drumTrack();
    const { container } = renderWithContext(
      <RackStrip
        track={track}
        selectedPadId=""
        onSelectPad={vi.fn()}
        leading={<div data-testid="leading-tabs">tabs</div>}
      />,
      { services: mockServices(doc) },
    );
    const header = container.querySelector(".rack-header");
    expect(header).not.toBeNull();
    expect(header!.contains(screen.getByTestId("leading-tabs"))).toBe(true);
  });
});
