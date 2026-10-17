import { afterEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { FreezeButton } from "../../src/ui/FreezeButton";
import { mockServices, renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { Track } from "../../src/project-model/types";
import { clearFreezeSignatures, freezeSignature, rememberFreezeSignature } from "../../src/rendering/freezeSignature";

describe("FreezeButton", () => {
  function firstTrack(): Track {
    const doc = createProjectFromTemplate("house");
    const t = doc.tracks[0];
    if (!t) throw new Error("expected a track");
    return t;
  }

  function frozenTrack(): Track {
    const track = firstTrack();
    return { ...track, frozen: { bufferId: "frozen-1", durationSec: 4, sampleRate: 44100 } };
  }

  afterEach(() => {
    clearFreezeSignatures();
  });

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

  it("flags a frozen buffer that no longer matches the project, offering RE-FREEZE", async () => {
    // Wave 2/D: the old strip played the stale render in silence while the
    // export re-rendered the edited track — the mismatch was invisible.
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    rememberFreezeSignature("frozen-1", "0".repeat(64)); // cannot match any real signature
    renderWithContext(<FreezeButton track={frozenTrack()} />, { services });

    expect(await screen.findByText("EDITED SINCE FREEZE")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /RE-FREEZE/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /UNFREEZE/i })).toBeInTheDocument();
  });

  it("stays quiet when the frozen buffer matches the current project", async () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    rememberFreezeSignature("frozen-1", (await freezeSignature(services.store.getDoc()))!);
    renderWithContext(<FreezeButton track={frozenTrack()} />, { services });

    expect(await screen.findByRole("button", { name: "REFRESH" })).toBeInTheDocument();
    expect(screen.queryByText("EDITED SINCE FREEZE")).toBeNull();
  });

  it("stays quiet when no signature is known (never a guess)", async () => {
    const services = mockServices(createProjectFromTemplate("house"));
    renderWithContext(<FreezeButton track={frozenTrack()} />, { services });

    expect(await screen.findByRole("button", { name: "REFRESH" })).toBeInTheDocument();
    expect(screen.queryByText("EDITED SINCE FREEZE")).toBeNull();
  });
});
