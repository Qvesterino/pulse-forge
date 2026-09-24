import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BriefContractSummary } from "../../src/ui/BriefContractSummary";
import { compileBriefContract, type BriefContract } from "../../src/intent/brief-contract";
import { parseIntentText } from "../../src/intent/text-parser";
import { producerSessionState, resetProducerSession, recordDecision } from "../../src/intent/producer-session";
import type { IntentInput } from "../../src/intent/types";

/**
 * Fáza 1 UI contract: the "TOTO SOM POCHOPIL" box renders the compiled
 * sections, offers one-click fixes for session suggestions, and lets the
 * user edit the exact hard facts (BPM/bars) plus un-protect preserved
 * roles — without rewriting the prompt.
 */

function renderBox(text: string, fixes: IntentInput = {}, session: Record<string, string> = {}) {
  const onPatch = vi.fn();
  resetProducerSession();
  for (const [kind, value] of Object.entries(session) as [string, string][])
    recordDecision(kind as never, value, "test");
  const contract: BriefContract = compileBriefContract(parseIntentText(text), { session: producerSessionState() });
  const input: IntentInput = { ...parseIntentText(text).input, ...fixes };
  render(<BriefContractSummary contract={contract} input={input} fixes={fixes} onPatch={onPatch} />);
  return { onPatch };
}

describe("BriefContractSummary", () => {
  it("renders the five sections for a full brief", () => {
    renderBox("142 bpm, temný trap, bez ďalších bicích; nechaj môj bass a akordy, 8 taktov");
    expect(screen.getByText("TOTO SOM POCHOPIL")).toBeTruthy();
    expect(screen.getByText("POVINNÉ")).toBeTruthy();
    expect(screen.getByText("PREFERENCIE")).toBeTruthy();
    expect(screen.getByText("ZÁKAZY")).toBeTruthy();
    expect(screen.getByText("ZACHOVAŤ")).toBeTruthy();
    expect(screen.getByText("NEISTÉ")).toBeTruthy();
    expect(screen.getByText("142 BPM")).toBeTruthy();
    expect(screen.getByText(/žiadne bicie/)).toBeTruthy();
  });

  it("session suggestion is a one-click fix chip that emits its patch", () => {
    const { onPatch } = renderBox("nejaký beat", {}, { bpm: "120" });
    const fix = screen.getByText(/tempo nebolo zadané/);
    expect(fix.textContent).toContain("+");
    fireEvent.click(fix.closest("button") as HTMLButtonElement);
    expect(onPatch).toHaveBeenCalledWith({ bpmRange: [116, 124] });
  });

  it("hard BPM chip is editable in place (fix without rewriting the prompt)", () => {
    const { onPatch } = renderBox("dark trap at 142", { bpmRange: [142, 142] });
    fireEvent.click(screen.getByText(/^142 BPM/));
    const input = document.querySelector(".brief-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "128" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPatch).toHaveBeenCalledWith({ bpmRange: [128, 128] });
  });

  it("invalid BPM edits are dropped silently", () => {
    const { onPatch } = renderBox("dark trap at 142", { bpmRange: [142, 142] });
    fireEvent.click(screen.getByText(/^142 BPM/));
    const input = document.querySelector(".brief-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("bars chip edits length in 16-step units", () => {
    const { onPatch } = renderBox("drill, 8 taktov, pri 142", { length: 128 });
    fireEvent.click(screen.getByText(/^8 taktov/));
    const input = document.querySelector(".brief-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPatch).toHaveBeenCalledWith({ length: 64 });
  });

  it("preserve chip × un-protects the role via unprotectRole", () => {
    const { onPatch } = renderBox("keep my bass, drums only", { preserve: ["bass"] });
    const unkeep = document.querySelector(".brief-unkeep") as HTMLButtonElement;
    expect(unkeep).toBeTruthy();
    fireEvent.click(unkeep);
    expect(onPatch).toHaveBeenCalledWith({ roles: ["drums", "bass"] });
  });
});
