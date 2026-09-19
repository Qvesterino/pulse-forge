import { describe, expect, it } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { renderWithContext } from "../helpers";

describe("IntentPanel", () => {
  it("renders the textarea and disabled GENERATE button initially", () => {
    renderWithContext(<IntentPanel />);
    const textarea = screen.getByLabelText(/Intent description/i);
    expect(textarea).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /GENERATE/i }) as HTMLButtonElement;
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it("typing into the textarea enables the GENERATE button", () => {
    renderWithContext(<IntentPanel />);
    const textarea = screen.getByLabelText(/Intent description/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "dark techno at 140" } });
    const btn = screen.getByRole("button", { name: /GENERATE/i });
    expect(btn).not.toBeDisabled();
  });

  it("typing a recognized intent shows detected keywords", () => {
    renderWithContext(<IntentPanel />);
    const textarea = screen.getByLabelText(/Intent description/i);
    fireEvent.change(textarea, { target: { value: "dark house at 124 bpm" } });
    const detected = screen.getByLabelText(/Detected keywords/i);
    expect(detected.textContent).not.toBeNull();
    expect(detected.textContent!.length).toBeGreaterThan(0);
  });

  it("renders the INTENT header", () => {
    renderWithContext(<IntentPanel />);
    expect(screen.getByText(/INTENT/i)).toBeInTheDocument();
  });
});
