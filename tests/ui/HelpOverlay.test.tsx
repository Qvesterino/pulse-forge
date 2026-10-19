import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render as rtlRender, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HelpOverlay } from "../../src/ui/HelpOverlay";
import { resetShortcutBindings } from "../../src/ui/shortcuts";

describe("HelpOverlay", () => {
  it("renders nothing when closed", () => {
    const { container } = rtlRender(<HelpOverlay open={false} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders dialog when open", () => {
    rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("has the combined help title", () => {
    rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);
    expect(screen.getByText("HELP — SHORTCUTS & GESTURES")).toBeInTheDocument();
  });

  it("calls onClose when CLOSE button clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    rtlRender(<HelpOverlay open={true} onClose={onClose} />);
    await user.click(screen.getByLabelText("Close help"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on Escape key", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    rtlRender(<HelpOverlay open={true} onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when clicking scrim", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    rtlRender(<HelpOverlay open={true} onClose={onClose} />);
    await user.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows keyboard shortcut groups", () => {
    rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);
    expect(screen.getByText("TRANSPORT")).toBeInTheDocument();
  });

  it("does not hide registered clip actions from the Help overlay", () => {
    rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);
    expect(screen.getByText("CLIPS")).toBeInTheDocument();
    expect(screen.getByText("Copy clips")).toBeInTheDocument();
    expect(screen.getByText("Paste clips at playhead")).toBeInTheDocument();
    expect(screen.getByText("Duplicate selection (clips, range, or pattern)")).toBeInTheDocument();
  });

  it("shows alternative bindings (Redo also answers Ctrl+Shift+Z)", () => {
    rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);
    expect(screen.getByText("Ctrl + Y")).toBeInTheDocument();
    expect(screen.getByText("Ctrl + Shift + Z")).toBeInTheDocument();
    expect(screen.getAllByText("or").length).toBeGreaterThan(0);
  });

  it("does not show profile-specific mappings before a DAW profile is selected, then maps Cubase actions", async () => {
    const previousProfile = window.localStorage.getItem("pf-daw-profile-v1");
    window.localStorage.removeItem("pf-daw-profile-v1");
    const user = userEvent.setup();
    const view = rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);

    try {
      expect(screen.queryByText("MIDI part / Key Editor → Pattern")).not.toBeInTheDocument();
      await user.selectOptions(screen.getByLabelText("Show familiar terms for"), "cubase");

      expect(screen.getByText("MIDI part / Key Editor → Pattern")).toBeInTheDocument();
      expect(screen.getByText("Project window → Song → Arrangement")).toBeInTheDocument();
      expect(screen.getByText("Export Audio Mixdown → Export panel")).toBeInTheDocument();
      expect(screen.getByText("Track list → Tracks → Track tabs")).toBeInTheDocument();
      expect(screen.getByText("MediaBay preview → Sounds → Preview")).toBeInTheDocument();
      expect(screen.getByText("MIDI recording → Top bar → Record MIDI")).toBeInTheDocument();
      expect(screen.getByText("Audio track recording → Song → Arrangement → ● REC")).toBeInTheDocument();
      expect(screen.getByText("Audio comping → Arrangement → Take Lanes → Comp")).toBeInTheDocument();
      expect(
        screen.getByText("Tab / Shift+Tab moves between tracks; 1–9 selects a track by position."),
      ).toBeInTheDocument();
      expect(screen.getAllByText("Alt + 4").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Alt + 3").length).toBeGreaterThan(0);
      expect(window.localStorage.getItem("pf-daw-profile-v1")).toBe("cubase");
    } finally {
      view.unmount();
      if (previousProfile === null) window.localStorage.removeItem("pf-daw-profile-v1");
      else window.localStorage.setItem("pf-daw-profile-v1", previousProfile);
    }
  });

  it.each([
    [
      "FL Studio",
      "fl-studio",
      "Channel Rack / Playlist track",
      "Browser preview",
      "Playlist audio recording",
      "Playlist take lanes",
    ],
    ["Pro Tools", "pro-tools", "Track list", "Workspace preview", "Track record-enable", "Playlists / comping"],
  ])(
    "shows existing KYX routes alongside %s terminology",
    async (_name, profile, tracks, audition, recording, comp) => {
      const previousProfile = window.localStorage.getItem("pf-daw-profile-v1");
      window.localStorage.removeItem("pf-daw-profile-v1");
      const user = userEvent.setup();
      const view = rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);

      try {
        await user.selectOptions(screen.getByLabelText("Show familiar terms for"), profile);
        expect(screen.getByText(`${tracks} → Tracks → Track tabs`)).toBeInTheDocument();
        expect(screen.getByText(`${audition} → Sounds → Preview`)).toBeInTheDocument();
        expect(screen.getByText(`${recording} → Song → Arrangement → ● REC`)).toBeInTheDocument();
        expect(screen.getByText(`${comp} → Arrangement → Take Lanes → Comp`)).toBeInTheDocument();
      } finally {
        view.unmount();
        if (previousProfile === null) window.localStorage.removeItem("pf-daw-profile-v1");
        else window.localStorage.setItem("pf-daw-profile-v1", previousProfile);
      }
    },
  );

  it("allows a user to change a global shortcut but rejects colliding chords", async () => {
    const user = userEvent.setup();
    const view = rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);

    try {
      await user.click(screen.getByRole("button", { name: "Change shortcut for Play / Pause" }));
      fireEvent.keyDown(window, { key: "Z", ctrlKey: true, shiftKey: true });
      expect(screen.getByText("Already used by Redo.")).toBeInTheDocument();
      expect(screen.getByText("Space")).toBeInTheDocument();

      fireEvent.keyDown(window, { key: "U", ctrlKey: true, shiftKey: true });
      expect(screen.getByText("Ctrl + Shift + U")).toBeInTheDocument();
      expect(screen.getByText("Saved Ctrl + Shift + U for Play / Pause.")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Restore default shortcut for Play / Pause" }));
      expect(screen.getByText("Space")).toBeInTheDocument();
      expect(screen.queryByText("Ctrl + Shift + U")).not.toBeInTheDocument();
    } finally {
      view.unmount();
      resetShortcutBindings();
    }
  });

  it("shows mouse & touch gestures for every area", () => {
    rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);
    expect(screen.getByText("MOUSE & TOUCH — BY AREA")).toBeInTheDocument();
    // SEQUENCER is both a keyboard group and a gesture area — use getAllByText.
    expect(screen.getAllByText("SEQUENCER").length).toBeGreaterThan(0);
    expect(screen.getByText("PIANO ROLL")).toBeInTheDocument();
    expect(screen.getByText("VALUES & DICE")).toBeInTheDocument();
    expect(screen.getByText(/Velocity \(up = louder\)/)).toBeInTheDocument();
    expect(screen.getByText(/double-click resets/)).toBeInTheDocument();
  });

  it("filters shortcuts and gestures by text", async () => {
    rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);
    const search = screen.getByLabelText("Filter shortcuts and gestures");

    // "velocity" matches only gestures — keyboard groups disappear.
    fireEvent.change(search, { target: { value: "velocity" } });
    expect(screen.getByText(/Velocity \(up = louder\)/)).toBeInTheDocument();
    expect(screen.queryByText("Play / Pause")).toBeNull();
    expect(screen.queryByText("TRANSPORT")).toBeNull();

    // "undo" matches the keyboard shortcut only — gestures disappear.
    fireEvent.change(search, { target: { value: "undo" } });
    expect(screen.getByText("Undo")).toBeInTheDocument();
    expect(screen.queryByText(/Velocity \(up = louder\)/)).toBeNull();

    // Clearing restores everything.
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByText("TRANSPORT")).toBeInTheDocument();
    expect(screen.getByText(/Velocity \(up = louder\)/)).toBeInTheDocument();
  });

  it("shows an empty state for nonsense queries", async () => {
    rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Filter shortcuts and gestures"), {
      target: { value: "zzz-nothing" },
    });
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
  });

  it("returns focus to the trigger when it closes (§14)", async () => {
    // End-to-end guard for the focus-restore wiring at a real call site: the
    // hook only works if `HelpOverlay` hands it the live `open` flag, so a
    // refactor that passes a stale or inverted value fails here rather than
    // silently dropping a keyboard user back on <body>.
    const user = userEvent.setup();
    function Shell() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            trigger
          </button>
          <HelpOverlay open={open} onClose={() => setOpen(false)} />
        </div>
      );
    }
    rtlRender(<Shell />);

    const trigger = screen.getByRole("button", { name: "trigger" });
    await user.click(trigger);
    // The overlay takes focus for its filter on open.
    expect(document.activeElement).not.toBe(trigger);

    await user.click(screen.getByLabelText("Close help"));

    expect(document.activeElement).toBe(trigger);
  });
});
