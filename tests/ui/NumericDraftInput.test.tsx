import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { NumericDraftInput } from "../../src/ui/NumericDraftInput";

/**
 * The per-keystroke commit contract (audit #6): typing "85" must produce ONE
 * commit, not one for "8" and one for "85" — otherwise Ctrl+Z snaps the field
 * back a character. The component stages keystrokes in a local draft and
 * commits on blur/Enter; Escape abandons the draft.
 */

function Harness({ onCommit, initial = 0.1 }: { onCommit: (v: number) => void; initial?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <NumericDraftInput
      value={value}
      format={(v) => v.toFixed(3)}
      onCommit={(v) => {
        onCommit(v);
        setValue(v);
      }}
      aria-label="Test value"
    />
  );
}

describe("NumericDraftInput", () => {
  it("commits ONCE on blur, not once per keystroke", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const input = screen.getByLabelText("Test value");
    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.change(input, { target: { value: "85" } });
    expect(onCommit, "typing alone must not write").not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(85);
  });

  it("commits on Enter", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const input = screen.getByLabelText("Test value");
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(42);
  });

  it("Escape abandons the draft and restores the stored display value", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} initial={0.1} />);
    const input = screen.getByLabelText("Test value") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("0.100");
  });

  it("a cleared field is a cancel, not a write of 0", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const input = screen.getByLabelText("Test value");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores non-finite text", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const input = screen.getByLabelText("Test value");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("accepts a decimal value like 1.5", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const input = screen.getByLabelText("Test value");
    fireEvent.change(input, { target: { value: "1.5" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(1.5);
  });

  it("Enter with no edits commits the displayed value idempotently", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} initial={0.25} />);
    const input = screen.getByLabelText("Test value");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(0.25);
  });
});
