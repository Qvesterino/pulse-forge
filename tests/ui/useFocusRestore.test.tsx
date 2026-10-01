import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useFocusRestore } from "../../src/ui/useFocusRestore";

/**
 * §14 "focus restoration after dialogs".
 *
 * Four overlays (GenerateDialog, HelpOverlay, PaletteOverlay,
 * LatencyCalibrationWizard) focused an input on open and never returned focus
 * on close, so a keyboard user was dropped on `document.body` and had to Tab
 * back from the top of the page. `ContextMenu` and the TopBar overflow menu
 * already did this correctly — this pins the shared behaviour they and the new
 * call sites now share.
 *
 * The second test is the guard: focus must NOT be stolen back if the user
 * moved it somewhere real while the overlay was open. That is the half that is
 * easy to get wrong, and getting it wrong throws a keyboard user out of
 * whatever they are using.
 */
function Overlay({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  const overlayRef = useFocusRestore<HTMLDivElement>(open);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open {label}
      </button>
      <input aria-label={`${label} query`} />
      {open && (
        <div role="dialog" aria-label={label} ref={overlayRef}>
          <input aria-label={`${label} inner`} autoFocus />
          <button type="button" onClick={() => setOpen(false)}>
            close {label}
          </button>
        </div>
      )}
    </div>
  );
}

describe("§14 useFocusRestore", () => {
  it("returns focus to the trigger that opened the overlay", async () => {
    const user = userEvent.setup();
    render(<Overlay label="alpha" />);

    const trigger = screen.getByRole("button", { name: "open alpha" });
    await user.click(trigger);
    // The overlay's inner input took focus on open (autoFocus).
    expect(screen.getByLabelText("alpha inner")).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "close alpha" }));

    // Not on <body>: back on the element that opened it.
    expect(document.activeElement).toBe(trigger);
  });

  it("restores focus when the overlay unmounts for any reason, not just the close button", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Overlay label="beta" />);

    const trigger = screen.getByRole("button", { name: "open beta" });
    await user.click(trigger);
    expect(screen.getByLabelText("beta inner")).toHaveFocus();

    // Parent drops the overlay rather than the child calling its own close.
    rerender(<div />);

    expect(document.activeElement).toBe(trigger);
  });

  it("does NOT steal focus back when the user moved it to another control", async () => {
    const user = userEvent.setup();
    render(<Overlay label="gamma" />);

    const trigger = screen.getByRole("button", { name: "open gamma" });
    const outside = screen.getByLabelText("gamma query");
    await user.click(trigger);
    // The user tabs/clicks away to a control outside the overlay.
    outside.focus();
    expect(outside).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "close gamma" }));

    // Focus must stay where the user put it.
    expect(document.activeElement).toBe(outside);
  });
});
