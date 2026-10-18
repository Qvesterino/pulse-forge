import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FxEqPanel } from "../../src/ui/FxEqPanel";
import { mockServices, renderWithContext } from "../helpers";

/**
 * PRISM crossover numeric entry (`FxEqPanel`).
 *
 * The seam is the real field: context = the panel, act = keyboard events in
 * the rendered `<input>`, assert = what reaches `onParam` (the document write).
 *
 * MEASURED BEFORE THE FIX (throwaway probe, not asserted anywhere else):
 *   clear the field          → onParam("crossoverFreq2", 80)   ← the 80 Hz floor
 *   type "1200"              → 4 onParam calls, all 360
 *   type "800"                → 3 onParam calls, all 360
 *   DOM value after typing   → "120"  (snapped back; the caret fought the
 *                                        CONTROLLED value mid-typing)
 *
 * Two distinct defects:
 *  1. `Number("")` is `0` and passed `Number.isFinite`, so an emptied field
 *     was clamped into the domain and written as the 80 Hz floor.
 *  2. The field was CONTROLLED by the stored value while committing on every
 *     `onChange`. Each keystroke wrote the doc, the store re-rendered, and the
 *     input snapped back to the clamped value — so typing a multi-digit
 *     frequency produced N undo entries for one gesture and the digits the
 *     user actually typed never survived to be committed.
 *
 * That is the exact defect class `NumericDraftInput` was introduced for
 * (audit #6, `docs/UI-FUNCTIONAL-AUDIT-2026-09-30.md`); this field had never
 * been migrated onto it.
 *
 * NOTE ON THE EXPECTED 360: the neighbours in the default 6-band document are
 * 120 / 400 / …, and `clampSplit` enforces the 40 Hz minimum gap, so 1200 is
 * legitimately clamped to 360. The assertion is about HOW MANY writes happen
 * and WHICH value, not about defeating the clamp.
 */
const baseProps = {
  trackId: "track-1",
  fxId: "fx-1",
  params: { bandCount: 6 },
  onApplyPreset: vi.fn(),
};

const firstSplit = () => screen.getByLabelText("Crossover 2 frequency") as HTMLInputElement;

describe("PRISM crossover numeric entry", () => {
  it("writes NOTHING when the field is cleared and abandoned", async () => {
    // Was: onParam("crossoverFreq2", 80) — the 80 Hz floor from Number("") === 0.
    const user = userEvent.setup();
    const onParam = vi.fn();
    renderWithContext(<FxEqPanel {...baseProps} onParam={onParam} />, { services: mockServices() });
    await user.clear(firstSplit());
    await user.tab();
    expect(onParam).not.toHaveBeenCalled();
  });

  it("writes NOTHING when a cleared field is abandoned with Escape", async () => {
    const user = userEvent.setup();
    const onParam = vi.fn();
    renderWithContext(<FxEqPanel {...baseProps} onParam={onParam} />, { services: mockServices() });
    await user.clear(firstSplit());
    await user.keyboard("{Escape}");
    expect(onParam).not.toHaveBeenCalled();
  });

  it("commits a typed multi-digit value EXACTLY ONCE", async () => {
    // The core assertion: one gesture = one document write = one undo entry.
    const user = userEvent.setup();
    const onParam = vi.fn();
    renderWithContext(<FxEqPanel {...baseProps} onParam={onParam} />, { services: mockServices() });
    const input = firstSplit();
    await user.clear(input);
    onParam.mockClear();
    await user.type(input, "1200");
    // Still nothing mid-typing — the draft is staged locally.
    expect(onParam).not.toHaveBeenCalled();
    await user.tab();
    expect(onParam).toHaveBeenCalledTimes(1);
    expect(onParam.mock.calls[0][0]).toBe("crossoverFreq2");
  });

  it("keeps the typed digits visible while typing (no snap-back)", async () => {
    // Was: the CONTROLLED value snapped the field back to the clamped store
    // value mid-typing, so the user could never finish a 4-digit frequency.
    const user = userEvent.setup();
    renderWithContext(<FxEqPanel {...baseProps} onParam={vi.fn()} />, { services: mockServices() });
    const input = firstSplit();
    await user.clear(input);
    await user.type(input, "800");
    expect((screen.getByLabelText("Crossover 2 frequency") as HTMLInputElement).value).toBe("800");
  });

  it("commits once on Enter without needing a blur", async () => {
    const user = userEvent.setup();
    const onParam = vi.fn();
    renderWithContext(<FxEqPanel {...baseProps} onParam={onParam} />, { services: mockServices() });
    const input = firstSplit();
    await user.clear(input);
    onParam.mockClear();
    await user.type(input, "800{Enter}");
    expect(onParam).toHaveBeenCalledTimes(1);
  });

  it("still enforces the 40 Hz neighbour gap on a typed value", async () => {
    // Guards against the opposite regression: the draft-staging fix must not
    // have quietly removed the clamp the DSP core relies on.
    const user = userEvent.setup();
    const onParam = vi.fn();
    renderWithContext(<FxEqPanel {...baseProps} onParam={onParam} />, { services: mockServices() });
    const input = firstSplit();
    await user.clear(input);
    onParam.mockClear();
    await user.type(input, "1200");
    await user.tab();
    // Default neighbours are 120 / 400, so split 2 is capped at 400 - 40 = 360.
    expect(onParam.mock.calls[0][1]).toBe(360);
  });

  it("re-exposes the field with its numeric contract (min/max/step)", async () => {
    renderWithContext(<FxEqPanel {...baseProps} onParam={vi.fn()} />, { services: mockServices() });
    const input = firstSplit();
    expect(input).toHaveAttribute("type", "number");
    expect(input).toHaveAttribute("step", "10");
    expect(Number(input.getAttribute("min"))).toBeGreaterThanOrEqual(80);
  });
});
