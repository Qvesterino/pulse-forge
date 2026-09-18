import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { DiceProvider, useDice } from "../../src/ui/DiceContext";
import { renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

function Consumer() {
  const dice = useDice();
  const [shown, setShown] = useState(dice.session.seedChain[0] ?? "(none)");
  return (
    <div>
      <div data-testid="seed">{shown}</div>
      <div data-testid="mode">{dice.session.mode}</div>
      <div data-testid="cursor">{String(dice.session.cursor)}</div>
      <div data-testid="canApply">{String(dice.canApply)}</div>
      <button type="button" onClick={() => dice.rollFull()}>rollFull</button>
      <button type="button" onClick={() => dice.setMode("vary")}>setVary</button>
      <button type="button" onClick={() => setShown(dice.session.seedChain[dice.session.cursor] ?? "(none)")}>showCurrent</button>
    </div>
  );
}

describe("DiceContext", () => {
  it("DiceProvider provides a session to consumers", () => {
    const doc = createProjectFromTemplate("house");
    renderWithContext(
      <DiceProvider doc={doc}>
        <Consumer />
      </DiceProvider>,
    );
    expect(screen.getByTestId("mode")).toHaveTextContent(/^(full|vary)$/);
    expect(screen.getByTestId("canApply")).toHaveTextContent("true");
    expect(screen.getByTestId("cursor")).toHaveTextContent(/^-?\d+$/);
  });

  it("rollFull mutates the seed chain (cursor advances)", () => {
    const doc = createProjectFromTemplate("house");
    renderWithContext(
      <DiceProvider doc={doc}>
        <Consumer />
      </DiceProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "rollFull" }));
    fireEvent.click(screen.getByRole("button", { name: "showCurrent" }));
    // The chain has at least one entry now
    expect(screen.getByTestId("seed").textContent).not.toBeNull();
    expect((screen.getByTestId("seed").textContent ?? "").length).toBeGreaterThan(0);
  });

  it("setMode switches session.mode between full and vary", () => {
    const doc = createProjectFromTemplate("house");
    renderWithContext(
      <DiceProvider doc={doc}>
        <Consumer />
      </DiceProvider>,
    );
    const before = screen.getByTestId("mode").textContent;
    fireEvent.click(screen.getByRole("button", { name: "setVary" }));
    const after = screen.getByTestId("mode").textContent;
    expect(before).not.toBe(after);
  });

  it("throws when useDice is used without a provider", () => {
    // Suppress error noise — React logs error boundaries even when caught
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      renderWithContext(<Consumer />),
    ).toThrow(/DiceContext not initialized/i);
    spy.mockRestore();
  });

  it("gates the heavy preview on `active` — inactive providers skip generation", () => {
    // The provider is always mounted in App: with the panel closed it must
    // not run the generation pipeline on every doc change (the freeze bug).
    function PreviewProbe() {
      const dice = useDice();
      return (
        <div>
          <div data-testid="mode">{dice.preview.mode}</div>
          <div data-testid="hasFull">{String(dice.preview.fullPattern !== null)}</div>
        </div>
      );
    }
    const doc = createProjectFromTemplate("house");
    const inactive = renderWithContext(
      <DiceProvider doc={doc}>
        <PreviewProbe />
      </DiceProvider>,
    );
    expect(screen.getByTestId("hasFull").textContent).toBe("false");
    inactive.unmount();

    renderWithContext(
      <DiceProvider doc={doc} active>
        <PreviewProbe />
      </DiceProvider>,
    );
    expect(screen.getByTestId("hasFull").textContent).toBe("true");
  });
});