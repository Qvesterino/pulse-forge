import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { renderWithContext } from "../helpers";

describe("SceneLauncher", () => {
  it("separates SELECT from LAUNCH", async () => {
    const { services } = renderWithContext(<ArrangementPanel />);
    const user = userEvent.setup();
    const select = screen.getAllByRole("button", { name: /Select scene/i })[0];
    await user.click(select);
    expect(services.playback.launchScene).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole("button", { name: /Launch scene/i })[0]);
    expect(services.playback.launchScene).toHaveBeenCalledTimes(1);
  });

  it("exposes independent pattern action for the selected scene", async () => {
    const { services } = renderWithContext(<ArrangementPanel />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "DUPLICATE PATTERN" }));
    expect(services.store.execute).toHaveBeenCalled();
  });
});
