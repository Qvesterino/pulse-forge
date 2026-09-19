import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DownloadPage, RELEASES_URL } from "../src/download/DownloadPage";
import { LandingPage } from "../src/landing/LandingPage";

describe("DownloadPage", () => {
  it("renders the hero with the GitHub Releases download link", () => {
    render(<DownloadPage />);
    expect(screen.getByRole("heading", { name: /the whole studio/i })).toBeInTheDocument();
    const downloads = screen.getAllByRole("link", { name: /download for windows/i });
    expect(downloads.length).toBeGreaterThanOrEqual(2); // hero + CTA band
    for (const link of downloads) {
      expect(link).toHaveAttribute("href", RELEASES_URL);
    }
    expect(RELEASES_URL).toMatch(/\/releases\/latest$/); // never version-pinned
  });

  it("offers the web studio as the alternative path", () => {
    render(<DownloadPage />);
    expect(screen.getByRole("link", { name: /open the web studio/i })).toHaveAttribute("href", "/studio");
    expect(screen.getByRole("link", { name: /open the studio/i })).toBeInTheDocument();
  });

  it("covers the desktop-specific facts, install steps and honest notes", () => {
    render(<DownloadPage />);
    expect(screen.getByText("Same engine, zero compromise")).toBeInTheDocument();
    expect(screen.getByText("Updates itself")).toBeInTheDocument();
    expect(screen.getByText("100% offline, 100% local")).toBeInTheDocument();
    expect(screen.getByText("Hardware just works")).toBeInTheDocument();
    expect(screen.getByText("Sixty seconds to the studio")).toBeInTheDocument();
    expect(screen.getByText(/smartscreen may warn/i)).toBeInTheDocument();
    expect(screen.getByText(/portable build doesn't self-update/i)).toBeInTheDocument();
  });

  it("shows the release meta fallback until the GitHub API answers", () => {
    render(<DownloadPage />);
    // jsdom: the fetch either fails or is still in flight — the static
    // fallback line must be present either way.
    expect(screen.getByText(/latest build/i)).toBeInTheDocument();
  });

  it("renders the decorative waveform and marquee hidden from AT", () => {
    render(<DownloadPage />);
    expect(document.querySelector(".dl-wave")).not.toBeNull();
    const marquee = document.querySelector(".dl-marquee");
    expect(marquee).not.toBeNull();
    expect(marquee?.getAttribute("aria-hidden")).toBe("true");
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
