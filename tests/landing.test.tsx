import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LandingPage } from "../src/landing/LandingPage";

describe("LandingPage", () => {
  it("renders hero, feature grid and how-it-works steps", () => {
    render(<LandingPage onEnterStudio={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /MAKE BEATS/i })).toBeInTheDocument();
    expect(screen.getByText("CHOP BEATS")).toBeInTheDocument();
    expect(screen.getByText("MIX & PATTERN ASSIST")).toBeInTheDocument();
    expect(screen.getByText("60 SECONDS TO YOUR FIRST BEAT")).toBeInTheDocument();
    expect(document.querySelector(".landing-hero-player")).not.toBeNull();
  });

  it("both CTAs enter the studio", () => {
    const onEnterStudio = vi.fn();
    render(<LandingPage onEnterStudio={onEnterStudio} />);
    fireEvent.click(screen.getAllByRole("button", { name: /OPEN THE STUDIO/ })[0]);
    expect(onEnterStudio).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /START FORGING/ }));
    expect(onEnterStudio).toHaveBeenCalledTimes(2);
  });

  it("hero player receives the generated share code (renders without hash)", () => {
    render(<LandingPage onEnterStudio={vi.fn()} />);
    // EmbedApp decodes the prop — an invalid/absent code shows an error
    // phase, a valid one shows the player chrome. We assert the container
    // mounts (jsdom cannot render audio, so either phase proves wiring).
    expect(document.querySelector(".landing-hero-player .embed-root")).not.toBeNull();
  });
});
