import { describe, expect, it, vi } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
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

  it("has title KEYBOARD SHORTCUTS", () => {
    rtlRender(<HelpOverlay open={true} onClose={vi.fn()} />);
    expect(screen.getByText("KEYBOARD SHORTCUTS")).toBeInTheDocument();
  });

  it("calls onClose when CLOSE button clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    rtlRender(<HelpOverlay open={true} onClose={onClose} />);
    await user.click(screen.getByLabelText("Close shortcuts"));
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
});
