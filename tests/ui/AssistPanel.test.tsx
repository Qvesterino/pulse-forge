import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistPanel } from "../../src/ui/AssistPanel";
import { renderWithContext } from "../helpers";

describe("AssistPanel", () => {
  it("renders a deterministic preview selector and grid", async () => {
    const user = userEvent.setup();
    renderWithContext(<AssistPanel onClose={() => {}} />);

    expect(screen.getByRole("dialog", { name: "Pattern assist" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "vary pattern preview" })).toBeInTheDocument();
    await user.selectOptions(screen.getAllByRole("combobox")[0], "build");
    expect(screen.getByRole("img", { name: "build pattern preview" })).toBeInTheDocument();
  });

  it("applies through the command store", async () => {
    const user = userEvent.setup();
    const { services } = renderWithContext(<AssistPanel onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "VARY PATTERN" }));
    expect(services.store.execute).toHaveBeenCalledTimes(1);
  });
});
