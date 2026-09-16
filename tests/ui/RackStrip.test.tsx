import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RackStrip } from "../../src/ui/RackStrip";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { DrumTrack } from "../../src/project-model/types";

describe("RackStrip", () => {
  function drumTrack() {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "drum") as DrumTrack;
    return { doc, track };
  }

  it("renders pad buttons for each pad", () => {
    const { doc, track } = drumTrack();
    const { container } = renderWithContext(
      <RackStrip track={track} selectedPadId={track.pads[0].id} onSelectPad={vi.fn()} />,
      { services: mockServices(doc) },
    );
    // Scope to pads — the header has its own buttons (16 LVL toggle).
    expect(container.querySelectorAll(".pad").length).toBe(track.pads.length);
  });

  it("shows pad names", () => {
    const { doc, track } = drumTrack();
    renderWithContext(<RackStrip track={track} selectedPadId="" onSelectPad={vi.fn()} />, {
      services: mockServices(doc),
    });
    expect(screen.getByText(track.pads[0].name)).toBeInTheDocument();
  });

  it("calls onSelectPad on click", async () => {
    const user = userEvent.setup();
    const { doc, track } = drumTrack();
    const onSelect = vi.fn();
    renderWithContext(<RackStrip track={track} selectedPadId="" onSelectPad={onSelect} />, {
      services: mockServices(doc),
    });
    await user.click(screen.getByText(track.pads[0].name));
    expect(onSelect).toHaveBeenCalledWith(track.pads[0].id);
  });

  it("shows pad index numbers", () => {
    const { doc, track } = drumTrack();
    renderWithContext(<RackStrip track={track} selectedPadId="" onSelectPad={vi.fn()} />, {
      services: mockServices(doc),
    });
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("marks selected pad", () => {
    const { doc, track } = drumTrack();
    const { container } = renderWithContext(
      <RackStrip track={track} selectedPadId={track.pads[0].id} onSelectPad={vi.fn()} />,
      { services: mockServices(doc) },
    );
    const pads = container.querySelectorAll(".pad");
    expect(pads[0]).toHaveClass("selected");
  });

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
