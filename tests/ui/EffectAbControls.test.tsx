import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EffectAbControls } from "../../src/ui/EffectAbControls";

describe("EffectAbControls", () => {
  it("can select an empty slot before storing a second variation", () => {
    const onStateChange = vi.fn();
    const onLoad = vi.fn();
    const view = render(
      <EffectAbControls
        effectName="PRISM"
        params={{ bandCount: 4, "band1.gainDb": 0 }}
        onStateChange={onStateChange}
        onLoad={onLoad}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "B" }));

    expect(onLoad).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledWith({ slots: {}, active: "B" });
    view.rerender(
      <EffectAbControls
        effectName="PRISM"
        params={{ bandCount: 4, "band1.gainDb": 0 }}
        deviceState={{ kind: "effect-ab-v1", data: { slots: {}, active: "B" } }}
        onStateChange={onStateChange}
        onLoad={onLoad}
      />,
    );
    // CF-18: an empty active slot is ARMED, not a compare — the status names
    // the arm and the path out of it instead of a cryptic ACTIVE · EMPTY.
    expect(screen.getByRole("status")).toHaveTextContent("B ARMED · EMPTY");
    expect(screen.getByRole("status")).toHaveTextContent("STORE captures here");
    expect(screen.getByRole("status")).toHaveTextContent("recall needs a stored snapshot");
  });

  it("recalls a stored alternate through the load callback", () => {
    const onStateChange = vi.fn();
    const onLoad = vi.fn();
    render(
      <EffectAbControls
        effectName="DRIFT"
        params={{ "global.dryWet": 100 }}
        deviceState={{
          kind: "effect-ab-v1",
          data: { slots: { A: { "global.dryWet": 100 }, B: { "global.dryWet": 60 } }, active: "A" },
        }}
        onStateChange={onStateChange}
        onLoad={onLoad}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^B/ }));

    expect(onStateChange).not.toHaveBeenCalled();
    expect(onLoad).toHaveBeenCalledWith("B");
  });
});

describe("EffectAbControls — CF-18 empty-slot affordance", () => {
  it("NEGATIVE: a STORED active slot still reads ACTIVE · STORED (no armed wording)", () => {
    render(
      <EffectAbControls
        effectName="PRISM"
        params={{}}
        deviceState={{
          kind: "effect-ab-v1",
          data: { slots: { A: { "band1.gainDb": 3 } }, active: "A" },
        }}
        onStateChange={vi.fn()}
        onLoad={vi.fn()}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("A ACTIVE · STORED");
    expect(status.textContent).not.toContain("ARMED");
    expect(status.textContent).not.toContain("EMPTY");
  });

  it("the empty-slot button title explains the arm and the recall requirement", () => {
    render(<EffectAbControls effectName="PRISM" params={{}} onStateChange={vi.fn()} onLoad={vi.fn()} />);
    expect(screen.getByRole("button", { name: "B" }).getAttribute("title")).toContain("arms it for the next STORE");
    expect(screen.getByRole("button", { name: "B" }).getAttribute("title")).toContain("recall needs a stored snapshot");
  });
});
