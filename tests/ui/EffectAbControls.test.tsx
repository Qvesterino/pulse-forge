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
    expect(screen.getByRole("status")).toHaveTextContent("B ACTIVE · EMPTY");
  });

  it("recalls a stored alternate through the load callback", () => {
    const onStateChange = vi.fn();
    const onLoad = vi.fn();
    render(
      <EffectAbControls
        effectName="VØID"
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
