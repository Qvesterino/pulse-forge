import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TextPromptDialog } from "../../src/ui/TextPromptDialog";

/**
 * The shared replacement for `window.prompt` on the code-install paths.
 * Contract under test: submit-once with trimmed text, Escape/backdrop
 * cancel, empty submit refused, error slot rendered, draft re-seeded per
 * open (a stale code must not resurface on the next install).
 */

function setup(overrides: Partial<React.ComponentProps<typeof TextPromptDialog>> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <TextPromptDialog
      open
      title="INSTALL KIT"
      label="Paste a KYX kit code (PFKIT1:…)"
      confirmLabel="INSTALL"
      onSubmit={onSubmit}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onSubmit, onClose, ...utils };
}

describe("TextPromptDialog", () => {
  it("submits the typed code", () => {
    const { onSubmit } = setup();
    fireEvent.change(screen.getByLabelText("Paste a KYX kit code (PFKIT1:…)"), {
      target: { value: "PFKIT1:abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "INSTALL" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("PFKIT1:abc");
  });

  it("trims whitespace from a pasted code", () => {
    const { onSubmit } = setup();
    fireEvent.change(screen.getByLabelText("Paste a KYX kit code (PFKIT1:…)"), {
      target: { value: "  PFKIT1:abc  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "INSTALL" }));
    expect(onSubmit).toHaveBeenCalledWith("PFKIT1:abc");
  });

  it("refuses an empty submit — an empty code can never be a success", () => {
    const { onSubmit, onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "INSTALL" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape cancels without submitting", () => {
    const { onSubmit, onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter submits a single-line field but is inert in a multiline field", () => {
    const single = setup();
    fireEvent.change(screen.getByLabelText("Paste a KYX kit code (PFKIT1:…)"), {
      target: { value: "PFKIT1:one" },
    });
    const input = screen.getByLabelText("Paste a KYX kit code (PFKIT1:…)");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(single.onSubmit).toHaveBeenCalledWith("PFKIT1:one");
    single.unmount();

    const multi = setup({ multiline: true });
    fireEvent.change(screen.getByLabelText("Paste a KYX kit code (PFKIT1:…)"), {
      target: { value: "PFPACK1:long" },
    });
    fireEvent.keyDown(screen.getByLabelText("Paste a KYX kit code (PFKIT1:…)"), { key: "Enter" });
    expect(multi.onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Paste a KYX kit code (PFKIT1:…)"), {
      key: "Enter",
      ctrlKey: true,
    });
    expect(multi.onSubmit).toHaveBeenCalledWith("PFPACK1:long");
  });

  it("renders a caller-owned error next to the field", () => {
    setup({ error: "Invalid kit code" });
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid kit code");
  });

  it("re-seeds the draft each time it opens", () => {
    const { rerender, onSubmit } = setup({ initialValue: "SEED-1" });
    fireEvent.change(screen.getByLabelText("Paste a KYX kit code (PFKIT1:…)"), {
      target: { value: "USER-EDIT" },
    });
    rerender(
      <TextPromptDialog
        open={false}
        title="INSTALL KIT"
        label="Paste a KYX kit code (PFKIT1:…)"
        initialValue="SEED-1"
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    rerender(
      <TextPromptDialog
        open
        title="INSTALL KIT"
        label="Paste a KYX kit code (PFKIT1:…)"
        initialValue="SEED-1"
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Paste a KYX kit code (PFKIT1:…)")).toHaveValue("SEED-1");
  });
});
