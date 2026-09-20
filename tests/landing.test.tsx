import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LandingPage } from "../src/landing/LandingPage";

describe("LandingPage", () => {
  it("renders hero, feature grid and how-it-works steps", () => {
    render(<LandingPage onEnterStudio={vi.fn()} />);
    // Viral growth plan A1: the hero now SELLS the intent engine — the
    // describe → hear → own promise replaces the DAW-feature pitch.
    expect(screen.getByRole("heading", { level: 1, name: /describe it/i })).toBeInTheDocument();
    expect(screen.getByText("Chop beats")).toBeInTheDocument();
    expect(screen.getByText("Type a beat into existence")).toBeInTheDocument();
    expect(screen.getByText("30 seconds to your first beat")).toBeInTheDocument();
    expect(document.querySelector(".landing-prompt")).not.toBeNull();
  });

  it("all CTAs enter the studio", () => {
    const onEnterStudio = vi.fn();
    render(<LandingPage onEnterStudio={onEnterStudio} />);
    const studioButtons = screen.getAllByRole("button", { name: /open the studio/i });
    expect(studioButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(studioButtons[0]);
    expect(onEnterStudio).toHaveBeenCalledTimes(1);
    fireEvent.click(studioButtons[studioButtons.length - 1]);
    expect(onEnterStudio).toHaveBeenCalledTimes(2);
  });

  it("prompt box offers chips and a forge action; demo player renders before first forge", () => {
    render(<LandingPage onEnterStudio={vi.fn()} />);
    // jsdom cannot render audio — either EmbedApp phase proves the wiring.
    expect(document.querySelector(".landing-prompt .landing-hero-player .embed-root")).not.toBeNull();
    expect(document.querySelector(".landing-prompt .embed-brand")).toBeNull();
    // Genre chips fill the input (one click to a working prompt).
    const input = screen.getByLabelText(/describe the beat you want/i) as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "dark trap 140" }));
    expect(input.value).toBe("dark trap 140");
    expect(screen.getByRole("button", { name: /forge it/i })).not.toBeDisabled();
  });

  it("empty prompt keeps the forge action disabled", () => {
    render(<LandingPage onEnterStudio={vi.fn()} />);
    expect(screen.getByRole("button", { name: /forge it/i })).toBeDisabled();
  });
});
