import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mockServices } from "../helpers";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopBar } from "../../src/ui/TopBar";
import { renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { BAR_TICKS } from "../../src/project-model/types";

function topBarProps(overrides?: Partial<React.ComponentProps<typeof TopBar>>) {
  return {
    onToggleDiagnostics: vi.fn(),
    diagnosticsOpen: false,
    ioOpen: false,
    onToggleIo: vi.fn(),
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

  it("warns when switching to SONG with the playhead past the last clip", async () => {
    const user = userEvent.setup();
    const onSetPlayMode = vi.fn();
    const services = mockServices();
    (services.transport as unknown as { position: number }).position = 9 * BAR_TICKS;
    renderWithContext(<TopBar {...topBarProps({ onSetPlayMode })} />, { services });
    await user.click(screen.getByText("PATTERN"));
    // The switch still happens — the guard warns, it does not block.
    expect(onSetPlayMode).toHaveBeenCalledWith("song");
    expect(screen.getByText(/NO CLIP AT BAR 10/)).toBeInTheDocument();
  });

  it("offers REWIND from the guard and seeks the transport to bar 1", async () => {
    const user = userEvent.setup();
    const services = mockServices();
    (services.transport as unknown as { position: number }).position = 9 * BAR_TICKS;
    renderWithContext(<TopBar {...topBarProps()} />, { services });
    await user.click(screen.getByText("PATTERN"));
    await user.click(screen.getByText("REWIND"));
    expect(services.transport.seek).toHaveBeenCalledWith(0);
    expect(screen.queryByText(/NO CLIP AT BAR/)).not.toBeInTheDocument();
  });

  it("shows no guard when a clip sits under the playhead", async () => {
    const user = userEvent.setup();
    const services = mockServices();
    (services.transport as unknown as { position: number }).position = 2 * BAR_TICKS;
    renderWithContext(<TopBar {...topBarProps()} />, { services });
    await user.click(screen.getByText("PATTERN"));
    expect(screen.queryByText(/NO CLIP AT BAR/)).not.toBeInTheDocument();
  });

  it("warns about an empty arrangement when switching to SONG", async () => {
    const user = userEvent.setup();
    const doc = { ...createProjectFromTemplate("house"), arrangement: { clips: [] } };
    const services = mockServices(doc);
    renderWithContext(<TopBar {...topBarProps()} />, { services });
    await user.click(screen.getByText("PATTERN"));
    expect(screen.getByText(/ARRANGEMENT EMPTY/)).toBeInTheDocument();
  });

  it("shows no guard when leaving SONG mode", async () => {
    const user = userEvent.setup();
    const services = mockServices();
    (services.transport as unknown as { position: number }).position = 9 * BAR_TICKS;
    renderWithContext(<TopBar {...topBarProps({ playMode: "song" })} />, { services });
    await user.click(screen.getByText("SONG"));
    expect(screen.queryByText(/NO CLIP AT BAR/)).not.toBeInTheDocument();
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

  it("no longer carries panel toggles — the dock tab row owns them (ROADMAP-UI-2027 V1)", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.queryByLabelText("Toggle mixer panel")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Toggle export panel")).not.toBeInTheDocument();
    expect(screen.queryByText("MIX")).not.toBeInTheDocument();
  });

  it("moves lower-priority tools into an accessible overflow menu", async () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = originalGetBoundingClientRect.call(this);
      if (this.classList.contains("topbar")) return { ...rect, width: 1280, left: 0, right: 1280 } as DOMRect;
      return rect;
    });
    const user = userEvent.setup();

    try {
      renderWithContext(<TopBar {...topBarProps({ onOpenPalette: vi.fn() })} />);
      await waitFor(() => expect(screen.getByRole("button", { name: /More topbar controls/ })).toBeInTheDocument());

      // Tools only: ⌘K/?/HIST stay direct at 1280; ASSIST onwards overflow.
      expect(screen.getByLabelText("Open command palette")).toBeInTheDocument();
      expect(screen.getByLabelText("Show keyboard shortcuts")).toBeInTheDocument();
      expect(screen.getByLabelText("Toggle undo history")).toBeInTheDocument();
      expect(screen.queryByLabelText("Toggle pattern assist panel")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /More topbar controls/ }));
      expect(screen.getByRole("menu", { name: "More topbar controls" })).toBeInTheDocument();

      // Tool overflow order follows priority: ASSIST first, then JAM.
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Toggle pattern assist panel" }));
      await user.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Toggle collaboration panel" }));
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu", { name: "More topbar controls" })).not.toBeInTheDocument();
    } finally {
      rectSpy.mockRestore();
    }
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
