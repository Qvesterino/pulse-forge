import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DragNumber, Slider, parseTypedControlValue } from "../../src/ui/controls";

/**
 * Typed-value entry on Slider and DragNumber (right-click → "Type value…",
 * or Enter on a DragNumber).
 *
 * The seam these specs enter is the real one: a context-menu event on the
 * control, a click on the actual menu item, then keystrokes and a blur in the
 * real `<input>`. A test of `parseTypedControlValue` alone would only prove the
 * pure function is right; the commit path that calls it is where the defect
 * actually lived.
 *
 * THE DEFECT (fixed in this commit): both controls parsed the draft with
 * `Number(draft.replace(",", "."))` and guarded only with `Number.isFinite`.
 * `Number("")` is `0`, so a field the user cleared and then abandoned (Tab or
 * Escape-away) parsed as a legitimate zero and was clamped into range — writing
 * the control's MINIMUM into the document. Measured before the fix:
 *   Slider  (min 0)   empty + blur → onCommit(0)
 *   Slider  (min 0)   "   "  + blur → onCommit(0)
 *   DragNum (min 40)  empty + blur → onCommit(40)
 *
 * Per §7 of the audit, empty/whitespace input must be REJECTED, and per §12 a
 * rejected edit must not push a history entry. Most of these specs are
 * negative assertions for that reason.
 */
describe("parseTypedControlValue", () => {
  it("rejects an empty draft (does NOT read it as 0)", () => {
    // The regression itself: Number("") === 0 passes isFinite, so an unguarded
    // parser turned "user cleared the field" into "user typed the minimum".
    expect(parseTypedControlValue("", 0, 1)).toBeNull();
  });

  it("rejects a whitespace-only draft", () => {
    expect(parseTypedControlValue("   ", 0, 1)).toBeNull();
    expect(parseTypedControlValue("\t\n", 0, 1)).toBeNull();
  });

  it("rejects non-numeric and NaN-producing drafts", () => {
    expect(parseTypedControlValue("abc", 0, 1)).toBeNull();
    expect(parseTypedControlValue("12abc", 0, 1)).toBeNull();
    expect(parseTypedControlValue("1.2.3", 0, 1)).toBeNull();
    expect(parseTypedControlValue("-", 0, 1)).toBeNull();
  });

  it("rejects Infinity/NaN-producing overflow drafts", () => {
    expect(parseTypedControlValue("1e999", 0, 1)).toBeNull();
    expect(parseTypedControlValue("Infinity", 0, 1)).toBeNull();
    expect(parseTypedControlValue("NaN", 0, 1)).toBeNull();
  });

  it("parses a real zero as zero, not as a rejection", () => {
    // The guard must not swallow a legitimate zero.
    expect(parseTypedControlValue("0", 0, 1)).toBe(0);
    expect(parseTypedControlValue(" 0 ", 0, 1)).toBe(0);
  });

  it("clamps above-max and below-min into the domain", () => {
    expect(parseTypedControlValue("99", 0, 1)).toBe(1);
    expect(parseTypedControlValue("-5", -1, 1)).toBe(-1);
  });

  it("accepts a comma decimal separator", () => {
    expect(parseTypedControlValue("0,25", 0, 1)).toBe(0.25);
  });
});

