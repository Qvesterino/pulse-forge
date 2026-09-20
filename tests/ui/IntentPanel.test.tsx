import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
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

describe("IntentPanel — A3 share moment", () => {
  async function generateAndUse() {
    renderWithContext(<IntentPanel />);
    const textarea = screen.getByLabelText(/Intent description/i);
    fireEvent.change(textarea, { target: { value: "dark trap 140" } });
    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
    // Generation is real (deterministic local provider) — wait for candidates.
    const useButtons = await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });
    fireEvent.click(useButtons[0]);
    await waitFor(() => expect(screen.getByText(/Yours\. Share it:/i)).toBeInTheDocument());
  }

  it("reveals Publish / Copy-link CTA after USE", async () => {
    await generateAndUse();
    expect(screen.getByRole("button", { name: /PUBLISH TO GALLERY/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /COPY LINK/i })).toBeInTheDocument();
    // Capability degradation: jsdom has no MediaRecorder → the VIDEO button
    // must be ABSENT, not broken (same guard the ExportPanel uses).
    expect(screen.queryByRole("button", { name: /^VIDEO$/ })).toBeNull();
  }, 40000);

  it("hides the share row when a new generation starts", async () => {
    await generateAndUse();
    const textarea = screen.getByLabelText(/Intent description/i);
    fireEvent.change(textarea, { target: { value: "hard techno 145" } });
    fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
    expect(screen.queryByText(/Yours\. Share it:/i)).toBeNull();
  }, 40000);

  it("copy link falls back to a manual dialog and reports it honestly when clipboard is unavailable", async () => {
    await generateAndUse();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    fireEvent.click(screen.getByRole("button", { name: /COPY LINK/i }));
    await waitFor(() => expect(screen.getByText(/Share link shown/i)).toBeInTheDocument());
    expect(screen.queryByText(/link copied/i)).toBeNull();
    expect(promptSpy).toHaveBeenCalled();
  }, 40000);
});
