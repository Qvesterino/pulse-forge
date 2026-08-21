import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Meter } from "../../src/ui/Meter";
import { ServicesContext } from "../../src/ui/context";
import { mockServices } from "../helpers";

describe("Meter", () => {
  it("renders with meter role", () => {
    const services = mockServices();
    render(
      <ServicesContext.Provider value={services}>
        <Meter engine={services.engine} kind="track" id="t1" />
      </ServicesContext.Provider>,
    );
    expect(screen.getByRole("meter")).toBeInTheDocument();
  });

  it("has correct aria attributes", () => {
    const services = mockServices();
    render(
      <ServicesContext.Provider value={services}>
        <Meter engine={services.engine} kind="track" id="t1" />
      </ServicesContext.Provider>,
    );
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-label", "Level meter");
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
  });

  it("renders fill bar with initial height 0%", () => {
    const services = mockServices();
    render(
      <ServicesContext.Provider value={services}>
        <Meter engine={services.engine} kind="track" id="t1" />
      </ServicesContext.Provider>,
    );
    const fill = screen.getByRole("meter").querySelector(".meter-fill");
    expect(fill).toHaveStyle({ height: "0%" });
  });
});
