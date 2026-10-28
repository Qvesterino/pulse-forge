import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  PALETTE_COMMAND_SPECS,
  type PaletteCommandContext,
  type PaletteCommandSpec,
} from "../../src/commands/palette-registry";
import { buildPaletteActions, type PaletteDeps } from "../../src/ui/commandPalette";
import { PaletteOverlay } from "../../src/ui/PaletteOverlay";
import { renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { SelectionState } from "../../src/store/SelectionStore";
import { applyEssentialKit } from "../../src/commands/effectParams";
import { trackEffectsOf } from "../../src/commands/docOps";

/**
 * THE CURATED PALETTE COMMAND REGISTRY (HCP-05-01, HCP-05-02, HCP-02-01).
 *
 * The registry is a WHITELIST of the commands the keyboard layer has no room
 * for. Three rules hold it together, and this spec is their gate:
 *
 *   1. HONEST — an action that cannot run right now states WHY. The palette
 *      renders it disabled with that reason; it must never look runnable.
 *   2. NO NEW POWER — every spec builds a command the product already has.
 *      The spec adds no mutation, no audio path, no edit semantics.
 *   3. IT WORKS — a spec whose precondition passes must build a command, and
 *      that command must execute without throwing.
 */

const EMPTY_SELECTION: SelectionState = {
  trackIds: [],
  clipIds: [],
  noteSelections: [],
  stepSelection: null,
  timeRange: null,
};

function context(overrides: Partial<PaletteCommandContext> = {}): PaletteCommandContext {
  return {
    doc: createProjectFromTemplate("house"),
    selection: EMPTY_SELECTION,
    playheadTick: 0,
    ...overrides,
  };
}

/** A context where everything the preconditions ask for is present. */
function readyContext(): PaletteCommandContext {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((t) => t.kind === "instrument") ?? doc.tracks[0];
  return {
    doc,
    selection: { ...EMPTY_SELECTION, trackIds: track ? [track.id] : [] },
    playheadTick: 0,
  };
}

/**
 * A context whose selected track already carries an effect chain, so the
 * "bypass the last effect" action can actually run.
 */
function trackWithEffectsContext(): PaletteCommandContext {
  const base = createProjectFromTemplate("house");
  const track = base.tracks.find((t) => t.kind === "instrument") ?? base.tracks[0];
  if (!track) throw new Error("the house template has no track");
  const doc = applyEssentialKit(base, track.id).execute(base);
  return {
    doc,
    selection: { ...EMPTY_SELECTION, trackIds: [track.id] },
    playheadTick: 0,
  };
}

describe("the curated palette command registry", () => {
  it("every spec has a unique id, a label, a group and keywords", () => {
    const ids = new Set<string>();
    for (const spec of PALETTE_COMMAND_SPECS) {
      expect(spec.id.trim().length, spec.id).toBeGreaterThan(0);
      expect(spec.label.trim().length, spec.id).toBeGreaterThan(0);
      expect(spec.group.trim().length, spec.id).toBeGreaterThan(0);
      expect(spec.keywords.trim().length, spec.id).toBeGreaterThan(0);
      expect(ids.has(spec.id), `duplicate spec id ${spec.id}`).toBe(false);
      ids.add(spec.id);
    }
  });

  it("every precondition either passes or states a non-empty reason", () => {
    for (const spec of PALETTE_COMMAND_SPECS) {
      const reason = spec.precondition?.(context());
      if (reason !== undefined && reason !== null) {
        expect(reason.trim().length, `${spec.id} must explain itself`).toBeGreaterThan(0);
      }
    }
  });

  it("a spec whose precondition passes builds a command", () => {
    for (const spec of PALETTE_COMMAND_SPECS) {
      for (const ctx of [context(), readyContext()]) {
        const reason = spec.precondition?.(ctx);
        if (reason) continue;
        const command = spec.build(ctx);
        expect(command, `${spec.id} promised it could run but built nothing`).not.toBeNull();
      }
    }
  });

  it("every built command executes without throwing", () => {
    for (const spec of PALETTE_COMMAND_SPECS) {
      for (const ctx of [context(), readyContext()]) {
        const reason = spec.precondition?.(ctx);
        if (reason) continue;
        const command = spec.build(ctx);
        if (!command) continue;
        expect(() => command.execute(ctx.doc), `${spec.id} threw when executed`).not.toThrow();
      }
    }
  });

  it("no spec title collides with a shortcut title", () => {
    const actions = buildPaletteActions(deps());
    const titles = actions.map((action) => action.title);
    expect(new Set(titles).size, "two palette actions share a title").toBe(titles.length);
  });

  it("the palette ids are unique across shortcuts, registry and extras", () => {
    const actions = buildPaletteActions(deps());
    const ids = actions.map((action) => action.id);
    expect(new Set(ids).size, "two palette actions share an id").toBe(ids.length);
  });

  it("an action that cannot run carries its reason into the palette", () => {
    const actions = buildPaletteActions(
      deps({
        commandContext: () => context(),
      }),
    );
    // Nothing is selected in an empty context, so the track-scoped actions
    // must be unavailable AND must say why.
    const bypass = actions.find((action) => action.id === "cmd:fx.bypass");
    expect(bypass?.unavailableReason).toBeTruthy();
    expect(bypass?.unavailableReason).toMatch(/track/i);
  });
});

function deps(overrides: Partial<PaletteDeps> = {}): PaletteDeps {
  return {
    runShortcut: () => {},
    snapshotNow: () => {},
    openGallery: () => {},
    toggleHistoryPanel: () => {},
    toggleDiagnostics: () => {},
    ...overrides,
  };
}

describe("the registry spec shape", () => {
  it("exposes a lookup by id", () => {
    const spec: PaletteCommandSpec | undefined = PALETTE_COMMAND_SPECS.find((s) => s.id === "pattern.quantizeGrid");
    expect(spec).toBeDefined();
  });
});

/**
 * THE HONESTY GATE — what the USER sees.
 *
 * The registry can be perfectly correct on paper and still lie in the UI: a
 * row that looks runnable but silently does nothing is worse than a row that
 * is not there. These tests render the real overlay and check the three
 * promises the palette makes:
 *
 *   - an action that cannot run is marked disabled AND states why;
 *   - pressing Enter on it does nothing (it does not close the palette, and it
 *     does not run a command);
 *   - an action that CAN run is not marked disabled, and it runs.
 */
describe("the palette overlay renders the registry honestly", () => {
  const BYPASS_TITLE = "Bypass the selected track's last effect";

  function openPalette(overrides: Partial<PaletteDeps> = {}) {
    const onClose = vi.fn();
    renderWithContext(<PaletteOverlay open deps={deps(overrides)} onClose={onClose} />);
    return { onClose };
  }

  function row(title: string): HTMLButtonElement {
    const element = screen.getByText(title).closest("button");
    expect(element, `no palette row for "${title}"`).not.toBeNull();
    return element as HTMLButtonElement;
  }

  it("marks an unavailable action disabled and shows the reason", () => {
    openPalette({ commandContext: () => context() });
    fireEvent.change(screen.getByLabelText("Search commands"), { target: { value: "bypass" } });

    const button = row(BYPASS_TITLE);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.className).toContain("unavailable");
    // The reason is VISIBLE, not just a tooltip — a greyed-out row that
    // explains itself instead of a row that looks broken.
    expect(screen.getByText("Select a track first")).toBeInTheDocument();
  });

  it("refuses to run an unavailable action on click", () => {
    const runCommand = vi.fn();
    openPalette({ commandContext: () => context(), runCommand });
    fireEvent.change(screen.getByLabelText("Search commands"), { target: { value: "bypass" } });

    fireEvent.click(row(BYPASS_TITLE));
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refuses to run an unavailable action on Enter", () => {
    const runCommand = vi.fn();
    const { onClose } = openPalette({ commandContext: () => context(), runCommand });
    const input = screen.getByLabelText("Search commands");
    fireEvent.change(input, { target: { value: "bypass" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(runCommand).not.toHaveBeenCalled();
    // The palette stays open: Enter on a dead row is a no-op, not a dismissal.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("runs an available action when it is clicked", () => {
    const runCommand = vi.fn();
    openPalette({ commandContext: () => context(), runCommand });
    fireEvent.change(screen.getByLabelText("Search commands"), { target: { value: "marker" } });

    const button = row("Add a marker at the playhead");
    expect(button.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(button);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toMatchObject({ id: "marker.add" });
  });

  it("the same action becomes available once its precondition is met", () => {
    const runCommand = vi.fn();
    const ctx = trackWithEffectsContext();
    // Guard: the fixture must really carry an effect chain, otherwise this
    // test would pass for the wrong reason.
    const trackId = ctx.selection.trackIds[0];
    expect(trackEffectsOf(ctx.doc, trackId).length).toBeGreaterThan(0);

    openPalette({ commandContext: () => ctx, runCommand });
    fireEvent.change(screen.getByLabelText("Search commands"), { target: { value: "bypass" } });

    const button = row(BYPASS_TITLE);
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText("Select a track first")).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toMatchObject({ id: "fx.bypass" });
  });
});
