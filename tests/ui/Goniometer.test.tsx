import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Goniometer } from "../../src/ui/Goniometer";
import { renderWithContext } from "../helpers";

describe("Goniometer", () => {
  function mockAnalyser() {
    const ctx = { sampleRate: 44100 } as unknown as AudioContext;
    return {
      fftSize: 2048,
      context: ctx,
      getByteTimeDomainData: vi.fn((arr: Uint8Array) => {
        arr.fill(128);
      }),
    } as unknown as AnalyserNode;
  }

  it("renders the goniometer canvas", () => {
    renderWithContext(<Goniometer analysers={{ l: mockAnalyser(), r: mockAnalyser() }} id="master" />);
    const canvas = screen.getByLabelText(/Stereo goniometer/i) as HTMLCanvasElement;
    expect(canvas).toBeInTheDocument();
    expect(canvas.tagName.toLowerCase()).toBe("canvas");
  });

  it("renders without analysers without throwing", () => {
    renderWithContext(<Goniometer analysers={null} id="master" />);
    expect(screen.getByLabelText(/Stereo goniometer/i)).toBeInTheDocument();
  });

  it("renders with a custom size prop", () => {
    renderWithContext(<Goniometer analysers={null} id="master" size={140} />);
    const canvas = screen.getByLabelText(/Stereo goniometer/i) as HTMLCanvasElement;
    expect(canvas).toBeInTheDocument();
    // width attribute is resolved * 2 in jsdom
    expect(canvas.getAttribute("width")).not.toBeNull();
  });
});
