import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/ui/App";
import { ServicesContext } from "../../src/ui/context";
import type { Command } from "../../src/commands/types";
import { addAudioClip } from "../../src/commands/audioClips";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { DEFAULT_LAYOUT_STATE, LAYOUT_STORAGE_KEY } from "../../src/shared/layout-data";
import { initLayout } from "../../src/ui/layout";
import { mockServices, renderWithContext } from "../helpers";
import { stashSongStarter } from "../../src/landing/handoff";
import { resetShortcutBindings, setShortcutBinding } from "../../src/ui/shortcuts";
import { bindPadKey, resetPadKeys, setPadKeysArmed } from "../../src/ui/padKeys";

describe("App (top-level shell)", () => {
  it("renders the .app root without crashing", () => {
    const services = mockServices();
    const { container } = renderWithContext(
      <App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />,
      { services },
    );
    expect(container.querySelector(".app")).not.toBeNull();
  });

  it("loads the Studio I/O panel when the audio settings popover opens", async () => {
    const services = mockServices();
    const user = userEvent.setup();
    renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, { services });

    // Warm the lazy chunk BEFORE the click. Measured 2026-10-19 with this same
    // module under this same `tests/ui/` package load: issued lazily after the
    // click the import resolved in 19 677 ms, issued up front it resolved in
    // 192 ms — identical work, different position in vitest's shared vite-node
    // request queue. React then commits the panel 54 ms after the module lands.
    // Without the warm-up the whole 10 s budget is spent inside the runner and
    // the assertion reports a working panel as missing; with it, the 10 s bound
    // stays a real statement about the popover instead of about the harness.
    await import("../../src/ui/IoPanel");

    await user.click(screen.getByRole("button", { name: "Studio I/O — audio device settings" }));

    expect(screen.getByRole("dialog", { name: "Studio I/O settings" })).toBeInTheDocument();
    expect(await screen.findByText("Audio devices", {}, { timeout: 10_000 })).toBeInTheDocument();
  }, 30_000);

  it("does not duplicate the active pattern when Ctrl+D targets a selected timeline clip", async () => {
    const user = userEvent.setup();
    const template = createProjectFromTemplate("house");
    const doc = template;
    const clipCountBefore = doc.arrangement.clips.length;
    if (clipCountBefore === 0) throw new Error("house template needs an arrangement clip");
    const services = mockServices(doc);
    const beforeLayout = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    const beforeTour = window.localStorage.getItem("pf-tour-v1");
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_LAYOUT_STATE, slotA: "mixer", slotB: null }),
    );
    window.localStorage.setItem("pf-tour-v1", "1");
    initLayout();

    const view = renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, {
      services,
    });
    try {
      // Warm the lazy chunk BEFORE the click — the same reason the Studio I/O
      // test above warms IoPanel: the arrangement panel is a lazy() import
      // whose module graph takes seconds to transform under load, and the
      // 1 s waitFor below would expire before the panel ever mounted. The
      // assertion has to be about the duplicate behaviour, not about the
      // import queue.
      await import("../../src/ui/ArrangementPanel");
      await user.click(screen.getByRole("button", { name: "Toggle arrangement and scenes" }));
      const clip = await waitFor(() => {
        const node = view.container.querySelector<HTMLElement>(".arr-clip");
        expect(node).not.toBeNull();
        return node!;
      });
      await user.click(clip);
      await waitFor(() => expect(clip).toHaveClass("selected"));
      await user.keyboard("{Control>}d{/Control}");

      const execute = services.store.execute as unknown as ReturnType<typeof vi.fn>;
      await waitFor(() => expect(execute.mock.calls.some(([command]) => command.type === "duplicateClips")).toBe(true));
      const duplicate = execute.mock.calls
        .map(([command]) => command as Command)
        .find((command) => command.type === "duplicateClips");
      expect(duplicate).toBeDefined();
      const after = duplicate!.execute(doc);
      expect(after.arrangement.clips).toHaveLength(clipCountBefore + 1);
      expect(after.patterns).toEqual(doc.patterns);
    } finally {
      view.unmount();
      if (beforeLayout === null) window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
      else window.localStorage.setItem(LAYOUT_STORAGE_KEY, beforeLayout);
      if (beforeTour === null) window.localStorage.removeItem("pf-tour-v1");
      else window.localStorage.setItem("pf-tour-v1", beforeTour);
      initLayout();
    }
  }, 30_000);

  it("does not open Arrangement before the chord is assigned, then dispatches the custom binding", async () => {
    const template = createProjectFromTemplate("house");
    const services = mockServices(template);
    const previousLayout = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    const previousTour = window.localStorage.getItem("pf-tour-v1");
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_LAYOUT_STATE, slotA: "mixer", slotB: null }),
    );
    window.localStorage.setItem("pf-tour-v1", "1");
    resetShortcutBindings();
    initLayout();
    const view = renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, {
      services,
    });

    try {
      // Warm the lazy chunk BEFORE the keypress — the same reason the Studio
      // I/O test above warms IoPanel. The panel is a lazy() import whose
      // module graph takes seconds to transform under load; without the
      // warm-up the 1 s waitFor measures the import queue, not the panel.
      await import("../../src/ui/ArrangementPanel");
      fireEvent.keyDown(document.body, { key: "U", ctrlKey: true, shiftKey: true });
      expect(view.container.querySelector(".arr-panel")).toBeNull();
      setShortcutBinding("panelArr", { keyHint: "u", ctrl: true, shift: true, alt: false, meta: false });
      fireEvent.keyDown(document.body, { key: "U", ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(view.container.querySelector(".arr-panel")).not.toBeNull());
    } finally {
      view.unmount();
      resetShortcutBindings();
      if (previousLayout === null) window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
      else window.localStorage.setItem(LAYOUT_STORAGE_KEY, previousLayout);
      if (previousTour === null) window.localStorage.removeItem("pf-tour-v1");
      else window.localStorage.setItem("pf-tour-v1", previousTour);
      initLayout();
    }
  }, 30_000);

  it("does not let an unselected audio clip hijack Tab track navigation", async () => {
    const template = createProjectFromTemplate("house");
    const firstTrack = template.tracks[0];
    const secondTrack = template.tracks[1];
    if (!firstTrack || !secondTrack) throw new Error("house template needs at least two tracks");
    const doc = addAudioClip(template, firstTrack.id, "unloaded-test-audio", 0, 1).execute(template);
    const services = mockServices(doc);
    const previousLayout = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    const previousTour = window.localStorage.getItem("pf-tour-v1");
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_LAYOUT_STATE, slotA: "mixer", slotB: null }),
    );
    window.localStorage.setItem("pf-tour-v1", "1");
    initLayout();
    const view = renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, {
      services,
    });

    const activeTrackTab = () =>
      view.container.querySelector<HTMLButtonElement>('.track-tab[data-current-track="true"]');
    try {
      await waitFor(() => expect(activeTrackTab()?.getAttribute("aria-label")).toContain(firstTrack.name));
      fireEvent.keyDown(document.body, { key: "Tab" });
      await waitFor(() => expect(activeTrackTab()?.getAttribute("aria-label")).toContain(secondTrack.name));
    } finally {
      view.unmount();
      if (previousLayout === null) window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
      else window.localStorage.setItem(LAYOUT_STORAGE_KEY, previousLayout);
      if (previousTour === null) window.localStorage.removeItem("pf-tour-v1");
      else window.localStorage.setItem("pf-tour-v1", previousTour);
      initLayout();
    }
  });

  it("the AudioUnlock global pointer-down listener registers once at mount", () => {
    const services = mockServices();
    const addSpy = vi.spyOn(window, "addEventListener");
    renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, { services });
    // AudioUnlock attaches a single one-shot pointerdown listener.
    const ptr = addSpy.mock.calls.find(([event]) => (event as string) === "pointerdown");
    expect(ptr).toBeDefined();
    addSpy.mockRestore();
  });

  it("shows the general tour, but does not show the song-starter walkthrough on an ordinary first run", async () => {
    const services = mockServices();
    // Clear any prior tour-completion flag from a sibling test.
    window.localStorage.removeItem("pf-tour-v1");
    renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, { services });
    await waitFor(() => expect(screen.queryByText(/PROGRAM THE BEAT|MAKE SOUND/i)).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(screen.queryByText(/YOUR .* STARTER/)).not.toBeInTheDocument();
  });

  it("guides a song-starter handoff through the first-song path and DAW vocabulary", async () => {
    const storageKeys = ["pf-tour-v1", "pf-song-starter-tour-v1", "pf-intent-opened", "pf-daw-profile-v1"];
    const previousLocal = new Map(storageKeys.map((key) => [key, window.localStorage.getItem(key)]));
    const previousStarter = window.sessionStorage.getItem("pf-song-starter");
    const previousPrefill = window.sessionStorage.getItem("pf-intent-prefill");
    const user = userEvent.setup();
    window.localStorage.setItem("pf-tour-v1", "1");
    window.localStorage.removeItem("pf-song-starter-tour-v1");
    window.localStorage.removeItem("pf-daw-profile-v1");
    stashSongStarter({ genre: "Techno", mood: "dark", bpm: 145 });
    const services = mockServices();
    const view = renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, {
      services,
    });

    try {
      await waitFor(() => expect(screen.getByText(/1\/4 — YOUR TECHNO STARTER/)).toBeInTheDocument(), {
        timeout: 5000,
      });
      // The copy lives in src/ui/OnboardingTour.tsx (the song-starter tourBody).
      // It moved from "… song is set to 145 BPM" to "… style and 145 BPM are
      // already applied" when the handoff started describing what KYX does
      // with the pack. Pin mood + BPM + the applied semantics.
      expect(screen.getByText(/dark style and 145 BPM are already applied/)).toBeInTheDocument();
      // The guided starter is a FOCUSED flow: the DAW-profile picker belongs
      // to the general tour, so it is not offered inside the starter.
      expect(screen.queryByRole("combobox", { name: "Previous DAW profile" })).toBeNull();

      await user.click(screen.getByRole("button", { name: "NEXT" }));
      expect(screen.getByText(/2\/4 — PREVIEW AND ADD/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "NEXT" }));
      expect(screen.getByText(/3\/4 — SAVE AND REOPEN/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "NEXT" }));
      expect(screen.getByText(/4\/4 — EXPORT YOUR SONG/)).toBeInTheDocument();

      // Finishing writes the starter's OWN tour key, and the general tour
      // stays marked done so it does not follow the starter around.
      await user.click(screen.getByRole("button", { name: "LET'S FORGE" }));
      expect(window.localStorage.getItem("pf-tour-v1")).toBe("1");
      expect(window.localStorage.getItem("pf-song-starter-tour-v1")).toBe("1");
    } finally {
      view.unmount();
      for (const [key, value] of previousLocal) {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
      }
      if (previousStarter === null) window.sessionStorage.removeItem("pf-song-starter");
      else window.sessionStorage.setItem("pf-song-starter", previousStarter);
      if (previousPrefill === null) window.sessionStorage.removeItem("pf-intent-prefill");
      else window.sessionStorage.setItem("pf-intent-prefill", previousPrefill);
    }
  }, 30_000);

  it("if the tour has been completed (flag set), the OnboardingTour does NOT appear", async () => {
    const services = mockServices();
    window.localStorage.setItem("pf-tour-v1", "1");
    renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, { services });
    // give the boot timeout a chance to elapse
    await new Promise((r) => setTimeout(r, 1100));
    expect(screen.queryByText(/PROGRAM THE BEAT|MAKE SOUND/i)).not.toBeInTheDocument();
  });

  it("the desktop MCP host owns its unbind — a services swap never stacks IPC listeners", async () => {
    // Audit 13: the effect binds `kyx:mcp:call` to the CURRENT services. It must
    // unbind on cleanup — a collab swap re-runs the effect, and a leaked
    // listener would execute every forwarded tool call twice and could answer
    // from the stale (closed) project.
    const listeners = new Set<(call: unknown) => void>();
    const fakeMcp = {
      status: vi.fn(async () => ({ enabled: true, running: true, bridgeUrl: null, token: null, clientConfig: null })),
      enable: vi.fn(async () => undefined),
      disable: vi.fn(async () => undefined),
      answer: vi.fn(async () => undefined),
      onCall: vi.fn((listener: (call: unknown) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    };
    (window as unknown as { kyxDesktop?: unknown }).kyxDesktop = { isDesktop: true, mcp: fakeMcp };
    try {
      const first = mockServices();
      const view = renderWithContext(<App services={first} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, {
        services: first,
      });
      await waitFor(() => expect(listeners.size).toBe(1));

      // Collab swap: a NEW services object re-runs the effect.
      const second = mockServices();
      view.rerender(
        createElement(
          ServicesContext.Provider,
          { value: second },
          <App services={second} onOpenBrowser={() => {}} onReplaceServices={() => {}} />,
        ),
      );
      await waitFor(() => expect(listeners.size).toBe(1)); // old unbound, new bound — not 2

      view.unmount();
      await waitFor(() => expect(listeners.size).toBe(0));
    } finally {
      delete (window as unknown as { kyxDesktop?: unknown }).kyxDesktop;
    }
  });
});

