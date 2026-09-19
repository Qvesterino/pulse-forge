import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { Inspector } from "../../src/ui/Inspector";
import { renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { Track } from "../../src/project-model/types";

describe("Inspector", () => {
  function firstTrack(): Track {
    const doc = createProjectFromTemplate("house");
    const t = doc.tracks[0];
    if (!t) throw new Error("expected a track");
    return t;
  }

  it("renders the TRACK header and Volume slider", () => {
    const track = firstTrack();
    const padId = track.kind === "drum" ? (track.pads[0]?.id ?? "") : "";
    renderWithContext(<Inspector track={track} selectedPadId={padId} />);
    expect(screen.getByText(new RegExp(`TRACK — ${track.name}`))).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /Volume/i })).toBeInTheDocument();
  });

  it("renders the Plugin button when onOpenPlugin is provided", () => {
    const track = firstTrack();
    const padId = track.kind === "drum" ? (track.pads[0]?.id ?? "") : "";
    renderWithContext(<Inspector track={track} selectedPadId={padId} onOpenPlugin={vi.fn()} />);
    const pluginButtons = screen.getAllByTitle(/Open the (drum )?device chain/i);
    expect(pluginButtons.length).toBeGreaterThan(0);
  });

  it("clicking the Plugin button calls onOpenPlugin", () => {
    const track = firstTrack();
    const padId = track.kind === "drum" ? (track.pads[0]?.id ?? "") : "";
    const onOpen = vi.fn();
    renderWithContext(<Inspector track={track} selectedPadId={padId} onOpenPlugin={onOpen} />);
    const pluginButton = screen.getAllByTitle(/Open the (drum )?device chain/i)[0];
    fireEvent.click(pluginButton);
    expect(onOpen).toHaveBeenCalled();
  });
});
