/**
 * DiceTray surface contract — the tray must render on any project shape and
 * its keyboard surface must not collide with drum-pad performance keys.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { DiceTray } from "../../src/ui/DiceTray";
import { DiceProvider } from "../../src/ui/DiceContext";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { initPadKeys, setPadKeysArmed } from "../../src/ui/padKeys";

function renderTray(doc = createProjectFromTemplate("house")) {
  const services = mockServices(doc);
  const utils = renderWithContext(
    // active — the tray is visible in these tests, so the provider must run
    // its real preview pipeline (inactive = gated cheap placeholder).
    <DiceProvider doc={services.store.doc} active>
      <DiceTray />
    </DiceProvider>,
    { services },
  );
  return { ...utils, services };
}

describe("DiceTray", () => {
  it("renders on a project without a drum track instead of crashing", () => {
    // getDrumTrack throws when the project has no drum track — the tray used
    // to take the whole panel down during render. An empty project is a
    // legal state (and the GEN flow targets it).
    expect(() => renderTray(createProjectFromTemplate("empty"))).not.toThrow();
    expect(screen.getByRole("region", { name: /Dice/ })).toBeInTheDocument();
  });

  it("scopes the D hotkey to the tray and yields to armed pad keys", () => {
    initPadKeys();
    setPadKeysArmed(false);
    try {
      const { container } = renderTray();
      const rolls = () => container.querySelectorAll(".dice-history-dot").length;

      // With no drum rack armed, D rolls the dice (full) — the roll history
      // gains an entry.
      const before = rolls();
      fireEvent.keyDown(window, { key: "d" });
      expect(rolls()).toBeGreaterThan(before);

      // With the drum rack armed, "d" is a pad key (default binding) — the
      // roll must not fire.
      setPadKeysArmed(true);
      const afterRoll = rolls();
      fireEvent.keyDown(window, { key: "d" });
      expect(rolls()).toBe(afterRoll);
    } finally {
      setPadKeysArmed(false);
    }
  });
});