describe("App — force save stays live while typing (CF-04)", () => {
  function keyHarness() {
    const services = mockServices();
    const view = renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, {
      services,
    });
    return { services, view };
  }

  it("Ctrl+S inside the project-name field still force-saves", () => {
    const { services } = keyHarness();
    const nameField = screen.getByLabelText("Project name");
    fireEvent.keyDown(nameField, { key: "s", ctrlKey: true });
    expect(services.flushSave).toHaveBeenCalled();
  });

  it("NEGATIVE: Ctrl+S outside a field still saves (the chord is not broken everywhere)", () => {
    const { services } = keyHarness();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(services.flushSave).toHaveBeenCalled();
  });

  it("NEGATIVE: Ctrl+Z inside a field keeps the text field's native undo — no project undo", () => {
    const { services } = keyHarness();
    const nameField = screen.getByLabelText("Project name");
    fireEvent.keyDown(nameField, { key: "z", ctrlKey: true });
    expect(services.store.undo).not.toHaveBeenCalled();
  });
});

describe("App — Tab traversal vs next-track scope (CF-05)", () => {
  function tabHarness() {
    const services = mockServices();
    const view = renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, {
      services,
    });
    return { services, view };
  }

  const tabOn = (element: Element) => {
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  };

  const shiftTabOn = (element: Element) => {
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("NEGATIVE: Tab on a focused control (a track tab button) is not intercepted — the browser may traverse", () => {
    const { view } = tabHarness();
    const tab = view.container.querySelector(".track-tab");
    expect(tab, "track tab did not render — the probe measured nothing").not.toBeNull();
    // Both canvas Tab actions (transient jump, next track) preventDefault;
    // leaving the event alive is the fix — the panel's controls now traverse.
    expect(tabOn(tab!)).toBe(false);
    expect(shiftTabOn(tab!)).toBe(false);
  });

  it("NEGATIVE: Tab on a slider (a [tabindex] control, e.g. the sequencer tabpanel) is not intercepted", () => {
    tabHarness();
    const panel = screen.getByRole("tabpanel");
    expect(tabOn(panel)).toBe(false);
  });

  it("canvas Tab is still taken by the handler (transient jump or next track)", () => {
    tabHarness();
    const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("App — Escape never touches the transport (CF-06)", () => {
  function escHarness() {
    const services = mockServices();
    renderWithContext(<App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />, {
      services,
    });
    return { services };
  }

  it("NEGATIVE: bare Escape with nothing to clear does not stop or seek the transport", () => {
    const { services } = escHarness();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(services.playback.stop).not.toHaveBeenCalled();
    expect(services.playback.seek).not.toHaveBeenCalled();
  });

  it("Shift+Space is the stop chord (positive control — the action did not die)", () => {
    const { services } = escHarness();
    fireEvent.keyDown(window, { key: " ", shiftKey: true });
    expect(services.playback.stop).toHaveBeenCalled();
  });

  it("NEGATIVE: bare Space must NOT trigger stop (Shift+Space only)", () => {
    const { services } = escHarness();
    fireEvent.keyDown(window, { key: " " });
    expect(services.playback.stop).not.toHaveBeenCalled();
    // …and the unmodified Space chord still reaches play/pause.
    expect(services.playback.playPause).toHaveBeenCalled();
  });

  it("NEGATIVE: Escape inside a text field blurs it and does not stop (ladder intact)", () => {
    const { services } = escHarness();
    const nameField = screen.getByLabelText("Project name");
    nameField.focus();
    fireEvent.keyDown(nameField, { key: "Escape" });
    expect(document.activeElement).not.toBe(nameField);
    expect(services.playback.stop).not.toHaveBeenCalled();
  });
});

describe("App — the cut tool is registry-owned and its chip is pinned (CF-15)", () => {
  afterEach(() => {
    resetPadKeys();
  });

  it("V selects and C cuts through the registry (the raw branch is gone)", () => {
    const services = mockServices();
    const { container } = renderWithContext(
      <App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />,
      { services },
    );
    // The house template auto-selects a drum track, which arms the pad keys;
    // this journey belongs to a non-drum (or un-armed) context.
    setPadKeysArmed(false);
    fireEvent.keyDown(window, { key: "c" });
    expect(container.querySelector(".statusbar-tool-chip")?.textContent).toBe("TOOL CUT (V = select)");
    fireEvent.keyDown(window, { key: "v" });
    expect(container.querySelector(".statusbar-tool-chip")).toBeNull();
  });

  it("NEGATIVE: Ctrl+C does not switch the tool (the matcher refuses modified chords)", () => {
    const services = mockServices();
    const { container } = renderWithContext(
      <App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />,
      { services },
    );
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    expect(container.querySelector(".statusbar-tool-chip")).toBeNull();
  });

  it("NEGATIVE: a drum pad BOUND to C keeps owning it while armed — the pad shadow survives the registry move", () => {
    const services = mockServices();
    const { container } = renderWithContext(
      <App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />,
      { services },
    );
    // The DEFAULT pad map does not own C (qwertyui/asdfghjk) — the shadow is
    // about a USER-BOUND pad, which the rebind surface allows.
    bindPadKey(0, "c");
    setPadKeysArmed(true);
    try {
      fireEvent.keyDown(window, { key: "c" });
      expect(container.querySelector(".statusbar-tool-chip")).toBeNull();
    } finally {
      setPadKeysArmed(false);
    }
  });

  it("THE PIN: the CUT chip survives a data-hint hover — it is no longer the hint fallback", () => {
    const services = mockServices();
    const { container } = renderWithContext(
      <App services={services} onOpenBrowser={() => {}} onReplaceServices={() => {}} />,
      { services },
    );
    setPadKeysArmed(false);
    fireEvent.keyDown(window, { key: "c" });
    const chip = container.querySelector(".statusbar-tool-chip");
    expect(chip).not.toBeNull();

    // Hover any [data-hint] control: the hint bar swaps its fallback for the
    // hovered control's name — the chip must NOT vanish with it.
    const hinted = document.createElement("div");
    hinted.setAttribute("data-hint", "Channel fader");
    hinted.setAttribute("data-hint-value", "0.90");
    document.body.appendChild(hinted);
    fireEvent.pointerOver(hinted);
    expect(container.querySelector(".statusbar-hint")?.textContent).toContain("Channel fader");
    expect(container.querySelector(".statusbar-tool-chip")?.textContent).toBe("TOOL CUT (V = select)");
    hinted.remove();
  });
});
