import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { FreezeButton } from "../../src/ui/FreezeButton";
import { renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { Track } from "../../src/project-model/types";

describe("FreezeButton", () => {
  function firstTrack(): Track {
    const doc = createProjectFromTemplate("house");
    const t = doc.tracks[0];
    if (!t) throw new Error("expected a track");
    return t;
  }

  it("renders FREEZE and BOUNCE buttons for a non-frozen instrument track", () => {
    const track = firstTrack();
    renderWithContext(<FreezeButton track={track} />);
    expect(screen.getByRole("button", { name: /FREEZE/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /BOUNCE/i })).toBeInTheDocument();
  });

  it("does not render a FREEZE button for a group track", () => {
    const groupTrack: Track = {
      id: "g1",
      kind: "group",
      name: "Group",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
      sends: {},
    };
    renderWithContext(<FreezeButton track={groupTrack} />);
    expect(screen.queryByRole("button", { name: /FREEZE/i })).toBeNull();
  });

  it("does not throw when rendered for an instrument track", () => {
    const track = firstTrack();
    expect(() => renderWithContext(<FreezeButton track={track} />)).not.toThrow();
  });
});
