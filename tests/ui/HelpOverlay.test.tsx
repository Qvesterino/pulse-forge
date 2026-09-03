import { describe, expect, it, vi } from "vitest";
import { render as rtlRender, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HelpOverlay } from "../../src/ui/HelpOverlay";

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

  it("shows alternative bindings (Redo also answers Ctrl+Shift+Z)", () => {
    rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);
    expect(screen.getByText("Ctrl + Y")).toBeInTheDocument();
    expect(screen.getByText("Ctrl + Shift + Z")).toBeInTheDocument();
    expect(screen.getAllByText("or").length).toBeGreaterThan(0);
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
});
