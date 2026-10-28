import { describe, expect, it } from "vitest";
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
