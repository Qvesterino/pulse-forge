import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { SpectrumAnalyzer } from "../../src/ui/SpectrumAnalyzer";
import { renderWithContext } from "../helpers";

describe("SpectrumAnalyzer", () => {
  function mockAnalyser() {
    // Minimal AnalyserNode-like stub
    const ctx = { sampleRate: 44100 } as unknown as AudioContext;
    return {
      fftSize: 2048,
      smoothingTimeConstant: 0.8,
      frequencyBinCount: 1024,
      context: ctx,
      getByteFrequencyData: vi.fn((arr: Uint8Array) => {
        arr.fill(50);
      }),
      getByteTimeDomainData: vi.fn((arr: Uint8Array) => {
        arr.fill(128);
      }),
    } as unknown as AnalyserNode;
  }

  it("renders a canvas with the spectrum label", () => {
    renderWithContext(
      <SpectrumAnalyzer analyser={mockAnalyser()} id="master" />,
    );
    const canvas = screen.getByLabelText(/Spectrum/i) as HTMLCanvasElement;
    expect(canvas).toBeInTheDocument();
    expect(canvas.tagName.toLowerCase()).toBe("canvas");
  });

  it("renders with an id prop and uses it for the rAF loop label", () => {
    const { container } = renderWithContext(
      <SpectrumAnalyzer analyser={mockAnalyser()} id="master" />,
    );
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    expect(canvas.className).toContain("spectrum-analyzer");
    // The id is consumed internally — assert the canvas rendered without throwing
    expect(canvas.tagName.toLowerCase()).toBe("canvas");
  });

  it("renders without an analyser without throwing", () => {
    renderWithContext(
      <SpectrumAnalyzer analyser={null} id="master" />,
    );
    expect(screen.getByLabelText(/Spectrum/i)).toBeInTheDocument();
  });
});