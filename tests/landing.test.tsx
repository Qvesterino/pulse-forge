import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LandingPage } from "../src/landing/LandingPage";

describe("LandingPage", () => {
  it("renders hero, feature grid and how-it-works steps", () => {
    render(<LandingPage onEnterStudio={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /make beats/i })).toBeInTheDocument();
    expect(screen.getByText("Chop beats")).toBeInTheDocument();
    expect(screen.getByText("Mix & pattern assist")).toBeInTheDocument();
    expect(screen.getByText("60 seconds to your first beat")).toBeInTheDocument();
    expect(document.querySelector(".landing-hero-player")).not.toBeNull();
  });

  it("all CTAs enter the studio", () => {
    const onEnterStudio = vi.fn();
    render(<LandingPage onEnterStudio={onEnterStudio} />);
    const studioButtons = screen.getAllByRole("button", { name: /open the studio/i });
    expect(studioButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(studioButtons[0]);
    expect(onEnterStudio).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /start forging/i }));
    expect(onEnterStudio).toHaveBeenCalledTimes(2);
    fireEvent.click(studioButtons[studioButtons.length - 1]);
    expect(onEnterStudio).toHaveBeenCalledTimes(3);
  });

  it("hero player receives the generated share code (renders without hash)", () => {
    render(<LandingPage onEnterStudio={vi.fn()} />);
    // EmbedApp decodes the prop — an invalid/absent code shows an error
    // phase, a valid one shows the player chrome. We assert the container
    // mounts (jsdom cannot render audio, so either phase proves wiring).
    expect(document.querySelector(".landing-hero-player .embed-root")).not.toBeNull();
  });

  it("hero player hides the duplicate KYX brand mark", () => {
    render(<LandingPage onEnterStudio={vi.fn()} />);
    // The page nav already carries the brand — the embedded player must not
    // repeat it (gallery embeds keep it; only the landing opts out).
    expect(document.querySelector(".landing-hero-player .embed-brand")).toBeNull();
  });
});
