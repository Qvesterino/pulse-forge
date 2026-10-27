import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "@testing-library/react";
import { FxAddPopover } from "../../src/ui/FxAddPopover";
import {
  CORE_EFFECT_ORDER,
  EFFECT_DEFS,
  FLAGSHIP_EFFECT_ORDER,
  ADDITIONAL_EFFECT_GROUPS,
} from "../../src/effects/registry";
import type { EffectType } from "../../src/project-model/types";

/**
 * Goal-first FX add popover (FX-ADD-REWORK-ROADMAP Wave A): the door speaks
 * goals — text search over names/blurbs, production-concept goal row, and a
 * device grid that adds through the parent's command.
 */

const DEVICES: EffectType[] = [
  ...CORE_EFFECT_ORDER,
  ...FLAGSHIP_EFFECT_ORDER,
  ...ADDITIONAL_EFFECT_GROUPS.flatMap((group) => group.types),
];

const renderPopover = (overrides?: Partial<Parameters<typeof FxAddPopover>[0]>) => {
  const onPick = vi.fn();
  const onGoal = vi.fn();
  const onClose = vi.fn();
  render(
    <FxAddPopover
      trackLabel="808 Sub"
      devices={DEVICES}
      onPick={onPick}
      onGoal={onGoal}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onPick, onGoal, onClose };
};

describe("FxAddPopover", () => {
  it("renders the device grid with names and blurbs", () => {
    renderPopover();
    expect(screen.getByText("Vinyl Suite")).toBeDefined();
    expect(screen.getByText(/Age and dust/)).toBeDefined();
    expect(screen.getByText(/Resonant sweep/)).toBeDefined(); // svFilter blurb
  });

  it("goal tiles filter the grid by registry category", () => {
    renderPopover();
    fireEvent.click(screen.getByText("SPACE"));
    expect(screen.getByText("Reverb")).toBeDefined();
    expect(screen.getByText(/Echoes the phrase/)).toBeDefined();
    // A movement device is filtered out.
    expect(screen.queryByText("Beat Mangler")).toBeNull();
  });

  it("text search filters by device name", () => {
    renderPopover();
    fireEvent.change(screen.getByLabelText(/Describe what you want/i), { target: { value: "vinyl" } });
    expect(screen.getByText("Vinyl Suite")).toBeDefined();
    expect(screen.queryByText("Beat Mangler")).toBeNull();
  });

  it("text search matches blurbs too", () => {
    renderPopover();
    fireEvent.change(screen.getByLabelText(/Describe what you want/i), { target: { value: "808 depth" } });
    // pitchShift's blurb mentions "808 depth"
    expect(screen.getByText("Pitch Shift")).toBeDefined();
  });

  it("a production concept in the text offers a goal row", () => {
    renderPopover();
    const input = screen.getByLabelText(/Describe what you want/i);
    fireEvent.change(input, { target: { value: "make it wobbly" } });
    const goal = screen.getByText(/wobbly — apply to this track/i);
    fireEvent.click(goal);
    // The goal row hands the TEXT to the parent (parent parses + scopes).
    // Re-parse here to assert the popover surfaced the right concept.
    expect(screen.getAllByText(/wobbly/).length).toBeGreaterThan(0);
  });

  it("clicking a device calls onPick with its type and closes", () => {
    const { onPick, onClose } = renderPopover();
    fireEvent.click(screen.getByText("Vinyl Suite"));
    expect(onPick).toHaveBeenCalledWith("vinyl");
    // Closing is the parent's decision after it runs the command.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape closes via onClose", () => {
    const { onClose } = renderPopover();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows preset start counts on devices that have them", () => {
    renderPopover();
    // vinyl has 6 presets in the catalog
    expect(screen.getAllByText(/6 starts/).length).toBeGreaterThan(0);
  });

  it("every offered device exists in the registry", () => {
    for (const type of DEVICES) {
      expect(EFFECT_DEFS[type], `${type} in registry`).toBeDefined();
    }
  });

  it("finds a device by its registry id, not only by its display name", () => {
    // The grid shows "PRISM", but the id the MCP tools and the intent parser
    // use is "fxeq" — a user (or an agent) who knows the plugin by that id
    // found nothing. The search vocabulary is now the code's own vocabulary.
    renderPopover();
    fireEvent.change(screen.getByLabelText(/Describe what you want/i), { target: { value: "fxeq" } });
    expect(screen.getByText("PRISM")).toBeDefined();
  });

  it("marks the flagship suites — the grid showed all 57 devices as equal tiles", () => {
    // PRISM, VLYX, DRIFT, RIFT, MORPH and REZONANS each carry a vendored DSP
    // core and their own editor. The tier existed in the registry but reached
    // the user through nothing but a word in some blurbs.
    renderPopover();
    expect(screen.getByText("PRISM")).toBeDefined();
    const suite = screen.getByText("PRISM").closest(".fx-add-device");
    expect(suite?.querySelector(".fx-add-suite")?.textContent).toBe("SUITE");
    // A plain utility device is NOT marked.
    const plain = screen.getByText("Vinyl Suite").closest(".fx-add-device");
    expect(plain?.querySelector(".fx-add-suite")).toBeNull();
  });

  it("searches the tier word", () => {
    renderPopover();
    // "flagship" is the tier word and matches nothing else — "Vinyl Suite"
    // would match "suite", so the tier keyword is the one that isolates it.
    fireEvent.change(screen.getByLabelText(/Describe what you want/i), { target: { value: "flagship" } });
    expect(screen.getByText("PRISM")).toBeDefined();
    expect(screen.getByText("VLYX")).toBeDefined();
    expect(screen.queryByText("Vinyl Suite")).toBeNull();
  });
});
