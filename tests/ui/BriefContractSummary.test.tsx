import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BriefContractSummary } from "../../src/ui/BriefContractSummary";
import { compileBriefContract, type BriefContract } from "../../src/intent/brief-contract";
import { parseIntentText } from "../../src/intent/text-parser";
import { producerSessionState, resetProducerSession, recordDecision } from "../../src/intent/producer-session";
import type { IntentInput } from "../../src/intent/types";
import type { ProjectProducerBriefV1 } from "../../src/project-model/types";

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
  const contract: BriefContract = compileBriefContract(parseIntentText(text), {
    session: producerSessionState(),
    defaultRoles: ["drums", "bass"],
    corrections: fixes,
  });
  const input: IntentInput = { ...parseIntentText(text).input, ...fixes };
  const rendered = render(<BriefContractSummary contract={contract} input={input} fixes={fixes} onPatch={onPatch} />);
  return { onPatch, ...rendered };
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

  it("shows where each interpretation came from and whether it was parsed, inferred, or left unknown", () => {
    const { container } = renderBox("dark trap");
    const badges = Array.from(container.querySelectorAll<HTMLElement>(".brief-provenance"));

    expect(
      badges.some(
        (badge) =>
          badge.textContent === "zadanie · rozpoznané" &&
          badge.getAttribute("aria-label") === "Pôvod: zadanie; istota: rozpoznané",
      ),
    ).toBe(true);
    expect(
      badges.some(
        (badge) =>
          badge.dataset.origin === "default" &&
          badge.dataset.confidence === "unknown" &&
          badge.textContent === "predvolené · nezadané",
      ),
    ).toBe(true);
    expect(
      badges.some(
        (badge) =>
          badge.dataset.origin === "default" &&
          badge.dataset.confidence === "inferred" &&
          badge.textContent === "predvolené · odhad",
      ),
    ).toBe(true);
  });

  it("marks a session suggestion as an estimate and a correction as user-confirmed", () => {
    const session = renderBox("nejaký beat", {}, { bpm: "120" });
    expect(
      Array.from(session.container.querySelectorAll<HTMLElement>(".brief-provenance")).some(
        (badge) => badge.dataset.origin === "session" && badge.textContent === "session · odhad",
      ),
    ).toBe(true);

    const corrected = renderBox("dark trap at 142", { bpmRange: [128, 128] });
    expect(
      Array.from(corrected.container.querySelectorAll<HTMLElement>(".brief-provenance")).some(
        (badge) => badge.dataset.origin === "user" && badge.textContent === "tvoja oprava · potvrdené",
      ),
    ).toBe(true);
  });

  it("identifies inherited project facts separately from prompt facts", () => {
    const projectBrief: ProjectProducerBriefV1 = {
      version: 1,
      savedAt: "2026-10-02T12:00:00.000Z",
      facts: [{ field: "genre", section: "preference", value: "trap", origin: "user", confidence: "confirmed" }],
    };
    const parsed = parseIntentText("nejaký beat");
    const contract = compileBriefContract(parsed, { projectBrief });
    const rendered = render(
      <BriefContractSummary
        contract={contract}
        input={{ ...parsed.input, genre: "trap" }}
        fixes={{}}
        onPatch={vi.fn()}
      />,
    );
    const projectBadge = rendered.container.querySelector<HTMLElement>(
      '.brief-provenance[data-origin="project"][data-confidence="confirmed"]',
    );
    expect(projectBadge?.textContent).toBe("projekt · potvrdené");
    expect(projectBadge?.getAttribute("aria-label")).toBe("Pôvod: projekt; istota: potvrdené");
  });

  it("surfaces a saved preserve conflict before the creator can generate", () => {
    const projectBrief: ProjectProducerBriefV1 = {
      version: 1,
      savedAt: "2026-10-02T12:00:00.000Z",
      facts: [{ field: "preserve", section: "preserve", value: ["bass"], origin: "user", confidence: "confirmed" }],
    };
    const parsed = parseIntentText("add bass");
    const contract = compileBriefContract(parsed, { projectBrief });
    render(
      <BriefContractSummary
        contract={contract}
        input={{ ...parsed.input, preserve: ["bass"] }}
        fixes={{}}
        onPatch={vi.fn()}
      />,
    );

    const conflict = screen.getByRole("alert", { name: "Rozpory v zadaní" });
    expect(conflict).toHaveTextContent(/zachovať basu a zároveň pridať/i);
    expect(conflict).toHaveTextContent(/generovanie čaká/i);
  });

  it("shows an actionable warning for conflicting role instructions", () => {
    renderBox("no drums, add kick");
    const conflict = screen.getByLabelText("Rozpory v zadaní");
    expect(conflict).toHaveTextContent(/zákaz generovania bicích.*pridať/i);
    expect(conflict).toHaveTextContent(/generovanie čaká/i);
  });

  it("explains that a prohibited role conflicts with the requested scope", () => {
    renderBox("no bass, full beat");
    const conflict = screen.getByLabelText("Rozpory v zadaní");
    expect(conflict).toHaveTextContent(/zákaz generovania basy.*rozsah/i);
    expect(conflict).toHaveTextContent(/uprav konfliktné pokyny/i);
  });

  it("lets the producer correct generation roles without rewriting the prompt", () => {
    const { onPatch } = renderBox("dark trap");
    const chords = screen.getByRole("button", { name: "Generovať akordy" });
    expect(chords).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chords);
    expect(onPatch).toHaveBeenCalledWith({ roles: ["drums", "bass", "chords"] });
  });

  it("keeps prohibited and preserved roles unavailable in the generation controls", () => {
    const { onPatch } = renderBox("no bass, keep my kick");
    expect(screen.getByRole("button", { name: "Generovať basu" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Generovať bicie" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Generovať basu" })).toHaveAttribute("aria-pressed", "false");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("requires at least one generated role", () => {
    const { onPatch } = renderBox("melody only");
    const lead = screen.getByRole("button", { name: "Generovať lead" });
    expect(lead).toBeDisabled();
    expect(lead).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(lead);
    expect(onPatch).not.toHaveBeenCalled();
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

  it("shows the corrected value instead of the stale parsed BPM", () => {
    renderBox("dark trap at 142", { bpmRange: [128, 128] });
    expect(screen.getByText(/128 BPM/)).toBeTruthy();
    expect(screen.queryByText(/^142 BPM/)).toBeNull();
    expect(screen.getByText(/128 BPM/).closest("button")).toHaveClass("brief-fixed");
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
    expect(onPatch).toHaveBeenCalledWith({ roles: ["drums", "bass"], preserve: [] });
  });
});