describe("Slider typed value — validation", () => {
  const renderSlider = (onCommit: ReturnType<typeof vi.fn>) =>
    render(<Slider label="Gain" value={0.5} min={0} max={1} defaultValue={0.5} onCommit={onCommit} />);

  it("commits NOTHING when the field is cleared and blurred", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderSlider(onCommit);
    fireEvent.contextMenu(screen.getByRole("slider", { name: "Gain" }));
    await user.click(screen.getByRole("menuitem", { name: /Type value/ }));
    await user.clear(screen.getByLabelText("Gain value"));
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits NOTHING for a whitespace-only draft", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderSlider(onCommit);
    fireEvent.contextMenu(screen.getByRole("slider", { name: "Gain" }));
    await user.click(screen.getByRole("menuitem", { name: /Type value/ }));
    const input = screen.getByLabelText("Gain value");
    await user.clear(input);
    await user.type(input, "   ");
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits NOTHING for a non-numeric draft", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderSlider(onCommit);
    fireEvent.contextMenu(screen.getByRole("slider", { name: "Gain" }));
    await user.click(screen.getByRole("menuitem", { name: /Type value/ }));
    const input = screen.getByLabelText("Gain value");
    await user.clear(input);
    await user.type(input, "abc");
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("still commits a valid value", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderSlider(onCommit);
    fireEvent.contextMenu(screen.getByRole("slider", { name: "Gain" }));
    await user.click(screen.getByRole("menuitem", { name: /Type value/ }));
    const input = screen.getByLabelText("Gain value");
    await user.clear(input);
    await user.type(input, "0.8");
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith(0.8);
  });

  it("clamps a typed value above max into the domain", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderSlider(onCommit);
    fireEvent.contextMenu(screen.getByRole("slider", { name: "Gain" }));
    await user.click(screen.getByRole("menuitem", { name: /Type value/ }));
    const input = screen.getByLabelText("Gain value");
    await user.clear(input);
    await user.type(input, "99");
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith(1);
  });

  it("keeps a log-tapered typed value inside the Hz domain", async () => {
    // A log taper changes the GESTURE domain only; typed entry speaks plain
    // values and must not be re-tapered or run through the ratio mapping.
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <Slider label="Cutoff" value={1000} min={20} max={20000} defaultValue={1000} taper="log" onCommit={onCommit} />,
    );
    fireEvent.contextMenu(screen.getByRole("slider", { name: "Cutoff" }));
    await user.click(screen.getByRole("menuitem", { name: /Type value/ }));
    const input = screen.getByLabelText("Cutoff value");
    await user.clear(input);
    await user.type(input, "5000");
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith(5000);
  });

  it("commits NOTHING when the edit is abandoned with Escape", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderSlider(onCommit);
    fireEvent.contextMenu(screen.getByRole("slider", { name: "Gain" }));
    await user.click(screen.getByRole("menuitem", { name: /Type value/ }));
    const input = screen.getByLabelText("Gain value");
    await user.clear(input);
    await user.type(input, "0.9");
    await user.keyboard("{Escape}");
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("DragNumber typed value — validation", () => {
  const renderDN = (onCommit: ReturnType<typeof vi.fn>, props = {}) =>
    render(<DragNumber label="BPM" value={120} min={40} max={220} defaultValue={120} onCommit={onCommit} {...props} />);

  it("commits NOTHING when the field is cleared and blurred (was: minimum)", async () => {
    // Measured before the fix: onCommit(40) — the control's min — from an
    // empty field. A 40 BPM project is an unplayable tempo, so this was HIGH.
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderDN(onCommit);
    fireEvent.contextMenu(screen.getByRole("spinbutton", { name: "BPM" }));
    await user.click(screen.getByRole("menuitem", { name: /Type value/ }));
    await user.clear(screen.getByLabelText("BPM value"));
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits NOTHING for a non-numeric draft", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderDN(onCommit);
    fireEvent.contextMenu(screen.getByRole("spinbutton", { name: "BPM" }));
    await user.click(screen.getByRole("menuitem", { name: /Type value/ }));
    const input = screen.getByLabelText("BPM value");
    await user.clear(input);
    await user.type(input, "abc");
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("still commits a valid value", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderDN(onCommit);
    fireEvent.contextMenu(screen.getByRole("spinbutton", { name: "BPM" }));
    await user.click(screen.getByRole("menuitem", { name: /Type value/ }));
    const input = screen.getByLabelText("BPM value");
    await user.clear(input);
    await user.type(input, "128");
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith(128);
  });

  it("clamps a typed value below min into the domain", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<DragNumber label="Pan" value={0} min={-1} max={1} defaultValue={0} onCommit={onCommit} />);
    fireEvent.contextMenu(screen.getByRole("spinbutton", { name: "Pan" }));
    await user.click(screen.getByRole("menuitem", { name: /Type value/ }));
    const input = screen.getByLabelText("Pan value");
    await user.clear(input);
    await user.type(input, "-5");
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith(-1);
  });

  it("keeps sub-range decimal precision on typed entry (0..0.5)", async () => {
    // The HUMANIZE-style control: a sub-unit range where a 1-decimal parser
    // would snap 0.234 to 0.2. Typed entry must honour the same resolution the
    // drag derives from the range.
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<DragNumber label="HUM" value={0.1} min={0} max={0.5} defaultValue={0} onCommit={onCommit} />);
    fireEvent.contextMenu(screen.getByRole("spinbutton", { name: "HUM" }));
    await user.click(screen.getByRole("menuitem", { name: /Type value/ }));
    const input = screen.getByLabelText("HUM value");
    await user.clear(input);
    await user.type(input, "0.234");
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith(0.234);
  });
});
