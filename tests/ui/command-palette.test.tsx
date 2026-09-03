/**
 * Command palette — fuzzy filter (pure) + overlay wiring.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { PaletteOverlay } from "../../src/ui/PaletteOverlay";
import {
  buildPaletteActions,
  filterActions,
  fuzzyScore,
  type PaletteAction,
  type PaletteDeps,
} from "../../src/ui/commandPalette";
import { renderWithContext } from "../helpers";

function action(overrides: Partial<PaletteAction> = {}): PaletteAction {
  return {
    id: "a1",
    title: "Solo selected track",
    group: "Tracks",
    run: vi.fn(),
    ...overrides,
  };
}

describe("fuzzyScore", () => {
  it("returns −1 when the needle is not a subsequence", () => {
    expect(fuzzyScore("Play / Pause", "xyz")).toBe(-1);
  });

  it("prefers contiguous and word-start hits over scattered ones", () => {
    const contiguous = fuzzyScore("Solo selected track", "solo");
    const scattered = fuzzyScore("sAlt boOkmarks", "solo");
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("empty query scores 0", () => {
    expect(fuzzyScore("anything", "")).toBe(0);
    expect(fuzzyScore("anything", "   ")).toBe(0);
  });
});

describe("filterActions", () => {
  const actions = [
    action({ id: "1", title: "Play / Pause", group: "Transport" }),
    action({ id: "2", title: "Solo selected track", group: "Tracks", keywords: "solo mute" }),
    action({ id: "3", title: "Export MP3", group: "Share", keywords: "bounce render encode" }),
    action({ id: "4", title: "Show help", group: "Help" }),
  ];

  it("returns everything unranked for an empty query", () => {
    expect(filterActions(actions, "")).toHaveLength(4);
  });

  it("ranks title matches above keyword matches", () => {
    const ranked = filterActions(actions, "solo");
    expect(ranked[0].id).toBe("2");
  });

  it("finds actions by keywords (bounce → export mp3)", () => {
    const ranked = filterActions(actions, "bounce");
    expect(ranked).toHaveLength(1);
    expect(ranked[0].id).toBe("3");
  });

  it("drops actions with no match", () => {
    const ranked = filterActions(actions, "zzz");
    expect(ranked).toHaveLength(0);
  });
});

describe("buildPaletteActions", () => {
  it("maps every shortcut to an action plus the palette-only extras", () => {
    const runShortcut = vi.fn();
    const actions = buildPaletteActions({
      runShortcut,
      snapshotNow: vi.fn(),
      openGallery: vi.fn(),
      toggleHistoryPanel: vi.fn(),
      toggleDiagnostics: vi.fn(),
    });
    const play = actions.find((a) => a.id === "shortcut:playPause")!;
    expect(play.title).toBe("Play / Pause");
    expect(play.binding).toBe("Space");
    play.run();
    expect(runShortcut).toHaveBeenCalledWith("playPause");
    expect(actions.some((a) => a.id === "extra:snapshot")).toBe(true);
    expect(actions.some((a) => a.id === "extra:gallery")).toBe(true);
  });
});

describe("PaletteOverlay", () => {
  function paletteDeps(): PaletteDeps & { runShortcut: ReturnType<typeof vi.fn> } {
    return {
      runShortcut: vi.fn(),
      snapshotNow: vi.fn(),
      openGallery: vi.fn(),
      toggleHistoryPanel: vi.fn(),
      toggleDiagnostics: vi.fn(),
    };
  }

  it("renders nothing when closed", () => {
    const { container } = renderWithContext(<PaletteOverlay open={false} deps={paletteDeps()} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists actions with binding hints; typing filters", () => {
    const onClose = vi.fn();
    renderWithContext(<PaletteOverlay open deps={paletteDeps()} onClose={onClose} />);
    expect(screen.getByText("Play / Pause")).toBeTruthy();
    expect(screen.getByText("Solo selected track")).toBeTruthy();
    expect(screen.getByText("Space")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search commands"), { target: { value: "solo" } });
    expect(screen.getByText("Solo selected track")).toBeTruthy();
    expect(screen.queryByText("Play / Pause")).toBeNull();
  });

  it("Enter runs the selected action (through the shared shortcut dispatch) and closes", () => {
    const onClose = vi.fn();
    const deps = paletteDeps();
    renderWithContext(<PaletteOverlay open deps={deps} onClose={onClose} />);
    const input = screen.getByLabelText("Search commands");
    fireEvent.change(input, { target: { value: "solo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
    expect(deps.runShortcut).toHaveBeenCalledWith("toggleSoloTrack");
  });

  it("arrow keys move the selection; first result is preselected", () => {
    renderWithContext(<PaletteOverlay open deps={paletteDeps()} onClose={vi.fn()} />);
    const input = screen.getByLabelText("Search commands");
    const selectedClass = () =>
      Array.from(document.querySelectorAll(".palette-item")).find((el) => el.className.includes("selected"))!
        .textContent ?? "";
    // The full shortcut registry backs the palette — first entry is Play/Pause,
    // second is Stop (table order).
    expect(selectedClass()).toContain("Play / Pause");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selectedClass()).toContain("Stop (clears help/selection first)");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selectedClass()).toContain("Play / Pause");
  });

  it("Escape closes and consumes the event so the studio shortcuts stay quiet", () => {
    const onClose = vi.fn();
    renderWithContext(<PaletteOverlay open deps={paletteDeps()} onClose={onClose} />);
    const input = screen.getByLabelText("Search commands");
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(onClose).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });
});
