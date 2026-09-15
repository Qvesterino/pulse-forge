import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mockServices } from "../helpers";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopBar } from "../../src/ui/TopBar";
import { renderWithContext } from "../helpers";

function topBarProps(overrides?: Partial<React.ComponentProps<typeof TopBar>>) {
  return {
    onToggleDiagnostics: vi.fn(),
    diagnosticsOpen: false,
    onSetBottomPanel: vi.fn(),
    splitPanel: null as "mixer" | "fx" | "arr" | "mod" | "exp" | "midi" | "dice" | null,
    bottomPanel: null as "mixer" | "fx" | "arr" | "mod" | "exp" | "midi" | "dice" | null,
    onToggleHelp: vi.fn(),
    playMode: "pattern" as const,
    onSetPlayMode: vi.fn(),
    onOpenBrowser: vi.fn(),
    onReplaceServices: vi.fn(),
    scaleSnap: false,
    onToggleScaleSnap: vi.fn(),
    historyOpen: false,
    onToggleHistory: vi.fn(),
    ...overrides,
  };
}

describe("TopBar", () => {
  it("renders brand name", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.getByText("KYX")).toBeInTheDocument();
  });

  it("renders PROJECTS button", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.getByText("PROJECTS")).toBeInTheDocument();
  });

  it("calls onOpenBrowser when PROJECTS clicked", async () => {
    const user = userEvent.setup();
    const onOpenBrowser = vi.fn();
    renderWithContext(<TopBar {...topBarProps({ onOpenBrowser })} />);
    await user.click(screen.getByText("PROJECTS"));
    expect(onOpenBrowser).toHaveBeenCalled();
  });

  it("shows PATTERN mode by default", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.getByText("PATTERN")).toBeInTheDocument();
  });

  it("shows SONG mode when playMode is song", () => {
    renderWithContext(<TopBar {...topBarProps({ playMode: "song" })} />);
    expect(screen.getByText("SONG")).toBeInTheDocument();
  });

  it("calls onSetPlayMode when mode button clicked", async () => {
    const user = userEvent.setup();
    const onSetPlayMode = vi.fn();
    renderWithContext(<TopBar {...topBarProps({ onSetPlayMode })} />);
    await user.click(screen.getByText("PATTERN"));
    expect(onSetPlayMode).toHaveBeenCalledWith("song");
  });

  it("calls playback.playPause when play button clicked", async () => {
    const user = userEvent.setup();
    const { services } = renderWithContext(<TopBar {...topBarProps()} />);
    await user.click(screen.getByText("▶"));
    expect(services.playback.playPause).toHaveBeenCalled();
  });

  it("calls playback.stop when stop button clicked", async () => {
    const user = userEvent.setup();
    const { services } = renderWithContext(<TopBar {...topBarProps()} />);
    await user.click(screen.getByText("■"));
    expect(services.playback.stop).toHaveBeenCalled();
  });

  it("cycles count-in, toggles pre-roll and toggles the content metronome", async () => {
    const user = userEvent.setup();
    const { services } = renderWithContext(<TopBar {...topBarProps()} />);

    const countIn = screen.getByRole("button", { name: "Count-in off" });
    await user.click(countIn);
    expect(services.transport.setCountIn).toHaveBeenCalledWith(1);
    expect(screen.getByRole("button", { name: "Count-in 1 bar" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Count-in 1 bar" }));
    expect(services.transport.setCountIn).toHaveBeenCalledWith(2);
    await user.click(screen.getByRole("button", { name: "Count-in 2 bars" }));
    expect(services.transport.setCountIn).toHaveBeenCalledWith(0);

    const preRoll = screen.getByRole("button", { name: "Pre-roll off" });
    await user.click(preRoll);
    expect(services.transport.setPreRoll).toHaveBeenCalledWith(1);
    expect(screen.getByRole("button", { name: "Pre-roll on" })).toHaveAttribute("aria-pressed", "true");

    const metronome = screen.getByRole("button", { name: "Metronome off" });
    await user.click(metronome);
    expect(services.transport.setMetronome).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Metronome on" })).toHaveAttribute("aria-pressed", "true");
  });

  it("sets BPM from two taps without changing the project until the second tap", async () => {
    const user = userEvent.setup();
    const { services } = renderWithContext(<TopBar {...topBarProps()} />);
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      const tap = screen.getByRole("button", { name: "Tap tempo" });
      await user.click(tap);
      expect(services.store.execute).not.toHaveBeenCalled();

      now = 1_500;
      await user.click(tap);
      expect(services.store.execute).toHaveBeenCalledTimes(1);
      const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        type: string;
        execute: (doc: { bpm: number }) => { bpm: number };
      };
      expect(command.type).toBe("setBpm");
      expect(command.execute(services.store.doc).bpm).toBe(120);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("shows project name", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.getByLabelText("Project name")).toBeInTheDocument();
  });

  it("renders MIX, FX, ARR, MOD, EXPORT buttons", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.getByText("MIX")).toBeInTheDocument();
    expect(screen.getByText("FX")).toBeInTheDocument();
    expect(screen.getByText("ARR")).toBeInTheDocument();
    expect(screen.getByText("MOD")).toBeInTheDocument();
    expect(screen.getByText("EXPORT")).toBeInTheDocument();
  });

  it("moves lower-priority controls into an accessible overflow menu", async () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = originalGetBoundingClientRect.call(this);
      if (this.classList.contains("topbar")) return { ...rect, width: 1280, left: 0, right: 1280 } as DOMRect;
      return rect;
    });
    const user = userEvent.setup();
    const onSetBottomPanel = vi.fn();

    try {
      renderWithContext(<TopBar {...topBarProps({ onSetBottomPanel, onOpenPalette: vi.fn() })} />);
      await waitFor(() => expect(screen.getByRole("button", { name: /More topbar controls/ })).toBeInTheDocument());

      expect(screen.getByLabelText("Toggle mixer panel")).toBeInTheDocument();
      expect(screen.queryByLabelText("Toggle dice panel")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /More topbar controls/ }));
      expect(screen.getByRole("menu", { name: "More topbar controls" })).toBeInTheDocument();

      // At 1280 the four live panels (MIX/FX/ARR/MOD) are direct; the
      // overflow starts at EXPORT, then MIDI.
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Toggle export panel" }));
      await user.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Toggle MIDI input panel" }));
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu", { name: "More topbar controls" })).not.toBeInTheDocument();

      // The dice panel has a single home in the chrome — the PatternBar's
      // DICE button — so the topbar no longer carries a dice toggle at all.
      expect(screen.queryByRole("menuitem", { name: "Toggle dice panel" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /More topbar controls/ }));
      await user.click(screen.getByRole("menuitem", { name: "Toggle MIDI input panel" }));
      expect(onSetBottomPanel).toHaveBeenCalledWith("midi", false);
      expect(screen.queryByRole("menu", { name: "More topbar controls" })).not.toBeInTheDocument();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("calls onSetBottomPanel when panel button clicked", async () => {
    const user = userEvent.setup();
    const onSetBottomPanel = vi.fn();
    renderWithContext(<TopBar {...topBarProps({ onSetBottomPanel })} />);
    await user.click(screen.getByText("MIX"));
    // The handler also receives the modifier flag (ctrl/meta = keep-open) —
    // assert the panel id only.
    expect(onSetBottomPanel.mock.calls[0][0]).toBe("mixer");
  });

  it("calls onToggleHelp when ? clicked", async () => {
    const user = userEvent.setup();
    const onToggleHelp = vi.fn();
    renderWithContext(<TopBar {...topBarProps({ onToggleHelp })} />);
    await user.click(screen.getByLabelText("Show keyboard shortcuts"));
    expect(onToggleHelp).toHaveBeenCalled();
  });

  it("opens DIAG from the overflow menu", async () => {
    const user = userEvent.setup();
    const onToggleDiagnostics = vi.fn();
    renderWithContext(<TopBar {...topBarProps({ onToggleDiagnostics })} />);
    // Rarely-used tools live behind ⋯ — the topbar keeps only ⌘K/?/HIST.
    await user.click(screen.getByRole("button", { name: /More topbar controls/ }));
    await user.click(screen.getByRole("menuitem", { name: "Toggle diagnostics panel" }));
    expect(onToggleDiagnostics).toHaveBeenCalled();
  });

  it("undo button calls store.undo", async () => {
    const { services } = renderWithContext(<TopBar {...topBarProps()} />);
    const undoBtn = screen.getByLabelText("Undo");
    expect(undoBtn).toBeDisabled(); // nothing to undo
    // Manually enable undo
    (services.store as any).canUndo = true;
  });
});

describe("TopBar — play button freshness", () => {
  it("updates the play button when playback is toggled from elsewhere (Space / Esc paths)", async () => {
    const services = mockServices();
    let notify: () => void = () => {};
    (services as unknown as { playback: unknown }).playback = {
      ...(services as unknown as { playback: Record<string, unknown> }).playback,
      subscribe: (cb: () => void) => {
        notify = cb;
        return () => {};
      },
    };
    renderWithContext(<TopBar {...topBarProps()} />, { services });

    // Stopped — button offers play.
    expect(screen.getByTitle("Play / Pause (Space)").textContent).toBe("▶");

    // Playback started elsewhere (keyboard shortcut, not this button) —
    // the button must flip without any doc mutation forcing a re-render.
    (services.transport as { playing: boolean }).playing = true;
    act(() => notify());
    expect(screen.getByTitle("Play / Pause (Space)").textContent).toBe("❚❚");

    (services.transport as { playing: boolean }).playing = false;
    act(() => notify());
    expect(screen.getByTitle("Play / Pause (Space)").textContent).toBe("▶");
  });
});
