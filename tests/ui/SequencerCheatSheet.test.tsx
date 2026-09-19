/**
 * Sequencer gesture cheat sheet — the toggle opens a dismissible panel that
 * documents the sequencer's hidden drags/keys; Escape and ✕ close it.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { SequencerCheatSheet } from "../../src/ui/SequencerCheatSheet";
import { renderWithContext } from "../helpers";
import userEvent from "@testing-library/user-event";

describe("SequencerCheatSheet", () => {
  it("renders the gesture groups and key entries", () => {
    renderWithContext(<SequencerCheatSheet onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: /gesture cheat sheet/i })).toBeInTheDocument();
    for (const group of ["STEPS", "SELECT", "KEYS — drums", "KEYS — melodic", "PIANO ROLL", "TRANSPORT", "GLOBAL"]) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }
    // a few load-bearing gestures
    expect(screen.getByText("microtiming (early/late)")).toBeInTheDocument();
    expect(screen.getByText("probability")).toBeInTheDocument();
    expect(screen.getByText("loop region")).toBeInTheDocument();
    expect(screen.getByText("horizontal zoom")).toBeInTheDocument();
  });

  it("closes via the ✕ button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithContext(<SequencerCheatSheet onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Close cheat sheet" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderWithContext(<SequencerCheatSheet onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
