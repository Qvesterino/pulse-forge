import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrackTabs, trackBadge } from "../../src/ui/TrackTabs";
import { renderWithContext } from "../helpers";
import type { Track } from "../../src/project-model/types";

describe("TrackTabs", () => {
  it("renders all track tabs", () => {
    renderWithContext(<TrackTabs selectedTrackId="t1" onSelectTrack={vi.fn()} />);
    expect(screen.getAllByRole("tab").length).toBeGreaterThan(0);
  });

  it("marks selected track as active", () => {
    const { services, container } = renderWithContext(<TrackTabs selectedTrackId="" onSelectTrack={vi.fn()} />);
    const doc = services.store.getDoc();
    // The selectedTrackId prop needs to match a real track id
    const tab = container.querySelector(`.track-tab`);
    // No track selected initially — no tab has .active
    expect(tab).not.toHaveClass("active");
    // Now select the first track
    const { container: c2 } = renderWithContext(
      <TrackTabs selectedTrackId={doc.tracks[0].id} onSelectTrack={vi.fn()} />,
      { services },
    );
    const active = c2.querySelector(".track-tab.active");
    expect(active).toBeTruthy();
  });

  it("calls onSelectTrack on click", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { services } = renderWithContext(<TrackTabs selectedTrackId="t1" onSelectTrack={onSelect} />);
    const doc = services.store.getDoc();
    await user.click(screen.getByText(doc.tracks[0].name));
    expect(onSelect).toHaveBeenCalledWith(doc.tracks[0].id);
  });

  it("shows + TRACK dropdown", () => {
    renderWithContext(<TrackTabs selectedTrackId="t1" onSelectTrack={vi.fn()} />);
    expect(screen.getByLabelText("Add track")).toBeInTheDocument();
  });

  it("executes createDrumTrack when adding drum", async () => {
    const user = userEvent.setup();
    const { services } = renderWithContext(<TrackTabs selectedTrackId="t1" onSelectTrack={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText("Add track"), "drum");
    expect(services.store.execute).toHaveBeenCalled();
  });

  it("trackBadge returns correct badge", () => {
    expect(trackBadge({ kind: "drum" } as Track)).toBe("DR");
    expect(trackBadge({ kind: "instrument", instrument: "sampler" } as Track)).toBe("SMP");
    expect(trackBadge({ kind: "instrument", instrument: "analog" } as Track)).toBe("AN");
    expect(trackBadge({ kind: "instrument", instrument: "bass" } as Track)).toBe("BSS");
    expect(trackBadge({ kind: "instrument", instrument: "808" } as Track)).toBe("808");
    expect(trackBadge({ kind: "instrument", instrument: "texture" } as Track)).toBe("TEX");
  });
});
