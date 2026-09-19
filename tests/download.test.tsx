import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DownloadPage, RELEASES_URL } from "../src/download/DownloadPage";
import { LandingPage } from "../src/landing/LandingPage";

describe("DownloadPage", () => {
  it("renders the hero with the GitHub Releases download link", () => {
    render(<DownloadPage />);
    expect(screen.getByRole("heading", { name: /kyx on your desktop/i })).toBeInTheDocument();
    const download = screen.getByRole("link", { name: /download for windows/i });
    expect(download).toHaveAttribute("href", RELEASES_URL);
    expect(RELEASES_URL).toMatch(/\/releases\/latest$/); // never version-pinned
  });

  it("offers the web studio as the alternative path", () => {
    render(<DownloadPage />);
    expect(screen.getByRole("link", { name: /open the web studio instead/i })).toHaveAttribute("href", "/studio");
    expect(screen.getByRole("link", { name: /open the studio/i })).toBeInTheDocument();
  });

  it("covers the desktop-specific facts and the unsigned-build note", () => {
    render(<DownloadPage />);
    expect(screen.getByText("Same engine, no browser")).toBeInTheDocument();
    expect(screen.getByText("Updates itself")).toBeInTheDocument();
    expect(screen.getByText("Projects stay on your disk")).toBeInTheDocument();
    expect(screen.getByText(/smartscreen may ask/i)).toBeInTheDocument();
  });
});

describe("landing → download wiring", () => {
  it("links to /download from the nav and the hero hint", () => {
    render(<LandingPage onEnterStudio={vi.fn()} />);
    const links = screen.getAllByRole("link", { name: /download/i });
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/download");
    }
  });
});
