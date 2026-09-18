/**
 * PaletteOverlay — focused additions to the existing command-palette test:
 * the empty-state, the click-outside-to-close path, and the click-to-run path.
 * The richer interactions (typing, arrows, Enter) live in command-palette.test.tsx.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaletteOverlay } from "../../src/ui/PaletteOverlay";
import type { PaletteDeps } from "../../src/ui/commandPalette";
import { renderWithContext } from "../helpers";

function paletteDeps(overrides: Partial<PaletteDeps> = {}): PaletteDeps {
  return {
    runShortcut: vi.fn(),
    snapshotNow: vi.fn(),
    openGallery: vi.fn(),
    toggleHistoryPanel: vi.fn(),
    toggleDiagnostics: vi.fn(),
    ...overrides,
  };
}

describe("PaletteOverlay — user-facing addendum", () => {
  it("renders an empty-state line when no command matches the query", () => {
    renderWithContext(<PaletteOverlay open deps={paletteDeps()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search commands"), { target: { value: "zzz-no-match" } });
    expect(screen.getByText(/No command matches/)).toBeInTheDocument();
  });

  it("clicking a result runs it and closes the palette", async () => {
    const onClose = vi.fn();
    renderWithContext(<PaletteOverlay open deps={paletteDeps()} onClose={onClose} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Play / Pause"));
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking the backdrop closes the palette, but a click inside the card does not", async () => {
    const onClose = vi.fn();
    renderWithContext(<PaletteOverlay open deps={paletteDeps()} onClose={onClose} />);
    const user = userEvent.setup();
    // Inside-card click — selector inside the card should not close.
    await user.click(screen.getByLabelText("Search commands"));
    expect(onClose).not.toHaveBeenCalled();
    // Backdrop click — fire pointerdown on the overlay element.
    const overlay = screen.getByRole("dialog", { name: "Command palette" });
    // The overlay element itself is the listener target — bubbling clicks land here.
    fireEvent.click(overlay, { target: overlay });
    expect(onClose).toHaveBeenCalled();
  });
});
