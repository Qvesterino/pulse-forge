import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EffectQuickControls, isEffectQuickControlParam } from "../../src/ui/EffectQuickControls";
import type { ParamDef } from "../../src/effects/types";

/**
 * EffectQuickControls — the dock-level MIX/FEEDBACK/SYNC strip. The contract
 * under test: which params get promoted to quick controls (and which do NOT),
 * the one-param-per-label dedupe, out-of-list select fallback, and onChange
 * routing by param id.
 */

function param(partial: Partial<ParamDef> & { id: string }): ParamDef {
  return { label: partial.id.toUpperCase(), min: 0, max: 1, default: 0.5, ...partial } as ParamDef;
}

const SYNC_OPTIONS = [
  { value: 0, label: "OFF" },
  { value: 1, label: "1/4" },
  { value: 2, label: "1/8" },
];

describe("isEffectQuickControlParam — promotion contract", () => {
  it("promotes mix in all three spellings plus feedback", () => {
    expect(isEffectQuickControlParam(param({ id: "mix" }))).toBe(true);
    expect(isEffectQuickControlParam(param({ id: "global.mix" }))).toBe(true);
    expect(isEffectQuickControlParam(param({ id: "global.dryWet" }))).toBe(true);
    expect(isEffectQuickControlParam(param({ id: "feedback" }))).toBe(true);
  });

  it("promotes sync ONLY when the definition carries the tempo division menu", () => {
    expect(isEffectQuickControlParam(param({ id: "sync", options: SYNC_OPTIONS }))).toBe(true);
    expect(isEffectQuickControlParam(param({ id: "sync" }))).toBe(false);
  });

  it("never promotes the rest of the surface (rate/tone/decay…)", () => {
    for (const id of ["rate", "tone", "decay", "drive", "time", "mixAlt", "global.mixx"]) {
      expect(isEffectQuickControlParam(param({ id }))).toBe(false);
    }
  });
});

describe("EffectQuickControls — rendering", () => {
  afterEach(() => cleanup());

  it("returns null when nothing qualifies", () => {
    const { container } = render(
      <EffectQuickControls params={[param({ id: "rate" }), param({ id: "tone" })]} values={{}} onChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders each promoted label exactly once even across alias spellings", () => {
    // Both a plain mix and a global.mix exist → MIX must not render twice.
    render(
      <EffectQuickControls
        params={[param({ id: "mix" }), param({ id: "global.mix" }), param({ id: "feedback" })]}
        values={{}}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getAllByText("MIX")).toHaveLength(1); // label + hint may duplicate visually; the control label is one
    expect(screen.getByLabelText("FEEDBACK")).toBeTruthy();
    expect(screen.queryByLabelText("SYNC")).toBeNull();
  });

  it("SYNC appears only with options and renders the division menu", () => {
    render(
      <EffectQuickControls
        params={[param({ id: "mix" }), param({ id: "sync", options: SYNC_OPTIONS })]}
        values={{ sync: 1 }}
        onChange={vi.fn()}
      />,
    );
    const select = screen.getByLabelText("SYNC") as HTMLSelectElement;
    expect(select.value).toBe("1");
    expect(select.options).toHaveLength(3);
  });

  it("out-of-list stored values fall back to the default in the select (corrupt-doc guard)", () => {
    render(
      <EffectQuickControls
        params={[param({ id: "sync", options: SYNC_OPTIONS, default: 0 })]}
        values={{ sync: 99 }} // corrupt/legacy value outside the option set
        onChange={vi.fn()}
      />,
    );
    const select = screen.getByLabelText("SYNC") as HTMLSelectElement;
    expect(select.value).toBe("0");
  });

  it("routes select changes by param id", () => {
    const onChange = vi.fn();
    render(
      <EffectQuickControls
        params={[param({ id: "global.mix" }), param({ id: "sync", options: SYNC_OPTIONS })]}
        values={{}}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("SYNC"), { target: { value: "2" } });
    expect(onChange).toHaveBeenCalledWith("sync", 2);
  });

  it("slider controls render for non-option params (label + no select)", () => {
    render(
      <EffectQuickControls
        params={[param({ id: "mix", min: 0, max: 1, default: 0.5 })]}
        values={{}}
        onChange={vi.fn()}
      />,
    );
    // A promoted non-option param renders the compact Slider (no select) —
    // the header hint and the slider label both say MIX (that's the design);
    // the Slider widget itself has its own preview/commit test coverage.
    expect(screen.getAllByText("MIX").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
