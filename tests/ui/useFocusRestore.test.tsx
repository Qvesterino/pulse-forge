import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useFocusRestore } from "../../src/ui/useFocusRestore";

/**
 * §14 "focus restoration after dialogs".
 *
 * Four overlays (GenerateDialog, HelpOverlay, PaletteOverlay,
 * LatencyCalibrationWizard) took focus on open and never returned it on close,
 * so a keyboard user was dropped on `document.body` and had to Tab back from
 * the top of the page. `ContextMenu` and the TopBar overflow menu already did
 * this correctly — this pins the shared behaviour they and the new call sites
 * now share.
 *
 * `autoFocus` on the inner input is load-bearing, not decoration. It is what
 * makes the bug real: focus moves during the commit, before any effect runs and
 * before a `ref` prop is attached. An implementation that snapshots
 * `document.activeElement` in the open effect, or that filters focus events with
 * `ref.current.contains(...)`, records the overlay's own input as the thing to
 * restore and therefore restores nothing. Measured in this repo, that is
 * exactly the failure these tests are built to catch.
 *
 * The harness reproduces the two ways the real app closes an overlay besides
 * the close button, and neither of them may take focus — otherwise the test
 * would pass for the wrong reason (a live focused button, not a restore):
 *  - Escape, via the global keydown cascade in `App.tsx`;
 *  - a click on the non-focusable scrim.
 *
 * The trigger deliberately lives in the shell, not in the dialog component, so
 * the teardown case is real: a parent can unmount the panel that owns the
 * dialog while the shell button that opened it is still on screen. The
 * opposite — the dialog's DOM vanishing while `open` stays true — is not a
 * state any call site can produce, since all four render `if (!open) return
 * null`, so it is deliberately not asserted here.
 */
function Dialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const overlayRef = useFocusRestore<HTMLDivElement>(open);
  if (!open) return null;
  return (
    <>
      <div data-testid="scrim" onClick={onClose} />
      <div role="dialog" aria-label="probe" ref={overlayRef}>
        <input aria-label="inner" autoFocus />
        <button type="button" onClick={onClose}>
          close
        </button>
      </div>
    </>
  );
}

function Shell({ label, mounted = true }: { label: string; mounted?: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open {label}
      </button>
      <input aria-label={`${label} query`} />
      {mounted && <Dialog open={open} onClose={() => setOpen(false)} />}
    </div>
  );
}

describe("§14 useFocusRestore", () => {
  it("returns focus to the trigger when the overlay closes via its own close button", async () => {
    const user = userEvent.setup();
    render(<Shell label="alpha" />);

    const trigger = screen.getByRole("button", { name: "open alpha" });
    await user.click(trigger);
    // The overlay's inner input took focus on open (autoFocus).
    expect(screen.getByLabelText("inner")).toHaveFocus();

    // The close button takes focus on the way, so the autoFocus input is not
    // what holds focus at close time — focus is orphaned when the button unmounts.
    await user.click(screen.getByRole("button", { name: "close" }));

    // Not on <body>: back on the element that opened it.
    expect(document.activeElement).toBe(trigger);
  });

  it("restores focus when Escape closes the overlay without touching focus at all", async () => {
    const user = userEvent.setup();
    render(<Shell label="beta" />);

    const trigger = screen.getByRole("button", { name: "open beta" });
    await user.click(trigger);
    expect(screen.getByLabelText("inner")).toHaveFocus();

    // The real path: the global cascade flips the flag. Nothing is clicked, so
    // the autoFocus input is the last holder of focus and orphans on unmount.
    fireEvent.keyDown(window, { key: "Escape" });

    expect(document.activeElement).toBe(trigger);
  });

  it("restores focus when the component that owns the overlay is torn down while open", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Shell label="eps" />);

    const trigger = screen.getByRole("button", { name: "open eps" });
    await user.click(trigger);
    expect(screen.getByLabelText("inner")).toHaveFocus();

    // A parent unmounts the panel holding the dialog. The trigger lives in the
    // shell, so it is still on screen and is where focus belongs.
    rerender(<Shell label="eps" mounted={false} />);

    expect(document.activeElement).toBe(trigger);
  });

  it("does NOT steal focus back when the user moved it to another control", async () => {
    const user = userEvent.setup();
    render(<Shell label="gamma" />);

    const outside = screen.getByLabelText("gamma query");
    await user.click(screen.getByRole("button", { name: "open gamma" }));
    // The user tabs/clicks away to a control outside the overlay.
    outside.focus();
    expect(outside).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "close" }));

    // Focus must stay where the user put it.
    expect(document.activeElement).toBe(outside);
  });

  it("leaves focus alone when the overlay closes without taking it in the first place", async () => {
    // Focus was moved to a control outside the overlay and the overlay then
    // closed without touching anything focusable. There is nothing orphaned,
    // and focus must stay exactly where the user left it.
    const user = userEvent.setup();
    render(<Shell label="delta" />);

    const trigger = screen.getByRole("button", { name: "open delta" });
    const outside = screen.getByLabelText("delta query");
    await user.click(trigger);

    outside.focus();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(document.activeElement).toBe(outside);

    // The ordinary case still repairs focus, afterwards.
    await user.click(trigger);
    expect(screen.getByLabelText("inner")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "close" }));
    expect(document.activeElement).toBe(trigger);
  });
});
